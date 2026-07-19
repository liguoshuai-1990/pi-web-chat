// app.js — front-end logic for pi-web-chat
// Connects to the WebSocket, renders streaming responses,
// manages the session sidebar, and the composer.

const API = ""; // same origin
const state = {
  ws: null,
  wsConnected: false,
  cwd: null,
  currentSessionFile: null,
  // entriesByCallId: for live assistant messages we accumulate tool calls + text
  streamingMsg: null,   // DOM node for the in-progress assistant message
  streamingText: "",    // accumulated text deltas
  streamingThinking: "",
  activeToolCalls: new Map(), // toolCallId -> { node, body, state }
  thinkingOpen: false,
  queuedAssistantTextId: null,
  streaming: false,
  models: [],
  currentModel: null,
  thinkingLevel: "medium",
  sessionId: null,
};

// ---- Markdown render (small, safe renderer) ----
function escapeHtml(s) {
  return s.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">");
}

function renderMarkdown(md) {
  // Strip headings of # etc. and convert to proper elements with escaping.
  // We do a fenced-code-first approach so we don't process markdown inside code.
  const parts = [];
  let rest = md;
  while (rest.length) {
    const fenceIdx = rest.search(/```/);
    if (fenceIdx === -1) {
      parts.push({ kind: "md", text: rest });
      rest = "";
    } else {
      if (fenceIdx > 0) parts.push({ kind: "md", text: rest.slice(0, fenceIdx) });
      rest = rest.slice(fenceIdx + 3);
      // optional language on this line
      const nl = rest.indexOf("\n");
      let lang = "";
      if (nl !== -1) {
        const firstLine = rest.slice(0, nl).trim();
        if (firstLine && !firstLine.includes("```")) lang = firstLine;
        rest = rest.slice(nl + 1);
      }
      const closeIdx = rest.indexOf("```");
      let code;
      if (closeIdx === -1) { code = rest; rest = ""; }
      else { code = rest.slice(0, closeIdx); rest = rest.slice(closeIdx + 3).replace(/^\n/, ""); }
      parts.push({ kind: "code", lang, code });
    }
  }
  let html = "";
  for (const p of parts) {
    if (p.kind === "code") {
      html += `<pre><code data-lang="${escapeHtml(p.lang)}">${escapeHtml(p.code)}</code></pre>`;
    } else {
      html += renderInlineMd(p.text);
    }
  }
  return html;
}

