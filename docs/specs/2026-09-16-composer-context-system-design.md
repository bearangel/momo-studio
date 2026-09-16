# 会话输入框上下文系统设计（技能 / 指令 / 文件引用）

- **日期**：2026-09-16
- **状态**：已评审（用户确认），待实施
- **范围**：renderer 输入框 + IPC 契约 + 主进程派发链 + messages 存储 + 预置技能包
- **上游输入**：用户需求「输入框应支持指定技能、指令、文件；系统目前支持 @agent 和 #引入任务」；主流 AI agent 工具输入框调研（Claude Code / Cursor / ChatGPT / Slack / Discord / OpenCode / Copilot / Cline）
- **关联文档**：
  - `docs/specs/2026-08-31-agent-team-session-redesign.md` — 会话域现行设计（steer / 车道 / 双会话）
  - `docs/specs/2026-08-23-v2.0.0-platform-refactor-design.md` — 平台架构（sessions 内核 / task-driven runtime）
  - `docs/dev/rules/engineering.md` — 研发红线（契约漂移教训）

---

## 1. 背景与目标

当前会话输入框（`renderer/src/components/im/MentionInput.tsx`）仅支持 `@agent`（菜单选择成员）与 `#T-xxx`（引用任务）。对标主流工具后确认三项能力缺失：

1. **技能（skill）**：主进程 skill 系统已完备（`SkillRegistry` 三层渐进披露 + zip 上传 + `resource:*` IPC），但输入框无任何触发入口，用户无法在对话中临时调用 skill
2. **指令（slash command）**：仅有 `/compact` 一个命令（renderer 本地白名单 + 主进程 if-chain 双处维护），无 `/` 触发菜单
3. **文件**：完全空白——消息载荷为纯文本 `body: string`，无 attachment 字段、无文件选择对话框、无拖拽

**目标**：输入框支持「指定技能、指令、文件」，与既有 `@agent` / `#task` 共存，形成四个正交上下文入口。

**成功标准**：

- 用户可在输入框通过 `/` 菜单选择命令（即执行）或技能（chip 随消息发送、一次性注入）
- 用户可通过 `@` 菜单文件组或 📎 按钮引用 workspace 文件（路径引用语义）
- 消息气泡中技能 / 文件 chip 化渲染，文件 chip 可点击在编辑器打开
- 预置 3 个 builtin skill，`/` 菜单技能组开箱非空

## 2. 现状盘点（可复用基石）

| 领域 | 现状 | 关键文件 |
|---|---|---|
| Skill 系统 | `SkillRegistry` 三层渐进披露（`getIndex` / `loadFull(slug)` / `loadResource`）；`SkillFrontmatter { name, description, version, allowedTools?, tags? }`；zip 上传（custom 源）；builtin 扫描代码已存在但 `electron/resources/skills/` 目录不存在 | `electron/src/main/skill/{types,registry,loader,zip-uploader}.ts` |
| 资源统一注册 | `ResourceType = 'agent' \| 'mcp' \| 'skill'`；6 个 `resource:*` IPC（list / getDetail / install / delete / registerMcp / uploadSkill） | `electron/src/main/resource/{types,ipc.handlers}.ts` |
| 斜杠命令 | renderer `sendMessage` 拦截 `/` 开头 → `session:command` IPC（本地白名单仅 compact，`//` 转义）；主进程 `handleSessionCommand` 仅 compact 分支；`commandHint` 提示槽已渲染 | `renderer/src/stores/session.store.ts` L349-376；`electron/src/main/im/session-service.ts` |
| @ / # 机制 | `@` 正则 `/(?:^|\s)@([A-Za-z0-9-]*)$/` 触发成员菜单，选中登记 `pendingMentions`（instanceId）随 IPC 第 3 参发送；`#T-xxx` 仅插正文，主进程 `activateMentionedTasks(body)` regex 反解 | `MentionInput.tsx` L102-158；`session-service.ts` |
| 消息载荷 | `session:send(sessionId, body, mentionedInstanceIds?)`；`ImMessage.body: string` 纯文本；messages 表 15 列无扩展列 | `renderer/src/ipc/types.d.ts` L312/L817；`electron/src/main/storage/messages/repo.ts` |
| 派发链 | `sendUserMessage` → `router.routeUserChat` → TaskConfig → `AgentRunner.executeTask` → 子进程 `task-config`（已有 `mentions` / `dispatchContext` / `resume` / `historyPrefix` 条件展开模式）；steer 分支 `runner.steer(streamSessionId, body)` | `router-service.ts` L94-150；`agent-runner.ts` L277-293/L542 |
| 文件操作 | `file:read/write/list/create/delete/rename/searchNames`（workspace FS，agent 工具与文件树视图用）；`dialog:pickDirectory`（仅目录）；无任何 chat 附件通道 | `electron/src/main/files/ipc.handlers.ts` |
| 工具栏 | `InputToolbar.tsx` 注释明确「预留扩展位：附件、表情等未来功能」 | `renderer/src/components/im/InputToolbar.tsx` |
| 编辑器 | `editor.store.openFile(path, content)` 打开文件到编辑器 tab | `renderer/src/stores/editor.store.ts` |

