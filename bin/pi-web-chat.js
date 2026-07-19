#!/usr/bin/env node
// pi-web-chat CLI entry point
// Usage: pi-web-chat [--port=3000] [--cwd=/path] [--help]

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const SERVER = resolve(ROOT, "server.js");

function printHelp() {
  console.log(`
pi-web-chat — Web UI for pi coding agent (RPC mode)

Usage:
  pi-web-chat [options]

Options:
  -p, --port <number>    Port to listen on (default: 3000, env PORT)
  -c, --cwd <path>       Working directory for pi sessions (default: $HOME)
  -h, --help             Show this help

Environment:
  PORT              Same as --port
  PI_BIN            Path to pi binary (auto-detected if not set)
  PI_SESSIONS_DIR   Pi session storage directory (default: ~/.pi/agent/sessions)

Examples:
  pi-web-chat
  pi-web-chat --port 8080
  PORT=4000 pi-web-chat
`);
}

function parseArgs(argv) {
  const opts = { port: process.env.PORT || 3000, cwd: process.env.HOME };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
    if (a === "-p" || a === "--port") opts.port = Number(argv[++i]);
    else if (a.startsWith("--port=")) opts.port = Number(a.split("=")[1]);
    else if (a === "-c" || a === "--cwd") opts.cwd = argv[++i];
    else if (a.startsWith("--cwd=")) opts.cwd = a.split("=")[1];
    else { console.error(`Unknown option: ${a}`); printHelp(); process.exit(1); }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// Spawn server.js as a child so we can forward signals cleanly.
const child = spawn("node", [SERVER], {
  cwd: opts.cwd,
  env: { ...process.env, PORT: String(opts.port) },
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (e) => { console.error(e); process.exit(1); });

// Forward signals.
["SIGINT", "SIGTERM", "SIGHUP"].forEach((sig) => {
  process.on(sig, () => child.kill(sig));
});