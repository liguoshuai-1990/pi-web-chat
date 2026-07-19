# 问题排查记录

项目开发过程中遇到并修复的问题。仅列**已经修复的**问题，以及**为什么这么修**的推理。

---

## 1. 侧边栏 `cwd` 路径编码错误

**症状**：API `GET /api/sessions?cwd=/home/zrlgs` 拿不到任何结果。

**根因**：第一版用了 `cwd.replace(/\//g, "-")` 把 `/home/zrlgs` 编码成 `-home-zrlgs`，但 pi 实际上用的是 `--home-zrlgs--`（前后都带 `-`），因为它先把路径规范化成带尾 `/` 再替换。

**修复**：弃用编码猜测，**扫描 sessions 根目录下所有子目录**，读每个 jsonl 的 header 里 `cwd` 字段，再按 `cwd` 严格比对过滤。对任何编码规则鲁棒。

**教训**：多进程/多工具共用同一份存储时，**不要猜测对方的命名约定**，要么读它、要么用查询接口。

---

## 2. 左下角连接状态文本「未连接」永不更新

**症状**：页面打开后显示「未连接」，但 WebSocket 已经连上（绿点亮），文字却一直是「未连接」。

**根因**：HTML 里写死 `<span id="connLabel">未连接</span>`，JS 里只改了圆点颜色和 `title` 属性，**从未更新文本**。

**修复**：
- 初始化显示「连接中…」
- `ws.onopen` → `label.textContent = "已连接"`
- `ws.onclose` / `onerror` → `label.textContent = "已断开"`

**教训**：状态机要全连贯，连点带面一起动。

---

## 3. 侧边栏会话条目前的 `●` 圆点无意义

**症状**：每个会话前都有个灰色 `●`，选中不变色、hover 无反馈、无任何信息量。

**修复**：直接删除该 span。把会话标题 + 时间 + 消息数做成整行可点击，鼠标悬停 tooltip 显示完整 jsonl 路径。

---

## 4. 新建会话后侧边栏不刷新

**症状**：点「新对话」按钮 → 清空聊天区、连新 ws，但左侧列表里看不到这条新会话。

**根因**：`btnNew` 点击处理里没有调 `refreshSessions()`。

**修复**：点击后立刻 `refreshSessions()`，让新会话（pi 已经在后台建好文件）马上出现。

---

## 5. 点击发送按钮后没任何反应（消息被静默丢弃）

**症状**：新建会话、或刚连接时输入内容并按 Enter，**用户消息不显示、也没有后续回复**，表现像"没点到"。

**根因**：`submitPrompt` 里写着：
```js
if (!text || !state.wsConnected) return;
```
当 ws 还没 open（`state.wsConnected === false`）时，输入直接被丢弃，用户毫无感知。

**修复**：
- 判断 `wsConnected` 失败时，给输入框加 350ms 红色 box-shadow 抖动提示
- 返回 `return` 但不再静默吞掉文本

---

## 6. WebSocket 代次竞态 —— 旧 socket 残留消息污染新会话

**症状**：点「新对话」快速发消息时，前一次会话的 `agent_end` / `agent_settled` 等延迟事件仍会跑进新会话的 `handlePiMessage`，导致 `state.streaming` 被错误置为 `true`，新 prompt 被当作"停止"而 abort。

**根因**：`connectWs()` 里旧 ws `onclose = null` 后 `close()`，但关闭握手期间仍可能收到旧消息；新 ws 已经建立并注册了同一处理函数，旧消息被误派发。

**修复**：
- 引入全局 `wsGen` 单调递增计数器
- 每次 `new WebSocket` 给 `ws._gen = ++wsGen`
- `onmessage` 处理前 `if (ws._gen !== wsGen) return` 丢弃旧代消息
- 打开新 session 时显式清理 `state.streaming = false` 等流式状态

**教训**：任何 long-lived socket 在重连/切换时，**必须要有代次/epoch 机制** 防止旧事件污染新上下文。

---

## 7. `pi exited (code=null)` 偶发

**症状**：server log 里偶尔出现 `pi exited (code=null)`。

**推测**：`child_process.kill("SIGTERM")` 后进程组残留，或被父进程组收割时状态为 null。极少见、不复现，且不影响功能（只是 log 里多一行）。

**现状**：观察未加入显式修复，后续若频发可改用 `proc.kill("SIGKILL")` 或监控 `proc.exitCode`。

---

## 8. 前端 markdown 渲染器 XSS 风险

**症状**：早期把 markdown 转 HTML 后直接 `innerHTML`，没有先 escape。

**根因**：用户输入或模型输出若包含 `<img src=x onerror=...>` 等会被执行。

**修复**：
```js
function escapeHtml(s) {
  return s.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">");
}
```
在 `renderMarkdown` 入口先 escape，再做 markdown 语法转换。

**教训**：任何用户/模型可控内容最终落到 `innerHTML`，**必须先 escape**，且不要用 `DOMPurify` 这种库（增加依赖），自己写一行 escape 够用。

---

## 9. 侧边栏搜索不区分大小写，但 `includes` 有性能隐患

**症状**：搜索框输入时逐字符过滤 100+ 条 session，主线程卡顿。

**修复**：用 `toLowerCase()` 一次性转小写后再 `includes`；现数据量小（< 20 条）不再深究。若未来上千条可加防抖 / 虚拟列表。

---

## 10. `session` 列表按钮 hover/active 状态缺失

**症状**：点击会话项时没有明显的按下反馈（只有 hover 变背景）。

**修复**：加 CSS `:active { background: var(--bg-hover); transform: scale(0.998); }`，低成本提升体验。

---

## 11. 发送按钮在 streaming 时未及时变"停止"图标

**症状**：发送后按钮还是向上箭头 ↑，用户不知道点它能停止。

**修复**：`agent_start` / `agent_settled` 里切换 `sendBtn.classList.toggle("stop")` 并把文本从 `↑` 改 `■`。

---

## 12. `set_session_name` 调用过早导致标题全是 "hi" 这种短语

**症状**：第一轮对话只说了 "hi"，侧边栏标题就变成 "hi"。

**修复**：只在 `state.currentSessionFile == null`（真正的全新会话）时调用 `set_session_name`，且取前 60 字、压缩空白。已有会话不再覆盖标题。

---

## 后续可关注

- 图片上传（`images` 字段）前端 UI 未接
- 多 cwd / 项目切换器
- fork / tree / clone 浏览（RPC 已支持）
- 浅/深主题切换
- 双端实时同步（终端 + 浏览器看同一流）