## 3. 核心决策记录

| # | 决策 | 选择 | 依据 |
|---|---|---|---|
| D1 | 文件语义 | **路径引用**（workspace 内文件，agent 按需 `file:read`；正文内联展开见 §6.2） | 主流 coding 工具一致（Cursor / Cline / Copilot）；workspace 已有完整 FS + file 工具；零附件存储成本 |
| D2 | 技能生效范围 | **一次性注入**（随本条消息展开，不持久） | 与 skill 永久绑定（`defaultSkills`）正交：composer 级是临时上下文；Cline 发送时展开模式，实现简单语义清晰 |
| D3 | `/` 命名空间 | **命令 + 技能统一菜单分组** | Claude Code / OpenCode / Copilot 均此模式，认知负担最低；命令（即执行）与技能（随消息）执行路径不同但前缀共享 |
| D4 | 文件触发方式 | **@ 菜单分组扩展**（成员组 + 文件组，`@/路径` 形态区分）+ 📎 工具栏按钮 | Cursor 模式；`@` 已被 agent、`#` 已被任务占用；📎 复用同一菜单不另做浏览面板 |
| D5 | 消息渲染 | **chip 化**（气泡内 skill 徽标 + 文件 chip，文件可点击打开） | 主流做法；`#T-xxx` / `@agent` 维持纯文本不动（不扩大范围） |
| D6 | 预置技能 | **预置 3 个**（code-review / write-tests / debug-reproduce） | 三工具横向对照：code-review 三家皆有；write-tests / debug-reproduce 是空白地带且通用性强 |
| D7 | 数据流架构 | **方案 B：结构化 context 参数 + 主进程展开** | chip 渲染需要真实数据源；避免结构化信息编码进自由文本再 regex 反解（P0 教训的典型漂移模式）；skill 正文不落库仅派发时渐进加载 |

## 4. 总体架构

```
MentionInput (renderer)
  ├─ @ 菜单：成员组（现有逻辑不动） + 文件组（新增，`@/` 触发）
  ├─ / 菜单：命令组 + 技能组（仅空 body 开头 `/` 触发）
  └─ pendingContext = { skills: [{slug,name}], files: [{path}] }   ← chip 化，随消息发送
        ↓ ipc.session.send(sessionId, body, mentions?, context?)
session-service.sendUserMessage (main)
  ├─ messages 表落库 body + context_json（新列，metadata 级）
  ├─ P2P 广播载荷带 context（远端镜像可渲染 chip）
  └─ router.routeUserChat({ sessionId, assignmentId, body, context, ... })
context-expander (main, 新模块)
  ├─ skills → SkillRegistry.loadFull(slug)      ← 复用三层渐进披露
  └─ files  → fs 读取（≤64KB 内联；超出/失败降级为路径引用 + 提示行）
        ↓ ExpandedContext { skills:[{slug,name,body}], files:[{path,content|null}] }
AgentRunner
  ├─ executeTask → task-config 增加 context 字段（照抄 mentions 条件展开模式）
  └─ steer → { type:'steer', streamSessionId, body, context }（活跃流中途追加同样生效）
子进程 chat loop：ExpandedContext 包成 <user-context> 块注入本轮 LLM 请求
```

