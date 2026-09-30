# 跨会话引用设计（@ 会话 pill + list_sessions / read_session 工具）

- 日期：2026-09-30
- 状态：已评审（brainstorming 逐节确认：注入语义 A / 工具颗粒度 B）
- 关联：`docs/specs/2026-09-16-composer-context-system-design.md`（context 链路直接上游）、`docs/specs/2026-09-17-rich-composer-inline-pills-design.md`（pill 体系）、`docs/specs/2026-08-04-v1.5-builtin-tool-library-design.md`（ToolModule 体系）

## §1 背景与动机

会话是 Momo Studio 的核心产出容器，但会话之间彼此隔离：用户在新会话（或任务派发）中想引用旧会话的结论与过程时，只能手动复制粘贴。典型场景：

1. 「参考上次那个设计讨论会话，帮我写实现计划」——旧会话的讨论结论是新任务的输入。
2. 任务派发时「请参考 xxxx 会话，完成 yyyy 任务」——子 agent 需要按标题找到会话并读取。
3. agent 自主探索——处理任务时主动翻相关会话补背景。

## §2 目标与非目标

**目标**

- G1：agent 可用 `read_session` 工具按需读取另一会话内容（正文 + 工具调用摘要）。
- G2：agent 可用 `list_sessions` 工具按关键词发现 / 消歧会话（支撑自然语言引用场景）。
- G3：用户在输入框 `@` 菜单选中会话 → session pill → 发送时以**指针**（元信息）注入 context，agent 据此免消歧直达 `read_session`。

**非目标（YAGNI）**

- 不做全量内容快照注入（长会话爆 context——评审裁定 A 方案：指针 + 按需读）。
- 不做跨 workspace 引用：工具与 `@` 菜单均限当前 workspace。
- 不做对被引会话的任何写入（严格只读）。
- 不做 system prompt 层强制 agent 调用工具（指针注入已含提示语，调不调由模型决定）。
- 无新 IPC 通道、无 schema 迁移、无版本号动作。

## §3 总体架构

```
用户路径（G3，明确引用）：
  @ 菜单选会话 → session pill → serializeSegments → body `@标题` + context.sessions=[{sessionId,title}]
    → sanitizeMessageContext（IPC 入口元素级校验）
    → expandMessageContext（主进程校验存在性 + 取元信息，已删降级占位）
    → renderUserContext 注入 <session> 指针块（含 read_session 使用提示）
    → agent 调 read_session(sessionId) 按需拉取

Agent 路径（G2，自然语言 / 自主探索）：
  "请参考xxxx会话" → list_sessions(keyword) → 按标题/时间/成员/预览消歧
    → read_session(id)；歧义无法消解 → agent 反问用户
```

设计原则：**指针轻注入 + 工具按需读**。`read_session` 是唯一的内容读取通道；`@` 只是帮 agent 省掉 `list_sessions` 消歧这一步。两条路径在 `read_session` 收敛。

工具执行环境：runtime 子进程直连 SQLite（`getDb()`，WAL 多进程安全，TaskTools 同款既有模式），无需主进程 IPC 中转。

## §4 Agent 工具：SessionTools

新文件 `electron/src/main/agent/tools/session-tools.ts`，实现 `ToolModule`，无条件注册进 `buildToolRegistry()`（`tools/index.ts`，同 TaskTools 先例）。

### §4.1 `list_sessions(keyword?, limit=20)` —— 发现与消歧

- **范围**：`listSessionsByWorkspace(ctx.workspaceId)`；**排除当前会话**（`ctx.roomId`，v2 语义 = sessionId——agent 上下文已含自身对话）。
- **keyword**：对标题不区分大小写子串匹配；缺省 = 不过滤，按最近活跃排序（repo 排序键 `COALESCE(last_message_at, created_at) DESC` 不变）。
- **limit**：默认 20，上限 50。
- **每项返回**（纯文本行）：
  ```
  - id=<sessionId> 《标题》 [chat|task_execution] 活跃=<MM-DD HH:mm> 消息数=<N>
    成员: <名1>/<名2>  预览: <首条用户消息正文截 80 字符>
  ```
