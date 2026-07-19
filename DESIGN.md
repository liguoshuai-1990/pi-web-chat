# 设计文档

## 目标

把 pi（终端编码代理）包成一个**类 ChatGPT 的 Web 界面**，让用户能：

- 在浏览器里跟 pi 对话，享受流式输出、Markdown 渲染、工具可视化
- 跟终端共享会话历史（一份存储、两端可见）
- 不依赖 pi 自身 TUI，不必懂 RPC 协议

非目标：

- 多人协作 / 并发共享 session
- 全功能 UI（fork / tree 浏览 / 配置）
- 重度前端工程化（保持单页、零构建）

---

## 核心架构

### 进程模型：一个 ws 连接 = 一个 pi RPC 子进程

```
Browser ──WebSocket── server.js ──stdio (JSONL)── pi (rpc mode)
```

为什么这样：

1. **隔离**：每个浏览器连接独立、互不干扰
2. **标准化**：复用 pi 官方 RPC 协议（已在 `/docs/rpc.md` 中完整文档化）
3. **可重启**：用户点「新建会话」或刷新页面都可安全关掉旧进程、起新的

权衡：

- 每次新会话/刷新会 `spawn` 一个新 pi 进程→冷启动约 1-2 s
- 不能跨页面共享内存（session 都靠文件和 RPC 协议持久化）

### 持久化：复用 pi 的 JSONL 文件

pi 自己把 session 存在 `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl`。
**不另立数据库**，避免和 pi 终端/TUI 数据分离。

- 历史侧边栏：`server.js` 直接扫 JSONL 文件、按 header 的 `cwd` 字段过滤
- 进入历史：`server.js` 用 parentId 链从「叶子节点」反向走到根，构造完整对话线
- 写回：完全交给 pi 子进程管，我们只做 stdin/stdout 转发

### 前端：原生 JS，零构建

- 单 `index.html`、`app.js`、`style.css`，**无 React/Vue/打包器**
- 渲染逻辑用手写 `--appendChild` + 简单 markdown 渲染器
- 状态量小（一个 `state` 对象就够），不需要框架

原因：

- 避免不必要的工具链
- 让项目对"想动手改 UI"的人友好 = 改完直接 `npm start` 看
- 单文件 ~30KB 完全可维护

---

## 数据流（一次完整对话）

```
1. 浏览器 ws open → server.js spawn `pi --mode rpc --session-dir …`
2. → 浏览器发 JSON {"type":"prompt", "message":"..."} 走 ws
3. → server.js 写到 pi 的 stdin（加 id 字段做相关）
4. → pi 处理、往 stdout 写事件流：agent_start / message_start /
       message_update (text_delta / toolcall_start / …) / message_end / agent_end
5. → server.js 读 stdout、按 LF 拆分、JSON.parse、对响应按 id 回复浏览器
       事件无 id，直接转发回 ws
6. → 浏览器 handlePiMessage 更新 DOM（流式打字光标、工具折叠块、thinking 块 …）
7. → agent_settled 触发 side refreshSession()
```

### 消息事件 → DOM 的映射

| pi 事件              | 前端动作                                        |
| ------------------ | ------------------------------------------ |
| `agent_start`      | 锁住发送按钮（变停止按钮），标志进入流式状态                  |
| `message_start`    | 在 #chat-inner 末尾创建一个新的 `msg.assistant` 节点 |
| `message_update` / `text_delta` | 累加到 `state.streamingText`、立即重渲染  |
| `message_update` / `thinking_delta` | 累加到 `state.streamingThinking` |
| `message_update` / `toolcall_start` | 创建工具块、可折叠、实时刷新             |
| `tool_execution_start/update/end` | 更新工具块的状态/输出                    |
| `agent_end`        | 清掉流式状态（但保留节点作为最终历史）                  |
| `agent_settled`    | 取消锁、解锁发送按钮、刷新侧边栏                     |

---

## 关键设计决策

### 1. 渲染策略：流式重建 vs 增量 DOM

流式输出时，理论上可以**只追加纯文本节点**比 markdown 重渲染快。

但因为模型输出可能包含：

- 思考块 → 工具折叠块 → 文本块的**交错顺序**
- Late-arriving 工具调用更新（参数补全、abort 等）

→ 选择**每个 update 重建内容容器**（约 30 行以下可接受）。模型最长输出也只 ~16KB，markdown 渲染 < 5ms。

### 2. WebSocket 代次（wsGen）

浏览器在 1 秒内切换 ws 时，老 ws 在关闭握手完成前可能仍在发消息。
如果把这些消息误派发到新会话，会：

- 误把 `state.streaming = true` 写到错误会话
- 让新会话的 prompt 被当成"停止"动作
- 历史侧边栏状不一致

修复：每个 ws 分配单调递增的 `_gen` 序号，处理消息前检查当前代次。**这是 web socket 客户端常见反模式，明文记下来省的再踩。**

### 3. Markdown 渲染器：自己写

用的产品只需要：

- 围栏代码块 \`\`\`…\`\`\`
- 内联代码 \`…\`
- 标题、列表、引用、表格、链接、加粗、斜体

→ 写一个 ~150 行纯函 md→HTML，已覆盖 95% 真实使用（已用 trae / GPT 实战测试）。

**注意：先 escape HTML 再做 markdown 转换**。**反之会被 XSS 注入。**代码这块是手审计过的。

### 4. 每个会话绑定 cwd

URL 携带 `?cwd=<绝对路径>` → server.js 拿这个参数启动 pi。会话列表按 cwd 过滤。

现在做了单 cwd，默认 `~`，多 cwd 在 router 层还简单。

### 5. 如何选择"新会话"还是"恢复"？

简单二分：

- `ws://...?session=...` → 提示 pi 加载该 JSONL（switch_session）
- `ws://...?session=无`      → pi 见没有 session → 自动开新会

后端在 session load 成功后，会令浏览器调用 `get_state` 以同步状态。

---

## 已知技术债

低级 / 不影响功能的可能性 | 描述 | 以后怎么做
--- | --- | ---
图片上传未接        | pi 接受 `images` 变体屏可以看到，UI 未做     | 加个 📎 按钮、手动转 base64 封装
fork/tree/clone browsing 未接 | 都用 RPC 协议可以做，面并右侧徒增全本 | 加个 tree view (右栏可隐藏)
多 cwd 未做项目切换 | 现在单 cwd                       | 加顶栏的"项目列表 + 切换器"
深浅主题切换未做    | 现在仅深色                        | CSS 已用变量，换变量集即可
实时双进程同步未做   | 终端与浏览器同时跑、不能同步看到对方  | 共享单进程模型 + 多 ws 转发，需重设计
鉴权未做           | 仅适用本地单人开发                 | 反向代理 + OAuth / basic auth

---

## 未来可做

- 在后端提供**多项目器**多 cwd 访问，UI 加 dropdown
- 提供一个 **Observability** 面板：usage / ctx / 快捷 model comparison
- 添加**会话导出**：1 键 export markdown（现在 pi 自己提供 /export，只差个 UI）
- 可选 **wq****tpi 镜像**（隔离 prompt / context）用于 different roles

---

## 参考资料

- [pi.dev](https://pi.dev)
- pi 官方文档（仓库内 `docs/sdk.md` / `docs/rpc.md` / `docs/session-format.md`）
- pi 官方仓库：[earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)