**两层契约刻意分离**：

- **renderer → main 传 metadata**（`MessageContext`：slug / 路径）——轻量、可落库、可推送 renderer 渲染 chip
- **main → 子进程传展开后全文**（`ExpandedContext`：skill 正文与文件内容）——正文绝不落库、绝不回 renderer，渐进披露语义不变

## 5. 契约定义

### 5.1 类型（`renderer/src/ipc/types.d.ts`，两 workspace 共享）

```typescript
/** 输入框上下文——renderer 与主进程之间的 metadata 级契约（不含 skill 正文 / 文件内容） */
export interface SkillContextItem {
  slug: string;
  /** 展示名（选择时从 skill 索引快照，避免渲染时反查） */
  name: string;
}

export interface FileContextItem {
  /** workspace 相对路径（POSIX 风格） */
  path: string;
}

export interface MessageContext {
  skills: SkillContextItem[];
  files: FileContextItem[];
}
```

```typescript
/** 主进程展开后下发给子进程的上下文（不落库、不回 renderer） */
export interface ExpandedSkillItem {
  slug: string;
  name: string;
  /** SKILL.md 正文（loadFull 产物） */
  body: string;
}

export interface ExpandedFileItem {
  path: string;
  /** 文件内容；null = 超 64KB / 读取失败 / 总量超限降级为路径引用 */
  content: string | null;
}

export interface ExpandedContext {
  skills: ExpandedSkillItem[];
  files: ExpandedFileItem[];
}
```

> `ExpandedContext` 定义位置：主进程侧类型放 `electron/src/main/im/context-expander.ts` 导出；子进程（agent runtime entry）需要同型定义，随 `task-config` 协议类型一并声明在子进程侧协议文件（与 `dispatchContext` / `resume` 等现有字段的声明位置一致）。实施时以实际协议类型文件为准，**不得**在两处各写一份再手工同步——单点定义、类型导入。

### 5.2 IPC 变更

| 通道 | 变更 |
|---|---|
| `session:send` | 签名 `(sessionId, body: string, mentionedInstanceIds?: string[], context?: MessageContext)`——第 4 参可选，向后兼容 |
| `session:listCommands`（新增） | 返回 `Array<{ name: string; description: string }>`——主进程命令注册表查询，`/` 菜单命令组数据源 |
| `session:command` | 不变（renderer 不再本地白名单，未知命令统一转发，由主进程返回中文错误） |

`ImMessage`（types.d.ts L312）增加 `contextJson: string | null`——wire 契约：`session:message` 推送与 `getMessages` 返回的都是原始 `MessageRow` 直通（camelCase），主进程不做解析变换（避免多推送点遗漏）；renderer 消费时经 `renderer/src/lib/message-context.ts` 的 `parseMessageContext` 单点解析（损坏 → null）。

### 5.3 存储变更

migration（inline SQL，`electron/src/main/storage/migrations/index.ts` 追加）：

```sql
ALTER TABLE messages ADD COLUMN context_json TEXT NULL;
```

- `MessageRow` / `SqlRow` / `rowToCamel` / `insertMessage` 同步加 `contextJson` 字段；`rowToCamel` 内 `JSON.parse` 防御性 try/catch（损坏 → `context: undefined`）
- 落库内容 = `MessageContext` 序列化（metadata 级，无正文 / 内容）
- 旧行 `context_json IS NULL` → `context: undefined`，天然兼容

### 5.4 TaskConfig 与子进程协议

- `TaskConfig`（`agent-runner.ts` 域类型）加 `context?: ExpandedContext`
- `RouteUserChatInput` 加 `context?: MessageContext`
- `task-config` 子进程消息：`...(task.context ? { context: task.context } : {})`（条件展开，与 `dispatchContext` / `resume` / `historyPrefix` 同型）
- `steer` 子进程消息：`{ type: 'steer', streamSessionId, body, ...(context ? { context } : {}) }`；`AgentRunner.steer` 与 `RouterService.routeUserChat` steer 分支同步加参

### 5.5 子进程注入格式

