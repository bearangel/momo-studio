# 会话导出 Markdown 设计

**版本**：v1.7.2
**作者**：Sisyphus（基于 brainstorming 会话产出）
**日期**：2026-08-12
**状态**：待 review

## 1. 背景

当前 Momo Studio 的会话消息存 Matrix/Conduwuit 服务端，用户想给我（AI）或团队成员看会话内容时只能截图——信息密度低、thinking/tool_calls 元数据丢失、dispatch 嵌套结构无法呈现。

opencode 等工具提供 session 导出功能（JSON 格式），可把完整对话历史落盘分享。本设计为 Momo Studio 加类似功能：从会话界面一键导出 Markdown 文件，包含完整 thinking + tool_calls + dispatch 嵌套，方便诊断 agent 行为问题。

## 2. 目标

- 会话顶部工具栏加「⤓ 导出」按钮，一键导出当前房间最近 N 条消息
- 导出格式：人可读 Markdown（thinking `<details>` 折叠 + tool_calls 表格 + dispatch 嵌套块）
- 默认 100 条，用户可调整数量
- 浏览器 Blob + `<a download>` 触发下载（macOS Finder save sheet）
- 完整保留诊断价值（thinking / args / result 都不截断——超长 result 单独 `<details>` 包裹）

## 3. 非目标

- 不实现 JSON 格式导出（YAGNI，Markdown 已够诊断用）
- 不做权限校验（用户只能导出自己 joined 的房间，Matrix 层已控制）
- 不动 DB schema（`getRoomMessages` 已有，数据源现成）
- 不引入新依赖（Markdown 手拼字符串）
- 不做用户选起止范围（UX 复杂，YAGNI）
- 不自动脱敏（用户自己掌控，导出前可选择删除敏感字段）

## 4. 关键决策汇总

| 维度 | 决策 | 理由 |
|---|---|---|
| 格式 | 仅 Markdown（人可读） | 诊断场景下贴给我或人看，Markdown 最直接；JSON 兜底价值有限 |
| 范围 | 最近 N 条（默认 100，可调） | 防止超大房间一次导出几千条；UI 加数量输入框 |
| 入口 | 会话顶部工具栏按钮（与 RoomToolBudgetBadge 并排） | 从会话界面一眼可见，路径最短 |
| 保存方式 | 浏览器 Blob + `<a download>` 触发下载 | 不需要新 IPC（如 dialog.showSaveDialog）；Chromium 内核会弹原生 save 对话框 |
| 详细度 | 完整版（thinking `<details>` 折叠 + tool_calls args/result 完整 + dispatch 嵌套块 + 文件头元数据） | 诊断价值最高 |
| 大 result 处理 | 表格摘要（前 200 字符 + 总字符数）+ 单独 `<details>` 完整内容 | 防 read_file 2000 行撑爆文件 |
| 错误 tool_call | `❌` + error message | 区分成功/失败 |
| 子 agent 嵌套 | dispatch 块 + 子 agent 完整工作过程（thinking+tool_calls+文本）整体一个 `<details>` 折叠 | 避免主消息被嵌套内容淹没 |

## 5. 架构总览

### 5.1 数据流

```
[会话顶部 ⤓ 导出按钮]
       ↓ 点击
[小弹窗：消息数量输入（默认 100）+ 确定]
       ↓
[IPC: im:exportRoomMessages(roomId, limit)]
       ↓
[后端 handler：
   1. 分页调 getRoomMessages(roomId, 50, offset) 拉满 N 条（或无更多）
   2. formatRoomToMarkdown(messages, metadata) → Markdown 字符串
   3. 返回 { filename, content }]
       ↓
[renderer Blob + <a download={filename}>]
       ↓ 浏览器弹原生 save 对话框
[Toast 提示成功/失败]
```

### 5.2 文件结构

#### 新增

| 文件 | 职责 |
|---|---|
| `electron/src/main/im/markdown-exporter.ts` | 纯函数 `formatRoomToMarkdown(messages, meta): string` |
| `renderer/src/components/im/ExportChatButton.tsx` | UI 组件：弹窗 + 调 IPC + Blob 下载 |
| `electron/tests/im/markdown-exporter.test.ts` | formatter 纯函数测试 |

#### 修改

| 文件 | 改动 |
|---|---|
| `electron/src/main/im/ipc.handlers.ts` | 加 `im:exportRoomMessages` handler |
| `electron/src/preload/index.ts` + `renderer/src/ipc/types.d.ts` | 绑定 IPC + 加类型 |
| `renderer/src/components/layout/MiddlePanel.tsx` | 房间头部加 `<ExportChatButton>` |

### 5.3 IPC 通道

```typescript
// 新增
im:exportRoomMessages(roomId: string, limit: number): Promise<{
  filename: string;   // 'momo-session-<roomName>-<YYYYMMDD-HHmm>.md'
  content: string;    // 完整 Markdown 内容
}>
```

后端 handler 内部分页拉取（`getRoomMessages(roomId, 50, offset)` 循环直到拉满 N 条或无更多），formatter 接收完整 `MatrixMessagePayload[]`。

## 6. Markdown 结构

### 6.1 文件示例

