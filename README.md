# pi-web-chat

一个 [pi](https://pi.dev) 编程代理的 Web 界面，风格参考 ChatGPT / Gemini ——
左侧历史会话侧边栏 + 右侧对话区 + 底部输入框。底层通过 pi 的 **RPC 模式**
(`pi --mode rpc`) 与 pi 子进程通信，前端走 WebSocket 流式渲染。

## 功能

- 💬 流式对话 —— 文本逐字流式渲染，带打字光标
- 🗂️ 会话历史 —— 自动读取 ~/.pi/agent/sessions/ 下所有历史会话
- 🆕 新建会话 / 切换会话 —— 通过左侧栏点击或生成中新建
- ⚙️ 工具调用折叠块 —— bash / read / write / edit 等以可折叠卡片显示，实时输出
- 💭 思考过程折叠块 —— 模型 thinking 以独立可折叠卡片显示
- 🧩 模型切换 —— 顶栏模型 pill，覆盖所有 pi 已配置的模型
- ⏹️ 中止生成 —— 生成中点击发送按钮即可中断
- ⌨️ Markdown 渲染 —— 代码块、表格、列表、链接、引用、标题
- 🖥️ 工作目录 —— 每个 ws 连接绑定一个 cwd (默认 ~)

## 使用

```
cd pi-web-chat
npm install
npm start            # → http://localhost:3000
```

环境变量：

| 变量                  | 默认值                       | 说明                       |
| -------------------- | ------------------------- | ------------------------ |
| PORT                 | 3000                      | 监听端口                     |
| PI_BIN               | 自动探测 (~/.npm-global/bin/pi) | 显式指定 pi 可执行文件路径   |
| PI_SESSIONS_DIR      | ~/.pi/agent/sessions      | pi 的 session 存储目录     |

## 架构

```
 浏览器 ──WebSocket(/ws?cwd=...)──► Node server.js ──stdin/stdout(JSONL)──► pi --mode rpc
                                  (一个 ws 连接 spawn 一个 pi 子进程)
                                  │
                                  ├──REST /api/sessions──直读 JSONL 列历史
                                  └──REST /api/session?file=...─重建根→叶路径
```

## 已知限制

- 仅展示同一 cwd 下的会话 (默认 ~)。
- 图片上传未接 (协议支持 images，前端未做 UI)。
- 不支持 fork/clone/tree (RPC 支持，UI 可后续扩展)。
- 无鉴权，仅用于本地单用户开发。

## License

MIT
