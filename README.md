# pi-web-chat

一个 [pi](https://pi.dev) 编程代理的 Web 界面，风格参考 ChatGPT / Gemini ——
左侧历史会话侧边栏 + 右侧对话区 + 底部输入框。底层通过 pi 的 **RPC 模式**
(`pi --mode rpc`) 与 pi 子进程通信，前端走 WebSocket 流式渲染。

> 项目主页：https://github.com/liguoshuai-1990/pi-web-chat

---

## 📸 功能

- 💬 **流式对话** —— 文本逐字流式渲染，带打字光标
- 🗂️ **会话历史** —— 自动读取 `~/.pi/agent/sessions/` 下所有历史会话，按首条用户消息做标题
- 🆕 **新建 / 切换会话** —— 通过左侧栏点击或生成中新建
- ⚙️ **工具调用折叠块** —— bash / read / write / edit 等以可折叠卡片显示，实时输出
- 💭 **思考过程折叠块** —— 模型 thinking 以独立可折叠卡片显示
- 🧩 **模型切换** —— 顶栏模型 pill，覆盖所有 pi 已配置的模型
- ⏹️ **中止生成** —— 生成中点击发送按钮即可中断
- ⌨️ **Markdown 渲染** —— 代码块、表格、列表、链接、引用、标题
- 🖥️ **工作目录绑定** —— 每个 ws 连接由 cwd 决定会话范围（默认 `~`）

---

## 🚀 快速开始

```bash
cd pi-web-chat
npm install

# 确保 pi 已安装并已配置好至少一个 provider/model：
#   pi         （交互模式 → 运行 /login 选择 provider，或设置 API key）
npm start
# → http://localhost:3000
```

### 环境变量

| 变量                  | 默认值                                     | 说明                          |
| -------------------- | --------------------------------------- | --------------------------- |
| `PORT`               | `3000`                                  | Web 服务监听端口                    |
| `PI_BIN`             | 自动探测（`~/.npm-global/bin/pi` 等）             | 显式指定 pi 可执行文件路径                |
| `PI_SESSIONS_DIR`    | `~/.pi/agent/sessions`                  | pi 的 session 存储目录           |

---

## 📁 项目结构

```
pi-web-chat/
├── README.md                       本文件
├── DESIGN.md                       设计文档（架构、数据流、决策）
├── ISSUES.md                       历次问题排查与修复
├── CHANGELOG.md                    版本变更日志
├── package.json
├── package-lock.json
├── server.js                       Express + WebSocket，桥接 pi RPC
├── .gitignore
└── public/
    ├── index.html                  单页 UI
    ├── app.js                      前端逻辑
    └── style.css                   ChatGPT/Gemini 风格样式
```

---

## 🏗️ 架构

```
 浏览器 ──WebSocket(/ws?cwd=...&session=...)──► Node server.js ──stdin/stdout(JSONL)──► pi --mode rpc
                                             (一个 ws 连接 spawn 一个 pi 子进程)
                                             │
                                             ├──REST /api/sessions ──► 直读 JSONL 列历史
                                             └──REST /api/session?file=... ─► 重建根→叶路径
```

---

## 📝 License

MIT

---

## 🛠️ Systemd 服务（可选）

若希望开机自启、后台常驻、重启自愈，可安装为 user-level systemd 服务（无需 sudo）：

```bash
# 从项目根目录运行
./scripts/install-service.sh 3000

# 或自定义端口（默认 3000）：
./scripts/install-service.sh 8080
```

脚本会：
1. 在 `~/.config/systemd/user/pi-web-chat.service` 生成 unit
2. `systemctl --user daemon-reload && systemctl --user enable --now pi-web-chat`
3. 设置 `Restart=on-failure` 自动重启

查看状态 / 日志：
```bash
systemctl --user status pi-web-chat
journalctl --user -u pi-web-chat -f
```

> ⚠️ **Linger**：systemd user 服务默认随登录会话结束。若需 **开机自启 / 登出后继续跑**，需一次性启用：
> ```bash
> sudo loginctl enable-linger $USER
> ```

卸载：
```bash
systemctl --user disable --now pi-web-chat
rm ~/.config/systemd/user/pi-web-chat.service
systemctl --user daemon-reload
```