```markdown
# 会话导出：项目经理办公室

- **房间**：`!abc123:localhost`（项目经理办公室）
- **导出时间**：2026-08-12 14:30:15
- **消息范围**：最近 100 条（实际 87 条）
- **时间跨度**：2026-08-12 13:15:42 ~ 2026-08-12 14:28:03

---

## 👤 用户 @owner:localhost — 2026-08-12 13:15:42

帮我读一下 `docs/spec.md` 文件，总结要点

---

## 🤖 项目经理 @bot.pm-agent:localhost — 2026-08-12 13:15:50

<details>
<summary>💭 thinking（点击展开）</summary>

用户想了解 docs/spec.md 的内容...

</details>

**🔧 工具调用**

| 工具 | 参数 | 结果 |
|---|---|---|
| `read_file` | ```json
{ "path": "docs/spec.md" }
``` | ✅ 成功（返回 1240 字符）

<details>
<summary>📄 read_file 完整结果（点击展开）</summary>

````
# 项目设计文档
...
````

</details>

读完 `docs/spec.md` 了，主要要点：...

---

## 🤖 项目经理 @bot.pm-agent:localhost — 2026-08-12 13:20:15

**📨 委派子 agent：coder**

<details>
<summary>📦 子 agent coder 工作过程（点击展开）</summary>

#### 🤖 coder @bot.coder:localhost — 13:20:20

<details>
<summary>💭 thinking</summary>

需要实现第 3 章...

</details>

**🔧 工具调用**

| 工具 | 参数 | 结果 |
|---|---|---|
| `write_file` | ```json
{ "path": "src/foo.ts" }
``` | ✅ 成功 |

文件已创建...

</details>

---

**导出结束（87 条消息）**
```

### 6.2 渲染规则

| 消息元素 | Markdown 表示 | 说明 |
|---|---|---|
| **文件头** | `# 会话导出：{roomName}` + 元数据列表 | 房间 ID / 导出时间 / 范围 / 时间跨度 |
| **分隔符** | `---` | 每条消息之间空行 + 分隔线 |
| **用户消息** | `## 👤 用户 @userId — 时间` + body | emoji 👤 区分 |
| **agent 文本** | `## 🤖 {agentName} @botId — 时间` + body | emoji 🤖 + agent 配置名 |
| **thinking** | `<details><summary>💭 thinking</summary>` + 内容 + `</details>` | 默认折叠 |
| **tool_calls** | **🔧 工具调用** + 表格（工具/参数/结果） | result ≤ 500 字符直接显示；> 500 摘要 + `<details>` 完整 |
| **dispatch** | **📨 委派子 agent：{slug}** + `<details>` 嵌套块 | 子 agent 完整工作过程折叠 |
| **task_reply** | 归入父 dispatch 的 `<details>` | 不作为顶层消息 |
| **错误** | ❌ + error message | tool_call 失败标记 |

### 6.3 Agent 名字解析

- 优先：`content.bot_name`（v1.4 起所有新消息都有）
- 兜底：`shortName(sender)`（`@bot.pm-agent:localhost` → `pm-agent`）

## 7. 测试覆盖

### 7.1 Electron（formatter 纯函数，~10 用例）

```typescript
describe('formatRoomToMarkdown', () => {
  it('文件头含房间名 + 导出时间 + 消息数 + 时间范围', () => {});
  it('用户消息渲染：👤 + userId + 时间 + body', () => {});
  it('agent 纯文本消息：🤖 + bot_name + 时间 + body', () => {});
  it('agent bot_name 缺失时 fallback shortName(sender)', () => {});
  it('thinking 渲染为 <details> 折叠块', () => {});
  it('tool_call 渲染：表格（工具/参数/结果）', () => {});
  it('tool_call result 超 500 字符单独 <details> 折叠 + 表格摘要', () => {});
  it('tool_call 失败：❌ + error message', () => {});
  it('dispatch 消息渲染为 📨 委派块 + 子 agent 嵌套 <details>', () => {});
  it('task_reply 归入父 dispatch 块（不作为顶层消息）', () => {});
  it('多消息按时间顺序排列，每条之间 --- 分隔', () => {});
});
```

### 7.2 Renderer（UI 组件，~5 用例）

```typescript
describe('ExportChatButton', () => {
  it('点击 → 弹窗（数量输入默认 100）', () => {});
  it('确认 → 调 ipc.im.exportRoomMessages(roomId, limit)', () => {});
  it('成功 → Blob + <a download> 触发下载 + 关闭弹窗', () => {});
  it('失败 → 红字错误 + 弹窗保持打开', () => {});
  it('导出中按钮 disabled（防双击）', () => {});
});
```

## 8. 实施顺序

```
T1: markdown-exporter.ts 纯函数 + 测试（可独立测，无 IPC / UI 依赖）
T2: IPC handler + preload + types.d.ts（粘合层）
T3: ExportChatButton 组件 + MiddlePanel 接入 + 测试
```

**关键路径**：T1 → T2 → T3（串行）

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| `getRoomMessages` 默认 limit 50，用户传 100+ 需要分页拉取 | formatter 入参直接接收完整 `MatrixMessagePayload[]`，分页由 IPC handler 负责（循环调 `getRoomMessages(roomId, 50, offset)` 直到拉满 N 条或无更多） |
| `content` 字段结构因 v1.4/v1.5/v1.6 演进有差异 | formatter 对每个字段做 `?? ''` 兜底，老消息缺字段不崩 |
| Bot user id 解析 agent 名依赖 assignment 表 | 直接用 `content.bot_name`（v1.4 起所有新消息都有），老消息 fallback shortName |
| Markdown 特殊字符（body 含 `\|` 破坏表格） | body 不用表格，用代码块/引用块；tool_call args 用 ```json 代码块（`|` 不破坏） |
| 大 result（read_file 2000 行）撑爆文件 | 表格摘要（前 200 字符）+ 单独 `<details>` 完整内容折叠 |