- 成员名映射：workspace 成员（`listSessionMembers` → 实例 → `agent crud` 显示名）；用户行显示「用户」。
- 消歧元信息刻意冗余（时间 / 成员 / 消息数 / 预览）——标题可能自动命名且撞名，agent 据此自行判断或反问。

### §4.2 `read_session(sessionId, limit=50, beforeTs?, afterTs?)` —— 读取

**范围门（顺序执行，先于任何读取）**：

1. `getSession(sessionId)` 不存在 → 返回错误文案「会话不存在（可能已解散）」。
2. `session.workspaceId !== ctx.workspaceId` → 「会话不在当前 workspace，拒绝读取」。
3. `sessionId === ctx.roomId` → 「这是当前会话，内容已在你的上下文中」。

**读取与分页**：

- 默认返回**最近 limit 条**（复用 `listRecentMessagesBySession`）；`beforeTs` / `afterTs`（毫秒时间戳）区间翻页（`listMessagesBySession` 现成支持）。
- limit 默认 50，上限 200。
- 头部输出会话元信息 + 翻页提示：`更早消息：read_session(id, beforeTs=<本页最早一条 createdAt>)`。

**B 颗粒度渲染（评审裁定）**：

- 正文：每条消息一行 `[MM-DD HH:mm] <发送者名>: <body>`——`messages.body` 是可见正文单一真相源（已剥隐藏上下文块），不重新聚合 text_delta。
- 工具调用摘要：批量 `listEventsForMessages(messageIds)`（IN 分块，防 N+1）→ 每条 assistant 消息下按事件聚合工具段，缩进渲染：
  - 普通工具：`🔧 <toolName>(<args 摘要截 120 字符>) → <✓|✗> <result 截 200 字符>`
  - dispatch 段：`📤 dispatch→<subAgentName>: <task 截 80 字符> (<completed|failed|timeout>)`
  - 事件 payload 契约（消费 stream-relay 落库形状，禁止另行发明）：`tool_call_start = {callId, toolName, args, isDispatch?, subStreamSessionId?, subAgentName?}`；`tool_call_result = {callId, toolName, result, success, subStatus?}`。
  - 段聚合复用 `exportAggregateEvents`（`im/export-aggregator.ts`，已排除 thinking、已配对 start/result、已有测试覆盖）——SessionTools 只写薄渲染层，不重写配对逻辑。
- 输出总量上限：`OUTPUT_LIMITS` 新增 `read_session` 键（初值 30_000 字符，沿 git-tools / search-tools 既有截断模式），超限截断并尾注「输出已截断，请用 beforeTs/afterTs 或更小 limit 分段读取」。

**严格只读**：全程仅 `SELECT`（sessions / session_members / messages / message_events + 成员名映射读），不写任何表。

## §5 输入框：`@` 菜单「会话」组 + session pill

- `PillKind` 增加 `'session'`（`renderer/src/components/im/composer-segments.ts`）；`PILL_KINDS` 数组同步（草稿往返不丢）。
- `MentionInput` 的 `@` 触发统一菜单在现有 agent / 文件组之后追加「会话」组：
  - 数据源 `useSessionStore.sessions`（已在内存，**零新 IPC**）；
  - **排除当前激活会话**（`activeSessionId`）；
  - 按输入前缀过滤标题（大小写不敏感子串，与其它组一致）；
  - 选中 → `insertPill({ kind:'session', id:sessionId, label:title })`。
- pill 展示文本 `@<标题>`（`pillDisplayText` 增加 case；`PILL_CLASS` 增加 session 样式，lucide-react 图标 16px / stroke 1.75——具体视觉属 **P1 UI 变更，实现前按 `momo-ui-preview-rules` 走静态预览门禁**）。
- **序列化规则**（`serializeSegments`）：session pill → body 追加 `@<label>`（正文锚点，历史行文可读）+ `context.sessions` 按 sessionId 去重保序。**与 skill 的正文透明不同**：本设计注入的只是指针不是内容，正文锚点无双重曝光问题（对齐 agent / file pill 先例）。
- 消息气泡 context chip：`MessageBubble` 的 context chip 区渲染 session 引用（图标 + 标题，数据来自 `parseMessageContext`，见 §6）。

