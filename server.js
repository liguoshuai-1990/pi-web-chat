// server.js — pi-web-chat backend
// Bridges a browser WebSocket to a `pi --mode rpc` subprocess, and REST APIs
// for listing sessions and reading session history from the JSONL store.
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import express from "express";
import { WebSocketServer } from "ws";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve pi binary: prefer PI_BIN env, else search PATH, else fall back to ~/.npm-global/bin/pi
function resolvePiBin() {
  if (process.env.PI_BIN && existsSync(process.env.PI_BIN)) return process.env.PI_BIN;
  const home = os.homedir();
  const candidates = [
    path.join(home, ".npm-global/bin/pi"),
    "/usr/local/bin/pi",
    "/usr/bin/pi",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return "pi"; // hope it's on PATH of the spawned shell
}
const PI_BIN = resolvePiBin();
// Where pi stores sessions, organized by cwd-encoded subdirectory.
const SESSIONS_DIR = process.env.PI_SESSIONS_DIR || path.join(home(), ".pi", "agent", "sessions");
const PORT = process.env.PORT || 3000;

// One pi RPC process per browser WebSocket connection.
class PiAgent {
  constructor(ws, cwd) {
    this.ws = ws;
    this.cwd = cwd || home();
    this.reqId = 0;
    this.pending = new Map();      // reqId -> resolve()
    this.proc = null;
    this.buffer = "";
    this.alive = false;
  }

  start() {
    const args = [PI_BIN, "--mode", "rpc", "--session-dir", SESSIONS_DIR];
    this.proc = spawn(args[0], args.slice(1), {
      cwd: this.cwd,
      env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
    });
    this.alive = true;
    this.proc.stdout.on("data", (d) => this.onStdout(d));
    this.proc.stderr.on("data", (d) => {
      process.stderr.write(`[pi stderr] ${d}`);
    });
    this.proc.on("exit", (code) => {
      this.alive = false;
      console.log(`pi exited (code=${code})`);
      this.wsSend({ type: "pi_exit", code });
      try { this.ws.close(); } catch {}
    });
  }

  onStdout(chunk) {
    this.buffer += chunk.toString("utf8");
    while (true) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) break;
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      this.onPiMessage(obj);
    }
  }

  onPiMessage(obj) {
    // RPC responses carry `id`; events do not.
    if (obj.type === "response" && obj.id) {
      const res = this.pending.get(obj.id);
      if (res) { this.pending.delete(obj.id); res(obj); }
    }
    // Forward every event / response to the browser as-is.
    this.wsSend(obj);
  }

  send(cmd) {
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new Error("pi process not alive"));
      const id = String(++this.reqId);
      const payload = { ...cmd, id };
      this.pending.set(id, resolve);
      this.proc.stdin.write(JSON.stringify(payload) + "\n");
      // Safety: timeout so a dropped response doesn't leak the promise.
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ type: "response", id, success: false, error: "timeout" });
        }
      }, 60000);
    });
  }

  sendNoReply(cmd) {
    if (!this.alive) throw new Error("pi process not alive");
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
  }

  wsSend(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  stop() {
    this.alive = false;
    try { this.proc && this.proc.kill("SIGTERM"); } catch {}
  }
}

// ---- REST: list sessions + read one session's messages ----
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Scan ALL subdirectories of SESSIONS_DIR rather than guessing the folder
// name pi encodes for a given cwd. Each session file's header carries its
// real `cwd`, so we read headers and group/return by cwd.
async function listAllSessionFiles() {
  if (!existsSync(SESSIONS_DIR)) return [];
  const files = [];
  const subdirs = (await readdir(SESSIONS_DIR, { withFileTypes: true }))
    .filter(d => d.isDirectory());
  for (const d of subdirs) {
    const dp = path.join(SESSIONS_DIR, d.name);
    const names = (await readdir(dp)).filter(f => f.endsWith(".jsonl"));
    for (const n of names) files.push(path.join(dp, n));
  }
  return files;
}

