# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- 会话切换时右侧完整历史恢复（通过 REST `/api/session` 重建 parent 链）
- 模型切换器（顶栏 pill，支持所有 pi 配置的模型）
- Tool-call 折叠块（实时输出、可展开/折叠）
- Thinking 折叠块
- 发送按钮双态（发送/停止）+ 红色停止态

### Fixed
- WebSocket 代次竞态（旧 socket 残留消息污染新会话）
- 侧边栏 cwd 编码错误（改用读 header 过滤）
- 连接状态文字永远不更新
- 新会话后侧边栏不刷新
- ws 未连时发送静默丢弃
- Markdown XSS 风险（先 escape 再渲染）

### Changed
- 侧边栏会话项去除无意义的 `●` 圆点，改为 tooltip 显示完整 jsonl 路径
- 发送按钮禁用逻辑：仅在 wsConnected=false 时禁用，而非 streaming 时

---

## [0.2.0] - 2026-07-19

### Added
- **新建会话流程修复**：`btnNew` 点击后刷新侧边栏、清理流式状态、生成新 ws 代次
- **WebSocket 代次机制**：`wsGen` 防止旧 socket 消息污染新上下文
- **输入框红边提示**：ws 未连时提交会有 350ms 红色 flash
- **连接状态文本动态更新**：「连接中…」→「已连接」/「已断开」
- **提交**：`5a8f036` "Fix new-session flow: ws generation guard + sidebar refresh + drop input"

### Fixed
- 新建会话后左侧不出现（缺 `refreshSessions()`）
- 快速切换会话导致 prompt 被当作 abort（旧 socket stragglers）

---

## [0.1.0] - 2026-07-19

### Added
- 项目初始化：`server.js` (Express + ws) + `public/` (HTML/JS/CSS)
- REST API：
  - `GET /api/sessions?cwd=` — 列出该 cwd 下所有 session（标题、时间、消息数）
  - `GET /api/session?file=` — 重建会话的根→叶对话线
- WebSocket `/ws?cwd=&session=` — 1:1 桥接 `pi --mode rpc`
- 前端 UI：
  - 左侧栏：搜索、历史列表、点击切换
  - 右侧：空状态建议、流式对话、Markdown 渲染
  - 底部：textarea + 发送/停止按钮
  - 顶栏：会话名、模型选择 pill
- 流式渲染：文本打字光标、thinking 块、工具折叠块
- 会话历史持久化：复用 pi 原生 `~/.pi/agent/sessions/*.jsonl`
- 多模型切换（pi 配置的所有 provider/model）
- 响应式深色主题（ChatGPT/Gemini 风格）

### Technical Debt (已知)
- 图片上传未接
- 多 cwd / 项目切换器未做
- fork / tree / clone 浏览未接
- 浅/深主题切换未做
- 双端实时同步未做
- 鉴权未做

---

## Legend

| 标记 | 含义 |
|------|------|
| **Added**    | 新功能 |
| **Changed**  | 现有功能变更 |
| **Deprecated** | 即将移除 |
| **Removed**  | 已移除 |
| **Fixed**    | Bug 修复 |
| **Security** | 安全相关修复 |