## §6 Context 契约扩展（协议面全链）

| 层 | 文件 | 改动 |
|---|---|---|
| 契约定义 | `renderer/src/ipc/types.d.ts` | `MessageContext` 增加可选 `sessions?: SessionContextItem[]`；新增 `SessionContextItem { sessionId: string; title: string }`（title 选择时快照，chip 渲染不反查） |
| 发送序列化 | `renderer/.../composer-segments.ts` | §5 序列化规则；`context` 组装条件加入 sessions |
| IPC 入口清洗 | `electron/.../im/session.ipc.handlers.ts` `sanitizeMessageContext` | sessions 元素级校验：元素须 `{sessionId: 非空 string, title: string}`，畸形剔除。⚠️ 现实现 spread 透传未知字段——sessions 必须像 images 一样显式处理（非数组剔除字段、数组则过滤元素），不得依赖透传 |
| renderer 解析 | `renderer/.../lib/message-context.ts` `parseMessageContext` | sessions 可选 + 形状校验（同 images 模式）：缺省 / 非数组 / 含畸形元素 → 视为无 session 引用；**不得因 sessions 非法 null 化整个 context**（skills / files 照常返回） |
| 主进程展开 | `electron/.../im/context-expander.ts` `expandMessageContext` | sessions 项：`getSession` 校验存在 + workspace 归属 → 产出 `ExpandedSessionItem`；不存在 / 跨 workspace → `missing: true` 降级占位。**「expander 永不抛错」契约不变**（逐项 try/catch，元素级防御同 skills I5 模式） |
| 线协议 | `electron/.../agent/runtime-config.ts` `ExpandedContext` | 增加 `sessions: ExpandedSessionItem[]`。旧载荷（resume 重放 / 历史行）无此字段 → 消费方按 `[]` 处理（`isExpandedContext` 判定键维持 skills + files 不动） |
| prompt 渲染 | `electron/.../agent/turn-context.ts` `renderUserContext` | 渲染 `<session>` 指针块（见下） |

**`ExpandedSessionItem` 形状**：

```typescript
interface ExpandedSessionItem {
  sessionId: string;
  title: string;            // @ 选择时快照标题（降级时保留原值）
  kind: 'chat' | 'task_execution';
  memberNames: string[];    // 显示名（用户 →「用户」）
  messageCount: number;
  lastMessageAt: number | null;
  missing: boolean;         // true = 已删除 / 跨 workspace，渲染降级文案
}
```

**`<session>` 指针块渲染**（正常态）：

```
<session id="<sessionId>" title="<标题>">
类型=<chat|task_execution> 成员=<a/b/c> 消息数=<N> 最近活跃=<MM-DD HH:mm>
用户引用此会话作为参考。完整内容请调用 read_session 工具读取（sessionId="<sessionId>"）。
</session>
```

降级态（missing）：保留 id / title，正文替换为「该会话已删除或不可访问」。

**向后兼容**：`sessions` 为可选字段——旧消息（context_json 无 sessions）、旧草稿（segments 无 session pill）自然兼容，images 先例同款模式。

## §7 错误处理与边界