app.get("/api/sessions", async (req, res) => {
  try {
    const cwd = req.query.cwd || home();
    const all = await listAllSessionFiles();
    const sessions = [];
    for (const full of all) {
      try {
        const content = await readFile(full, "utf8");
        const lines = content.split("\n").filter(Boolean);
        let header = null, title = null, msgCount = 0;
        for (const line of lines) {
          let o;
          try { o = JSON.parse(line); } catch { continue; }
          if (o.type === "session") header = o;
          if (o.type === "message" && o.message && o.message.role === "user" && !title) {
            title = extractText(o.message.content).slice(0, 80);
          }
          if (o.type === "message") msgCount++;
        }
        if (!header || header.cwd !== cwd) continue;
        sessions.push({
          file: full,
          name: path.basename(full),
          id: header.id,
          timestamp: header.timestamp,
          firstUser: title,
          messageCount: msgCount,
        });
      } catch {}
    }
    sessions.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
    res.json({ cwd, sessions });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(c => c.type === "text" || typeof c === "string")
    .map(c => typeof c === "string" ? c : c.text)
    .join("");
}

// Return a session as a linear chat transcript (walking the parent chain to the leaf).
app.get("/api/session", async (req, res) => {
  try {
    const file = req.query.file;
    if (!file || !file.endsWith(".jsonl")) return res.status(400).json({ error: "bad file" });
    const content = await readFile(file, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const entries = [];
    let header = null;
    for (const line of lines) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === "session") header = o;
      entries.push(o);
    }
    // Build a map and reconstruct the active path from root -> leaf.
    const byId = new Map();
    for (const e of entries) if (e.id) byId.set(e.id, e);
    let leaf = null;
    for (const e of entries) {
      // a leaf is one that nobody else has as parentId (and isn't a non-message like header)
      if (e.type === "message" || e.type === "message_summary") leaf = e.id;
    }
    // find true leaf = last entry with no children
    const childCount = new Map();
    for (const e of entries) {
      if (e.parentId) childCount.set(e.parentId, (childCount.get(e.parentId) || 0) + 1);
    }
    let leafId = null;
    for (const e of entries) {
      if (e.id && !childCount.has(e.id)) leafId = e.id;
    }
    // Walk parent chain from leaf to root.
    const path = [];
    let cur = leafId;
    const guard = new Set();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      const e = byId.get(cur);
      if (!e) break;
      path.unshift(e);
      cur = e.parentId;
    }
    res.json({ header, entries: path });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// ---- WebSocket: 1 browser conn = 1 pi RPC conn ----
const httpServer = app.listen(PORT, () => {
  console.log(`pi-web-chat on http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const cwd = url.searchParams.get("cwd") || home();
  const session = url.searchParams.get("session") || null;
  const agent = new PiAgent(ws, cwd);
  agent.start();
  ws.piAgent = agent;
  console.log(`ws connected (cwd=${cwd}, session=${session || "new"})`);

  // Open a specific session, or start fresh.
  if (session) agent.sendNoReply({ type: "switch_session", sessionPath: session });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case "prompt":
        agent.send({ type: "prompt", message: msg.message, images: msg.images });
        break;
      case "abort":
        agent.sendNoReply({ type: "abort" });
        break;
      case "new_session":
        agent.send({ type: "new_session" });
        break;
      case "switch_session":
        agent.send({ type: "switch_session", sessionPath: msg.sessionPath });
        break;
      case "steer":
        agent.send({ type: "steer", message: msg.message });
        break;
      case "set_session_name":
        agent.send({ type: "set_session_name", name: msg.name });
        break;
      case "get_entries":
        agent.send({ type: "get_entries", since: msg.since });
        break;
      case "get_state":
        agent.send({ type: "get_state" });
        break;
      case "get_available_models":
        agent.send({ type: "get_available_models" });
        break;
      case "set_model":
        agent.send({ type: "set_model", provider: msg.provider, modelId: msg.modelId });
        break;
      default:
        // Unknown — just forward, might be a raw RPC command.
        agent.send(msg);
    }
  });

  ws.on("close", () => {
    console.log("ws closed, stopping pi");
    agent.stop();
  });
  ws.on("error", () => agent.stop());
});

function home() { return os.homedir(); }