chat loop 构建本轮 LLM 请求时，`ExpandedContext` 非空则注入（用户消息之前 / 系统提示之后，具体挂点以子进程 chat loop 实际构建函数为准）：

```xml
<user-context>
<skill name="code-review">
（SKILL.md 正文）
</skill>
<file path="src/foo.ts">
（文件内容，或「文件过大（xx KB），请用文件工具按需读取」）
</file>
</user-context>
```

## 6. 主进程设计

### 6.1 命令注册表（`electron/src/main/im/commands.ts`，新文件）

```typescript
export interface SessionCommandDef {
  name: string;         // 'compact'
  description: string;  // 中文一句话，/ 菜单展示
}
export const SESSION_COMMANDS: readonly SessionCommandDef[] = [
  { name: 'compact', description: '压缩会话历史，释放上下文窗口' },
];
```

- `handleSessionCommand` 由 if-chain 改为查表分发（compact 逻辑不动，仅搬迁注册）
- `session:listCommands` handler 返回该表
- renderer `sendMessage` 删除本地 `compact` 白名单：`/xxx` 整条拦截后统一 `session:command`，未知命令错误文案由主进程统一生成（「未知命令: /xxx（当前支持 /compact）」移至主进程）

### 6.2 上下文展开器（`electron/src/main/im/context-expander.ts`，新文件）

```typescript
export async function expandMessageContext(
  workspaceId: string | null,
  context: MessageContext,
): Promise<ExpandedContext>
```

- **skills**：逐 slug 调 `SkillRegistry.loadFull(slug)`；失败（已删除 / 损坏）→ 跳过并 `logger.warn`，同时在对应位置注入占位 `{ slug, name, body: '[skill 已不可用]' }` 保持用户意图可见
- **files**：workspace 根下解析相对路径读取；单文件 `> 64KB`（`MAX_INLINE_FILE_BYTES = 64 * 1024`）→ `content: null`；累计内联 `> 256KB`（`MAX_TOTAL_INLINE_BYTES = 256 * 1024`）后其余文件降级 `content: null`；读取失败 → `content: null` + `logger.warn`
- 降级文件在返回结构中带 `content: null`，由子进程注入 `<file path="...">文件过大，请用文件工具按需读取</file>` 提示行
- 路径安全：仅允许 workspace 根内的相对路径（拒绝 `..` 逃逸与绝对路径——输入面在 renderer，此处为信任边界校验）

### 6.3 派发链接线

`sendUserMessage`（session-service）：

1. `insertMessage({ ..., contextJson: context ? JSON.stringify(context) : null })`
2. P2P 广播载荷增加 context（远端镜像渲染 chip；镜像侧只读不展开）
3. `router.routeUserChat({ ..., context })`
4. `applyFirstMessageTitle(body)` 补充回退：body 为空且 context 非空时，用首个 skill name（无 skill 则首个文件 basename）作首条消息截断命名的来源，避免空标题会话

`routeUserChat`（router-service）：在 steer 分支**之前**调用 `expandMessageContext`（展开一次，steer 与 executeTask 两分支共用）；`TaskConfig` 与 `runner.steer(...)` 均携带 `ExpandedContext`。

### 6.4 预置技能包

```
electron/resources/skills/
  code-review/SKILL.md
  write-tests/SKILL.md
  debug-reproduce/SKILL.md
```

- frontmatter：`name` / `description`（中文一句话）/ `version`；正文中文
- builtin 扫描代码已存在（registry loader 扫描 `<resources>/skills/`），目录落地即被 `resource:list({ type: 'skill' })` 收录（source = builtin）
- 内容定位：通用工程技能，不绑定本项目 agent——`code-review`（对照基线审查变更）、`write-tests`（为指定模块补测试）、`debug-reproduce`（先复现后修复的排查流程）

## 7. renderer 设计

### 7.1 MentionInput 扩展

**新增状态**：

```typescript
type MenuKind = 'agent' | 'task' | 'command';           // 文件并入 'agent' 分组展示
interface PendingContext {
  skills: SkillContextItem[];
  files: FileContextItem[];
}
```

**触发检测**（`detectTrigger` 扩展，现有 `@` / `#` 正则不变）：