| 场景 | 行为 |
|---|---|
| 被引会话已删除 | expander 降级占位注入「已删除」；`read_session` 返回「会话不存在」 |
| 跨 workspace 读取 | `read_session` 范围门拒绝；`@` 菜单只列本 workspace（天然无入口） |
| 读自己 | `read_session` 范围门拒绝（提示已在上下文）；`list_sessions` 与 `@` 菜单均排除当前会话 |
| 超长会话 | 默认最近 50 条 + beforeTs/afterTs 翻页 + 输出总量截断，三层防线 |
| 空会话 | `list_sessions` 显示消息数 0；`read_session` 返回头部 + 「会话无消息」 |
| 标题撞名 | `list_sessions` 消歧元信息（时间 / 成员 / 预览）供 agent 判断，无法判断则反问用户 |
| agent 不调工具 | 指针块已含使用提示；不做强制（§2 非目标） |
| context_json sessions 畸形 | sanitize 元素级剔除 + parseMessageContext 按无 session 引用降级，双重防御 |
| 子 agent（dispatch 场景） | 工具经 `buildToolRegistry` 无条件注册——快速会话 / 协作 leader / 子 agent 全部可用，`ctx.workspaceId` / `ctx.roomId` 由各自 runtime 注入，范围门语义一致 |

## §8 测试策略

测试位置遵从仓库约定（electron 集中 `electron/tests/` 镜像 src；renderer 贴源 colocated）。mock 遵从 `momo-test-rules`：repo 层用真 SQLite 内存库（TaskTools 测试同款），不简化运行时语义。

**electron**

- `electron/tests/agent/tools/session-tools.test.ts`：范围门三连（不存在 / 跨 workspace / 读自己）、默认最近 N 条与 beforeTs / afterTs 翻页、工具调用摘要形状（普通工具 + dispatch 段 + 未配对 start）、输出截断、空会话、limit 边界（默认 / 上限 / 非法值）。
- 契约锁（boundary-rules：协议面变更必须单测锁）：
  - `sanitizeMessageContext` sessions 三态（合法保留 / 畸形元素剔除 / 非数组剔字段）；
  - `parseMessageContext` sessions 形状（合法 / 畸形不 null 化整体 / 缺省）；
  - `serializeSegments` session pill（body 锚点 + 去重保序 + 草稿往返 `draftToSegments`）；
  - `expandMessageContext` session 项（存在 → 完整元信息 / 已删 → missing / 跨 workspace → missing / 永不抛错）；
  - `renderUserContext` session 块（正常态 / 降级态文案）。

**renderer**

- `composer-segments.test.ts` 扩展：session pill 序列化与草稿往返。
- `MentionInput.test.tsx` 扩展：`@` 菜单会话组（过滤 / 排除当前会话 / 选中插 pill）。
- `message-context.test.ts` 扩展：sessions 形状校验。

## §9 改动面清单与实施顺序

| # | 文件 | 改动 | 依赖 |
|---|---|---|---|
| 1 | `electron/src/main/agent/tools/session-tools.ts`（新） | SessionTools 两工具 | 无 |
| 2 | `electron/src/main/agent/tools/index.ts` | 注册 SessionTools | 1 |
| 3 | `renderer/src/ipc/types.d.ts` | `SessionContextItem` + `MessageContext.sessions?` | 无 |
| 4 | `renderer/src/components/im/composer-segments.ts` | PillKind + 序列化 + PILL_KINDS | 3 |
| 5 | `electron/src/main/im/session.ipc.handlers.ts` | sanitize sessions 校验 | 3 |
| 6 | `renderer/src/lib/message-context.ts` | parse sessions 校验 | 3 |
| 7 | `electron/src/main/agent/runtime-config.ts` | `ExpandedSessionItem` + `ExpandedContext.sessions` | 3 |
| 8 | `electron/src/main/im/context-expander.ts` | session 项展开 + 降级 | 7 |
| 9 | `electron/src/main/agent/turn-context.ts` | `<session>` 块渲染 | 7 |
| 10 | `renderer/src/components/im/MentionInput.tsx` | `@` 菜单会话组 | 4 |
| 11 | `renderer/src/components/im/RichComposer.tsx` | `PILL_CLASS` / `pillDisplayText` session case（P1 预览门禁） | 4 |
| 12 | `renderer/src/components/im/MessageBubble.tsx` | session context chip | 6 |

实施顺序建议（供 writing-plans 参考）：**阶段一 = #1–2（工具独立可测，先落地 agent 能力）→ 阶段二 = #3–9（契约链纵切，协议面一次对齐）→ 阶段三 = #10–12（UI，走预览门禁）**。
