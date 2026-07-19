# 架构设计文档

> pi-web-chat 的技术架构、数据流、关键设计决策、扩展点说明。

---

## 1. 高层架构

```
┌─────────────┐           WebSocket (JSONL)           ┌────────────────┐
│  Browser    │ ◄────────────────────────────────────► │  Node server   │
│  (React-    │        /ws?cwd=...&session=...         │  server.js     │
│   like SPA) │                                        │                │
└─────────────┘                                        └───────┬────────┘
                                                                  │
                                              spawn child_process  │
                                                                  ▼
                                                         ┌────────────────┐
                                                         │  pi --mode rpc │
                                                         │  (子进程)       │
                                                         │  stdin/stdout  │
                                                         │  JSONL         │
                                                         └────────┬───────┘
                                                                  │
                                                 ┌─────────────────┼─────────────────┐
                                                 ▼                 ▼                 ▼
                                        ~/.pi/agent/sessions/  ~/.pi/agent/      配置/扩展/
                                        --home-zrlgs--/        extensions/       skills/
                                                │
                                                ▼
                                        *.jsonl (append-only tree)
```

**核心原则**：
- **每个浏览器连接 = 1 个 pi RPC 子进程**。互不共享状态，天然隔离。
- **会话文件** 是唯一的持久化真相，前端 & 子进程都只读/写它。
- **Node 服务端只做三件事**：静态托管、REST 历史读取、WebSocket↔子进程 JSONL 转发。

---

## 2. 关键数据流

### 2.1 打开已有会话（历史恢复）

```
Browser                    server.js (REST)               pi RPC (not involved)
  │                             │
  ├─ GET /api/session?file=X ──►│
  │◄─── { header, entries[] }───┤
  │                             │
  ├─ render history from entries
  │
  ├─ WS /ws?cwd=...&session=file=X
  │──────────────────────────────►│ spawn pi --mode rpc
  │                               ├─► switch_session {sessionPath: X}
  │                               │◄─ response ok
  │                               │◄─ events (get_state, etc.)
  │◄─── history already rendered
```

### 2.2 新建会话 + 首条消息

```
Browser                    server.js                        pi RPC
  │                             │                              │
  ├─ WS /ws?cwd=... (no session)│ spawn pi --mode rpc          │
  │                             │◄─ pi creates new session     │
  │◄─── ws open, conn=green     │                              │
  │                             │                              │
  ├─ sendWs({prompt: "hi"})────►│─────────────────────────────►│
  │                             │                              ├─ LLM call
  │                             │                              ├─ stream events
  │◄─── message_update/text_delta (stream)                    │
  │◄─── agent_settled            │                              │
  │                             │◄─ session file written       │
  ├─ refreshSessions() ────────►│ (GET /api/sessions 会拿到新标题)
```

### 2.3 发送消息（流式）

```
Browser                              server.js (转发)        pi RPC
  │                                     │                      │
  ├─ sendWs({type: "prompt", ...})─────►│─────────────────────►│
  │                                     │                      ├─ agent_start
  │◄─── message_update {text_delta}────►│◄─────────────────────┤
  │    (累积 state.streamingText,      │                      ├─ tool calls...
  │     反复 refreshStreamingContent)  │                      │
  │◄─── agent_settled                  │◄─────────────────────┤
  │                                     │                      ├─ session 文件 append
```

---

## 3. 关键模块职责

### 3.1 `server.js` (≈ 320 行)

| 部分 | 负责 |
|------|------|
| `PiAgent` class | 管理单个 `pi --mode rpc` 子进程：stdin 写命令、stdout 按行解析 JSON、把 response/event 全部转发给对应 ws |
| `app.get('/api/sessions')` | 扫描 `~/.pi/agent/sessions/**/*.jsonl`，读 header 做 cwd 精准过滤，返回标题/时间/消息数 |
| `app.get('/api/session')` | 读单个 jsonl，按 `parentId` 重建 root→leaf 路径（即对话线） |
| `WebSocketServer` | 每连接创建一个 `PiAgent`，URL 参数 `cwd`、`session` 决定子进程的工作目录与要加载的会话 |

**无状态**：server.js **不持有任何会话状态**，全在 jsonl 文件里。

### 3.2 `public/app.js` (≈ 800 行)

| 模块 | 功能 |
|------|------|
| `state` | 单例状态机：`wsConnected`、`streaming`、`streamingText`、`activeToolCalls`、`models`、`currentSessionFile` 等 |
| `connectWs(opts)` | 生命周期管理：关旧、新建、注册 onopen/onmessage/onclose、代次标记 `wsGen` |
| `handlePiMessage(obj)` | 核心分发器：把 pi 的 16 种事件类型映射到 UI 更新 |
| `ensureStreamingMsg / refreshStreamingContent` | 增量式重绘正在流式的 assistant 消息（文本、thinking、tool blocks） |
| `renderMarkdown / renderInlineMd` | 自研轻量 MD 渲染（fenced code → 先抠出、其余 escape → 再转行内语法） |
| `appendMessageNode / renderAssistantBlock` | 静态历史消息一次性渲染 |
| `refreshSessions()` | 拉取 `/api/sessions` 重绘左侧列表 |
| `loadSession(file)` | 拉取 `/api/session` 渲染历史 + `connectWs({session: file})` 续写 |