- `@` 后紧跟 `/` → 文件模式：`/(?:^|\s)@\/([^\s]*)$/` 捕获路径局部；菜单显示「成员」+「文件」两组（成员组优先，各限 8 条）
- body 为空且以 `/` 开头 → 命令模式：`/^\/([A-Za-z0-9-]*)$/`；菜单显示「命令」+「技能」两组

**菜单数据源**：

- 成员：现有（`members` 过滤 `lastRunning`）
- 文件：`file:searchNames(query)`（模糊搜索 workspace 文件名；实施时核对签名，若不满足前缀/模糊需求则基于 `file:list` 结果本地过滤）
- 命令：`session:listCommands()`（挂载时拉取缓存）
- 技能：`resource:list({ type: 'skill' })`（挂载时拉取缓存）

**选择行为**：

- 成员：现有逻辑不动
- 文件：`insertMention('@/path/to/file')` + `pendingContext.files` 登记（去重）。注意：现有 `insertMention` 的局部替换正则 `/(?:^|\s)(@[A-Za-z0-9-]*$|#[A-Za-z0-9-]*$)/` 字符集不含 `/`，匹配不到 `@/sr` 这类文件局部输入——需为文件标记增加变体分支（如 `@(\/[^\s]*)$`），与 `detectTrigger` 的文件触发正则同字符集
- 命令：`insertMention('/name ')` 插入文本，Enter 沿用现有命令路径执行
- 技能：`pendingContext.skills` 登记（body 不插文本）+ 关闭菜单

**chip 区**：`pendingMentions`（现有）+ `pendingContext.skills` + `pendingContext.files` 同区渲染；skill chip 用 `Zap`、文件 chip 用 `FileText`（lucide-react，16px / stroke 1.75）；逐个可移除；发送失败全部恢复；会话切换时 chips 与 pendingMentions 同生命周期清空（正文文本随草稿保留，见 §8 边界表）。

**发送**：`handleSend` 校验放宽为 `trimmed || pendingContext 非空`；`sendMessage(trimmed || '', mentions, context)`。仅 skill 无正文是合法消息（skill 正文即 prompt）。

**Enter 语义**：菜单激活时 Enter 选中菜单项不发送（现有行为，扩展到新菜单类型）；Escape 关菜单（现有）。

### 7.2 InputToolbar 📎 按钮

预留扩展位落地：`Paperclip` 图标按钮，点击 = 聚焦 textarea 并在光标处插入 `@/` 触发文件菜单（单一入口复用，不另做文件浏览面板）。只读态禁用。

### 7.3 session.store

- `sendMessage(body, mentionedInstanceIds?, context?)`：透传第 4 参；`/` 拦截改为统一转发（删本地白名单，见 §6.1）
- `receiveMessage` / `selectSession` / `loadOlder` 无需改动（`ImMessage.context` 随行）

### 7.4 MessageBubble

owner 消息且 `message.context` 非空 → body 上方渲染 chip 行：

- skill chip：`Zap` + name，纯展示
- 文件 chip：`FileText` + basename，点击 → `file:read(path)` 后 `editor.store.openFile(path, content)`（复用现有编辑器链路；读取失败 toast/静默降级为不可点样式）

`@agent` / `#T-xxx` 维持纯文本渲染，本次不动。

### 7.5 设计系统合规

新 UI 一律语义 token（`bg-surface-*` / `text-secondary` 等）、`components/ui/` 原子组件优先、lucide-react 图标 16px / stroke 1.75、无 emoji 图标、无 inline 硬编码颜色（`docs/dev/design-system.md`）。

## 8. 错误处理与边界