function renderInlineMd(text) {
  // tables, then markdown-ish transforms. Escape first.
  // Split out inline code first using placeholders to protect them.
  const codeChunks = [];
  let t = text.replace(/`([^`\n]+)`/g, (m) => {
    const i = codeChunks.length;
    codeChunks.push(m);
    return `\u0000CODE${i}\u0000`;
  });

  // Tables: a block of consecutive lines delimited by blank lines,
  // where the second line is like |---|---|.
  const lines = t.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].includes("|") && i + 1 < lines.length && /^\s*\|?[\s\-:|]+\|?\s*$/.test(lines[i + 1]) && lines[i+1].includes("-")) {
      // collect table block
      const header = lines[i];
      let rows = [];
      let j = i;
      out.push({ kind: "blockskip", range: [i, j] });
      const tblLines = [header, lines[i + 1]];
      j = i + 2;
      while (j < lines.length && lines[j].includes("|")) { tblLines.push(lines[j]); j++; }
      out.push({ kind: "table", lines: tblLines });
      i = j;
      continue;
    }
    out.push({ kind: "line", text: lines[i] });
    i++;
  }
  let outHtml = "";
  let para = [];
  function flushPara() {
    if (para.length === 0) return;
    const block = para.join("\n").trim();
    para = [];
    outHtml += "<p>" + mdInlineBlock(block) + "</p>";
  }
  for (const seg of out) {
    if (seg.kind === "table") {
      flushPara();
      outHtml += mdTable(seg.lines);
    } else if (seg.kind === "line") {
      // headings
      const m = seg.text.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        flushPara();
        const level = m[1].length;
        outHtml += `<h${level}>${mdInlineBlock(m[2])}</h${level}>`;
      } else if (/^\s*$/.test(seg.text)) {
        flushPara();
      } else if (/^>\s?/.test(seg.text)) {
        // blockquote line — group simple consecutive ones
        flushPara();
        outHtml += `<blockquote>${mdInlineBlock(seg.text.replace(/^>\s?/, ""))}</blockquote>`;
      } else if (/^\s*[-*]\s+/.test(seg.text) || /^\s*\d+\.\s+/.test(seg.text)) {
        // list item — group consecutive into ul/ol
        // simple inline handling: wrap each list item line.
        const isOrdered = /^\s*\d+\.\s+/.test(seg.text);
        if (!out.linkListOpen || out.linkListOrdered !== isOrdered) {
          flushPara();
          if (out.linkListOpen) outHtml += out.linkListOpen === "ol" ? "</ol>" : "</ul>";
          out.linkListOpen = isOrdered ? "ol" : "ul";
          out.linkListOrdered = isOrdered;
          outHtml += "<" + out.linkListOpen + ">";
        }
        outHtml += `<li>${mdInlineBlock(seg.text.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`;
      } else {
        if (out.linkListOpen) { outHtml += out.linkListOpen === "ol" ? "</ol>" : "</ul>"; out.linkListOpen = null; }
        para.push(seg.text);
      }
    }
  }
  if (out.linkListOpen) { outHtml += out.linkListOpen === "ol" ? "</ol>" : "</ul>"; out.linkListOpen = null; }
  flushPara();
  // restore inline code
  outHtml = outHtml.replace(/\u0000CODE(\d+)\u0000/g, (_, n) => `<code>${escapeHtml(codeChunks[+n].slice(1, -1))}</code>`);
  return outHtml;
}

// helper state bag attached to the function during line scan
function mdInlineBlock(text) {
  function esc(s) { return escapeHtml(s); }
  let s = escapeHtml(text);
  // bold
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  // italic
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_]+)_/g, "$1<em>$2</em>");
  // links [txt](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

function mdTable(lines) {
  const parseRow = (l) => l.split("|").map(c => c.trim()).filter((_, i, arr) => !(i === 0 && arr[0] === "") && !(i === arr.length - 1 && arr[arr.length - 1] === ""));
  const header = parseRow(lines[0]);
  const body = lines.slice(2).filter(l => l.trim()).map(parseRow);
  let h = '<table><thead><tr>';
  header.forEach((c) => h += `<th>${mdInlineBlock(c)}</th>`);
  h += '</tr></thead><tbody>';
  body.forEach((r) => {
    h += '<tr>';
    r.forEach((c) => h += `<td>${mdInlineBlock(c)}</td>`);
    h += '</tr>';
  });
  h += '</tbody></table>';
  return h;
}

// ---- DOM helpers ----
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(n.dataset, v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    if (typeof c === "string") n.appendChild(document.createTextNode(c));
    else n.appendChild(c);
  }
  return n;
};

// ---- Sidebar / sessions ----
async function refreshSessions() {
  const cwd = state.cwd || "";
  const res = await fetch(`${API}/api/sessions?cwd=${encodeURIComponent(cwd)}`);
  const data = await res.json();
  renderSidebar(data.sessions || []);
}

function renderSidebar(sessions) {
  const list = $("#sessionList");
  list.innerHTML = "";
  if (sessions.length === 0) {
    list.appendChild(el("div", { class: "sidebar-empty", text: "没有会话记录" }));
    return;
  }
  sessions.forEach((s) => {
    const title = s.firstUser || "新对话";
    const when = s.timestamp ? new Date(s.timestamp).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    const item = el("div", {
      class: "session-item" + (s.file === state.currentSessionFile ? " active" : ""),
      onclick: () => loadSession(s.file),
    }, [
      el("span", { class: "dot", text: "●" }),
      el("div", { class: "title" }, [
        el("div", { text: title }),
        el("div", { class: "meta", text: `${when} · ${s.messageCount || 0} 条` }),
      ]),
    ]);
    list.appendChild(item);
  });
}

async function loadSession(file) {
  state.currentSessionFile = file;
  // pull transcript from REST then connect a fresh WS pointed at this session
  const res = await fetch(`${API}/api/session?file=${encodeURIComponent(file)}`);
  const data = await res.json();
  clearChat();
  document.querySelector("#emptyState").style.display = "none";
  const chat = $("#chat-inner");
  // Walk through path entries to render messages in order.
  // We reconstruct assistant/user/toolResult blocks.
  const msgs = reconstructFromEntries(data.entries || []);
  for (const m of msgs) {
    appendMessageNode(m.role, m);
  }
  // Reconnect websocket pointed at this session so new prompts continue history.
  connectWs({ session: file });
  // Update sidebar active highlight
  refreshSessions();
}

function reconstructFromEntries(entries) {
  // entries contains message + message_summary + model_change etc., in path order.
  const out = [];
  for (const e of entries) {
    if (e.type !== "message") continue;
    const m = e.message;
    if (!m || m.role === "bashExecution") continue;
    if (m.role === "user") {
      // skip "bash execution" pseudo-users (those have role user but content type special)
      out.push({ role: "user", text: extractContentText(m.content), ts: m.timestamp });
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content: m.content, ts: m.timestamp, usage: m.usage });
    } else if (m.role === "toolResult") {
      out.push({ role: "toolResult", toolCallId: m.toolCallId, toolName: m.toolName, content: m.content, isError: m.isError, ts: m.timestamp });
    }
  }
  return out;
}

function extractContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(c => c.type === "text" || typeof c === "string")
    .map(c => typeof c === "string" ? c : c.text)
    .join("");
}

// ---- Chat rendering ----
function clearChat() {
  const chatInner = $("#chat-inner");
  chatInner.innerHTML = "";
  state.streamingMsg = null;
  state.streamingText = "";
  state.streamingThinking = "";
  state.activeToolCalls.clear();
}

function showEmptyState(show) {
  document.querySelector("#emptyState").style.display = show ? "flex" : "none";
}

function appendMessageNode(role, m) {
  if (role === "user") {
    const node = el("div", { class: "msg user" }, [
      el("div", { class: "bubble", text: m.text }),
    ]);
    $("#chat-inner").appendChild(node);
    scrollBottom();
    return node;
  }
  return renderAssistantBlock(m);
}

function renderAssistantBlock(m) {
  // m.content is array of {type:text|thinking|toolCall}
  const node = el("div", { class: "msg assistant" }, [
    el("div", { class: "role-tag", text: "pi" }),
    el("div", { class: "content" }),
  ]);
  const content = node.querySelector(".content");
  const parts = Array.isArray(m.content) ? m.content : (m.content ? [{ type: "text", text: String(m.content) }] : []);
  for (let i = 0; i < parts.length; i++) {
    const c = parts[i];
    if (c.type === "text") {
      const div = el("div", { html: renderMarkdown(c.text) });
      content.appendChild(div);
    } else if (c.type === "thinking") {
      content.appendChild(makeThinkingBlock(c.thinking));
    } else if (c.type === "toolCall") {
      content.appendChild(makeToolBlockFromCall(c));
    }
  }
  // If this message is followed (in same assistant message) by a toolResult,
  // we don't have it here — toolResults come as separate messages in pi.
  $("#chat-inner").appendChild(node);
  scrollBottom();
  return node;
}

function makeThinkingBlock(thinkingText) {
  const block = el("div", { class: "thinking-block" });
  const head = el("div", { class: "thinking-head", onclick: () => body.style.display = body.style.display === "none" ? "block" : "none" }, [
    el("span", { text: "💭 思考过程" }),
    el("span", { text: "(点击展开/收起)" }),
  ]);
  const body = el("div", { class: "thinking-body", html: escapeHtml(thinkingText) });
  body.style.display = "none";
  block.appendChild(head);
  block.appendChild(body);
  return block;
}

function makeToolBlockFromCall(call) {
  const block = el("div", { class: "tool-block" });
  const head = el("div", { class: "tool-head" }, [
    el("span", { class: "ic", text: "⚙" }),
    el("span", { class: "name", text: call.name }),
    el("span", { class: "args", text: summaryArgs(call.name, call.arguments) }),
    el("span", { class: "state", text: "…" }),
  ]);
  const body = el("div", { class: "tool-body", html: "执行中…" });
  body.style.display = "none";
  head.addEventListener("click", () => body.style.display = body.style.display === "none" ? "block" : "none");
  block.appendChild(head);
  block.appendChild(body);
  block._head = head;
  block._body = body;
  block._callId = call.id;
  state.activeToolCalls.set(call.id, { block, body, head });
  return block;
}

function summaryArgs(name, args) {
  if (!args) return "";
  try {
    if (name === "bash" && args.command) return args.command;
    if (name === "read" && args.path) return args.path;
    if (name === "write" && args.path) return args.path;
    if (name === "edit" && args.path) return args.path;
    if (name === "ls" && args.path) return args.path;
    if (name === "grep") return args.pattern || "";
    if (name === "find") return args.pattern || args.path || "";
    return "";
  } catch { return ""; }
}

function scrollBottom() {
  const chat = $("#chat");
  chat.scrollTop = chat.scrollHeight;
}

// ---- Streaming: handle live assistant message ----
function ensureStreamingMsg() {
  if (state.streamingMsg) return state.streamingMsg;
  showEmptyState(false);
  const node = el("div", { class: "msg assistant" }, [
    el("div", { class: "role-tag", text: "pi" }),
    el("div", { class: "content" }),
  ]);
  state.streamingMsg = node;
  state.streamingText = "";
  state.streamingThinking = "";
  state.activeToolCalls.clear();
  $("#chat-inner").appendChild(node);
  scrollBottom();
  return node;
}

function refreshStreamingContent() {
  const node = state.streamingMsg;
  if (!node) return;
  const content = node.querySelector(".content");
  // Build the current content html again from scratch.
  // Order: text then thinking then tool calls. We keep it simple — append in
  // arrival order using permanent child slots keyed by index.
  // Easiest: rebuild.
  content.innerHTML = "";
  if (state.streamingThinking) {
    content.appendChild(makeThinkingBlock(state.streamingThinking));
  }
  if (state.streamingText) {
    content.appendChild(el("div", { html: renderMarkdown(state.streamingText) + (state.streaming ? '<span class="typing-cursor"></span>' : "") }));
  }
  // Re-append tool call blocks. Active ones are kept in a Map by insertion order.
  for (const v of state.activeToolCalls.values()) {
    content.appendChild(v.block);
  }
  scrollBottom();
}

function finalizeStreamingMsg() {
  state.streamingMsg = null;
  state.streamingText = "";
  state.streamingThinking = "";
  state.activeToolCalls.clear();
}

// ---- WebSocket ----
function connectWs(opts = {}) {
  if (state.ws) {
    try { state.ws.onclose = null; state.ws.close(); } catch {}
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const cwd = encodeURIComponent(state.cwd || "");
  const sess = opts.session ? `&session=${encodeURIComponent(opts.session)}` : "";
  const url = `${proto}://${location.host}/ws?cwd=${cwd}${sess}`;
  const ws = new WebSocket(url);
  state.ws = ws;
  ws.onopen = () => { state.wsConnected = true; $("#connDot").style.color = "var(--accent)"; $("#connDot").title = "已连接"; };
  ws.onclose = () => { state.wsConnected = false; $("#connDot").style.color = "var(--danger)"; $("#connDot").title = "已断开"; };
  ws.onmessage = (ev) => {
    let obj;
    try { obj = JSON.parse(ev.data); } catch { return; }
    handlePiMessage(obj);
  };
}

function sendWs(obj) {
  if (!state.ws || state.ws.readyState !== 1) return;
  state.ws.send(JSON.stringify(obj));
}

function handlePiMessage(obj) {
  // Responses to commands we issued (get_state etc.) come back with success+data.
  if (obj.type === "response") {
    if (obj.command === "get_state" && obj.success) updateState(obj.data);
    else if (obj.command === "get_available_models" && obj.success) updateModels(obj.data.models || []);
    else if (obj.command === "switch_session" && obj.success) {
      // ask pi for current state so we can get session id, name
      sendWs({ type: "get_state" });
      // List entries to render history. For "open" we already rendered from REST.
      // But for in-session edits later, entries may have arrived — call again.
      sendWs({ type: "get_entries" });
    } else if (obj.command === "get_entries" && obj.success) {
      handleEntries(obj.data.entries || [], obj.data.leafId);
    } else if (obj.command === "new_session" && obj.success) {
      state.currentSessionFile = null;
      clearChat();
      showEmptyState(true);
      sendWs({ type: "get_state" });
      refreshSessions();
    }
    return;
  }
  // Events from pi.
  switch (obj.type) {
    case "agent_start":
      state.streaming = true;
      setComposerAborting(true);
      break;
    case "agent_end":
      finalizeStreamingMsg();
      break;
    case "agent_settled":
      state.streaming = false;
      setComposerAborting(false);
      refreshSessions(); // titles may have changed
      break;
    case "message_start":
      ensureStreamingMsg();
      break;
    case "message_end":
      // After per-message teardown; keep streamingMsg until agent_end in case
      // of more turns. We clear text/thinking already.
      break;
    case "message_update": {
      const ev = obj.assistantMessageEvent;
      if (!ev) break;
      if (ev.type === "text_delta") {
        state.streamingText += ev.delta;
        refreshStreamingContent();
      } else if (ev.type === "thinking_delta" || ev.type === "thinking_start" || ev.type === "thinking_end") {
        // For thinking we accumulate deltas; thinking_delta carries .delta
        if (ev.type === "thinking_delta") {
          state.streamingThinking += ev.delta || "";
        }
        refreshStreamingContent();
      } else if (ev.type === "toolcall_start") {
        ensureStreamingMsg();
        const call = ev.toolCall || { id: obj.toolCallId, name: obj.toolName, arguments: obj.args };
        const block = makeToolBlockFromCall(call);
        // insert by rebuilding content
        refreshStreamingContent();
      } else if (ev.type === "toolcall_end") {
        // already added on _start
      }
      break;
    }
    case "tool_execution_start":
      ensureStreamingMsg();
      ensureToolBlock(obj.toolCallId, obj.toolName, obj.args);
      break;
    case "tool_execution_update": {
      const tc = state.activeToolCalls.get(obj.toolCallId);
      if (tc) {
        const pr = obj.partialResult;
        const text = pr && pr.content ? (Array.isArray(pr.content) ? pr.content.map(c => c.text || "").join("") : "") : "";
        tc.body.innerHTML = escapeHtml(text) || "(执行中…)";
      }
      break;
    }
    case "tool_execution_end": {
      const tc = state.activeToolCalls.get(obj.toolCallId);
      if (tc) {
        const res = obj.result;
        const text = res && res.content ? (Array.isArray(res.content) ? res.content.map(c => c.text || "").join("") : "") : "";
        tc.body.innerHTML = escapeHtml(text) || "(无输出)";
        tc.head.querySelector(".state").textContent = obj.isError ? "错误" : "完成";
        tc.head.querySelector(".state").classList.toggle("error", !!obj.isError);
      }
      break;
    }
    case "pi_exit":
      state.streaming = false;
      setComposerAborting(false);
      $("#connDot").style.color = "var(--danger)";
      break;
    default:
      // ignore unknown events
      break;
  }
}

function ensureToolBlock(toolCallId, name, args) {
  if (state.activeToolCalls.has(toolCallId)) return state.activeToolCalls.get(toolCallId);
  makeToolBlockFromCall({ id: toolCallId, name, arguments: args });
  refreshStreamingContent();
  return state.activeToolCalls.get(toolCallId);
}

// We render incoming session entries (for live new messages we use streaming
// events instead). get_entries is used after switch_session to render the
// canonical view. But to keep this simple we render history via REST /api/session
// and treat live events as the source of truth during a session.
function handleEntries(entries, leafId) { /* no-op: history rendered via REST */ }

function updateState(d) {
  if (d?.sessionFile) state.currentSessionFile = d.sessionFile;
  if (d?.sessionId) state.sessionId = d.sessionId;
  if (d?.model) { state.currentModel = d.model; renderModelPill(); }
  if (d?.thinkingLevel) state.thinkingLevel = d.thinkingLevel;
  $("#topSessionName").textContent = d?.sessionName || (d?.sessionFile ? baseName(d.sessionFile) : "新对话");
}

function updateModels(models) {
  state.models = models;
  renderModelMenu();
}

function renderModelPill() {
  const m = state.currentModel;
  const pill = $("#modelPill");
  if (!m) { pill.textContent = "选择模型"; return; }
  const provider = m.provider || "?";
  pill.textContent = `${provider} / ${m.id || m.name}`;
}

function renderModelMenu() {
  const menu = $("#modelMenu");
  menu.innerHTML = "";
  // group by provider
  const groups = {};
  for (const m of state.models) {
    const p = m.provider || "other";
    (groups[p] = groups[p] || []).push(m);
  }
  for (const [provider, items] of Object.entries(groups).sort()) {
    menu.appendChild(el("div", { class: "group-label", text: provider }));
    for (const m of items) {
      const active = state.currentModel && m.id === state.currentModel.id && m.provider === state.currentModel.provider;
      menu.appendChild(el("div", {
        class: "opt" + (active ? " active" : ""),
        onclick: () => { sendWs({ type: "set_model", provider: m.provider, modelId: m.id }); menu.classList.remove("open"); },
      }, [
        el("span", { class: "check", html: active ? "✓ " : "" }),
        document.createTextNode(`${m.name || m.id}`),
      ]));
    }
  }
}

function baseName(p) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

// ---- Composer ----
function setComposerAborting(yes) {
  const btn = $("#sendBtn");
  if (yes) {
    btn.classList.add("stop");
    btn.disabled = false;
    btn.textContent = "■";
  } else {
    btn.classList.remove("stop");
    btn.disabled = false;
    btn.textContent = "↑";
  }
}

function submitPrompt() {
  const ta = $("#composer");
  const text = ta.value.trim();
  if (!text || !state.wsConnected) return;
  if (state.streaming) {
    // If streaming, treat a click as "stop"
    sendWs({ type: "abort" });
    return;
  }
  // Render the user's message locally for instant feedback.
  appendMessageNode("user", { text });
  ta.value = "";
  autoResize();
  // Optionally set the session name from the first prompt.
  if (state.currentSessionFile == null) {
    // pick a short title from the first message
    sendWs({ type: "set_session_name", name: text.slice(0, 60).replace(/\s+/g, " ") });
  }
  sendWs({ type: "prompt", message: text });
}

function autoResize() {
  const ta = $("#composer");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
}

// ---- Init ----
function init() {
  // Default cwd to home (server uses home default too).
  state.cwd = document.body.dataset.cwd || "";

  // event listeners
  $("#btnNew").addEventListener("click", () => {
    if (state.streaming) {
      if (!confirm("正在生成中，新建会话会终止当前操作，确定吗？")) return;
      sendWs({ type: "abort" });
    }
    clearChat();
    showEmptyState(true);
    connectWs({}); // no session -> pi creates a new one
    $("#topSessionName").textContent = "新对话";
    state.currentSessionFile = null;
  });

  $("#sendBtn").addEventListener("click", submitPrompt);
  const ta = $("#composer");
  ta.addEventListener("input", autoResize);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitPrompt();
    }
  });

  // model pill / menu
  $("#modelPill").addEventListener("click", (e) => {
    e.stopPropagation();
    sendWs({ type: "get_available_models" });
    $("#modelMenu").classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#modelMenu") && !e.target.closest("#modelPill")) {
      $("#modelMenu").classList.remove("open");
    }
  });

  // suggestions
  document.querySelectorAll(".suggestions .chip").forEach((c) => {
    c.addEventListener("click", () => {
      $("#composer").value = c.dataset.prompt || c.textContent;
      autoResize();
      submitPrompt();
    });
  });

  // sidebar search (client side filter)
  $("#sidebarSearch").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll(".session-item").forEach((it) => {
      it.style.display = it.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  });

  refreshSessions();
  connectWs({});
  showEmptyState(true);
  // pull current state once:
  setTimeout(() => sendWs({ type: "get_state" }), 300);
}

document.addEventListener("DOMContentLoaded", init);