### 3.3 `public/style.css` (≈ 350 行)

- CSS Variables 定色（深色主题）
- Flex/Grid 布局：左 260px 侧边栏 + 右侧自适应
- 滚动条美化、折叠块动画、打字光标动画
- 响应式预留（当前仅桌面）

---

## 4. 关键设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| RPC 模式 vs SDK | **RPC (`pi --mode rpc`)** | 进程隔离、无需编译 TS、pi 升级自动兼容、多语言客户端通用 |
| 子进程管理 | **每 ws 一个子进程** | 简单、天然隔离、状态不共享、符合 pi 设计（每会话一个进程） |
| 历史存储 | **复用 pi 的 jsonl** | 零迁移成本、终端与网页同源、tree 结构天然支持分支 |
| WebSocket 协议 | **直接透传 pi JSONL** | 不做二次封装，前端直接处理 pi 原生事件，版本兼容性最强 |
| 前端框架 | **原生 JS + 单文件** | 体积 < 30 KB、无构建步骤、部署即 `node server.js`、易改易读 |
| Markdown 渲染 | **自研 escape-first** | 0 依赖、XSS 安全、够用即可（代码块、表格、列表、标题、引用） |
| 连接状态机 | **显式 `wsGen` 代次** | 解决重连/切换会话时旧消息污染新上下文的竞态 |

---

## 5. 扩展点

| 扩展需求 | 怎么做 |
|----------|--------|
| **图片上传** | 前端 `input type=file` → base64 → `sendWs({type:"prompt", message, images:[{data,mimeType}]})`；pi 原生支持 |
| **多项目 / cwd 切换** | 顶栏加下拉，`connectWs({cwd: newPath})`，同时刷新侧边栏（`/api/sessions?cwd=`） |
| **Fork / Tree 浏览** | pi RPC 有 `fork`/`get_tree`/`get_fork_messages`，前端加一个模态框或侧边栏 tab |
| **主题切换** | CSS Variables 已就绪，加个 toggle 写 `localStorage.theme` 并在 `<html>` 加 `data-theme` |
| **鉴权** | 反向代理层加 Basic Auth / OAuth2 Proxy，或 server.js 接入 `express-session` |
| **Docker 部署** | `Dockerfile` 基于 node:alpine，把 `~/.pi` 挂载为 volume，暴露 3000 |
| **双端实时同步** | server.js 持有唯一 `PiAgent`，终端侧也连同一 ws（需改造 pi 或用 tmux 转发） |
| **插件/技能 UI** | pi 的 extension UI 协议在 RPC 里已有 `extension_ui_request/response`，前端加个通用 dialog 容器即可 |

---

## 6. 部署清单

| 项 | 推荐 |
|----|------|
| Node | ≥ 18 (原生 fetch、ESM) |
| pi | 全局安装并已 `/login` 过至少一个 provider |
| 环境变量 | `PORT=3000`、`PI_BIN` (可选)、`PI_SESSIONS_DIR` (可选) |
| 反向代理 | Nginx/Caddy 负责 TLS + 静态缓存 + WebSocket 升级 |
| 进程守护 | systemd / PM2 / Docker restart=always |

---

## 7. 目录速览

```
pi-web-chat/
├── server.js              # Express + ws + child_process 桥接
├── package.json           # deps: express, ws
├── README.md
├── CHANGELOG.md
├── ISSUES.md
├── ARCHITECTURE.md        # 本文件
└── public/
    ├── index.html         # 单页骨架
    ├── style.css          # 变量 + 布局 + 组件样式
    └── app.js             # 状态机 + 渲染 + WS 交互
```

---

## 8. 测试/调试技巧

```bash
# 1. 直接跑 server，看 stdout
node server.js

# 2. 仅测 REST（不启 ws）
curl "http://localhost:3000/api/sessions?cwd=/home/you"
curl "http://localhost:3000/api/session?file=/home/you/.pi/agent/sessions/--home-you--/xxx.jsonl"

# 3. 手工 ws 调试（见 repro.mjs 模式）
#    用 node 连 ws://localhost:3000/ws?cwd=... 发 JSON，观察返回
```

---

## 9. 常见问题 FAQ

| 问题 | 答案 |
|------|------|
| 为什么不用 pi 的 SDK？ | SDK 要求同进程、TS 编译、版本强绑定。RPC 模式零依赖、进程隔离、任意语言。 |
| 会话文件会不会冲突？ | pi 的 jsonl 是 **append-only tree**，同一时刻只有一个进程写同一个文件（我们保证每浏览器 tab 一个子进程、不并发写同一文件）。若真并发写，pi 内部有文件锁。 |
| 如何支持多用户？ | 目前单用户。多用户需：①鉴权 ②把 `~/.pi/agent/sessions/` 按用户隔离 ③server.js 维护用户→子进程池映射。 |
| 为什么不把思考过程单独存？ | pi 已在 jsonl 里把 `thinking` 作为 `assistantMessageEvent.thinking_delta` 流下来，前端直接渲染，无需额外存储。 |
| 怎么升级 pi？ | `npm i -g @earendil-works/pi-coding-agent` 重启 server.js 即可，子进程会自动用新版。 |