| 场景 | 行为 |
|---|---|
| skill 派发时已删除 / 损坏 | 展开降级：`body: '[skill 已不可用]'` 占位注入，消息照发不阻塞；`logger.warn` |
| 文件读取失败 / 单文件 > 64KB / 累计 > 256KB | `content: null` 降级 + 子进程注入「请用文件工具按需读取」提示行 |
| 路径逃逸（`..` / 绝对路径） | 展开器拒绝，按读取失败降级处理 |
| `context_json` 损坏 | `rowToCamel` 防御性解析 → `context: undefined`，消息正常显示（无 chip） |
| 发送失败 | 正文 + mentions + context chips 一并恢复（照抄现有 pendingMentions 恢复模式） |
| 只读会话 | 输入禁用（现有），📎 同步禁用 |
| 会话切换草稿 | 正文文本随草稿恢复（现有 draftsRef 机制）；context chips 与 pendingMentions 同生命周期——切换即清空（与现有 @ 行为对齐，正文中的 `@/路径` 标记文本仍随草稿保留） |
| IME 组合期 Enter | 不发送（现有 isComposing / 229 守卫，天然覆盖新菜单） |
| P2P 远端消息 | context 只读渲染 chip，不展开不回传（spec D7 铁律不涉——本特性不写远端 tasks） |
| steer 中途追加 | context 随 steer 消息下发，下一轮 LLM 请求注入（一次性语义在 steer 分支同样成立） |
| steer 事件的持久化不对称（实现期裁定） | steer 线协议携带原文 + context 元数据（`message_events` 持久化 ExpandedContext 全量，为主进程 resume 重放所需）；后续回合会话重建只回原文不展开（`expandSteerContext` 模式分流），展开仅在活回合与 resume 同回合重放发生 |
| 未 drain 的带 context steer | 若流在 drain 前中断，该 steer 的 context 从未送达模型（会话重建只回原文）——与主路径降级姿态一致（展开只在活回合保证），属设计立场 |

## 9. 测试策略

**electron（`electron/tests/`，目录镜像 `src/`）**：

- `tests/im/context-expander.test.ts`：skill 展开 / 失败占位 / 文件大小上限（单文件 + 总量）/ 路径逃逸拒绝
- `tests/im/session-context.test.ts`：`sendUserMessage` 落库 `context_json` / `ImMessage.context` 回填 / P2P 载荷携带
- `tests/agent/router-context.test.ts`：`routeUserChat` context 注入 TaskConfig 与 steer 分支（mock runner 断言 steer 第 3 参）
- `tests/im/commands-registry.test.ts`：查表分发 / 未知命令中文错误
- migration：旧行（context_json NULL）兼容，新行读写往返
- 子进程协议：`task-config` / `steer` 携带 context 的接线锁（照抄 `resume` / `historyPrefix` 透传锁模式）

**renderer（贴源 colocated）**：

- `MentionInput.test.tsx` 扩展：`@/` 文件触发 / 分组菜单渲染 / 文件选择登记 chip / `/` 命令+技能两组 / 技能选择 chip / 命令插入文本 / chip 移除 / 发送失败恢复 / 空 body + context 可发送 / 菜单激活 Enter 不发送
- `session.store.test.ts` 扩展：context 透传 / 未知命令转发主进程
- `MessageBubble.test.tsx` 扩展：context chip 渲染 / 文件 chip 点击打开编辑器（mock file:read）

**e2e（`tests/e2e/`）**：@ 选文件 + / 选 skill → 发送 → 消息 chip 显示（Playwright，需先构建）。

## 10. 不做的事（non-goals）

- 不做文件**上传/附件**语义（OS 外部文件拖拽复制进 workspace）——D1 明确引用语义，外部文件走后续迭代
- 不做 skill **会话级启用 / 固定模式**（Cursor pinned mode）——D2 明确一次性
- 不改 `@agent` / `#T-xxx` 的触发正则与路由契约——文件组是 @ 菜单的**新增分组**，现有 `@([A-Za-z0-9-]*)$` 成员匹配不变
- 不做消息气泡内 `@` / `#` 的 chip 化渲染（D5 范围仅 skill / 文件）
- 不动 `AgentDefinition.defaultSkills` 永久绑定链路（capability-merger 照旧）
- 不做 `/` 命令的参数解析框架（仅整条命令名分发，未来按需扩展）

## 11. 实施切面提示（供 writing-plans 展开）

按依赖序：migration + 类型 → context-expander + commands 注册表 → 派发链接线（session-service / router / agent-runner / 子进程）→ renderer 菜单与 chip → MessageBubble 渲染 → 预置技能包 → 测试补齐。两个 workspace typecheck 必须同时过（IPC 契约变更，preload 三层引用 renderer types.d.ts）。
