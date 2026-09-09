# Compaction Overhaul · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 压缩机制 opencode 化——窗口元数据全链、token 阈值自动压缩、结构化摘要 + 尾部保留 + 历史收缩、溢出恢复、prune。

**Architecture:** 主进程 `CompactionService`（结构化摘要生成 + `session_compactions` 持久化）经 IPC 服务子进程；子进程每轮请求前做 token 阈值检查并持有尾部保留选择权；`getConversationContext` 按 `covered_until` 收缩历史并注入摘要。

**Tech Stack:** Electron 主进程（CommonJS）+ React renderer + better-sqlite3 + vitest。

**Spec:** `docs/specs/2026-09-09-compaction-overhaul-design.md`（冲突时以 spec 为准）

## Global Constraints

- Node 20：所有命令前 `nvm use 20`（容器默认 Node 26 破坏 better-sqlite3）
- pnpm 统一 `npx pnpm@9.0.0`；单测：`cd electron && npx pnpm@9.0.0 vitest run tests/<path>`
- TypeScript strict：禁 `any` / `as any` / `@ts-ignore`；注释全中文；Conventional Commits
- 红线：agent 运行时路径不得出现「继续工作」字面串（注释也不行）
- 既有断言不得弱化；IPC 契约双端 types.d.ts 同步
- 每任务收尾 `npx pnpm@9.0.0 typecheck`（根目录双 workspace）

---

### Task 1: 窗口元数据全链

**Files:**
- Modify: `electron/src/main/storage/migrations/index.ts`（新增 migration）
- Create: `electron/src/main/llm/model-catalog.ts`
- Modify: `electron/src/main/agent/spawn-helpers.ts`（resolveModelLimits + AGENT_CONFIG 透传）
- Modify: `electron/src/main/agent/runtime-config.ts`（RuntimeConfig 新字段）
- Modify: `electron/src/main/storage/`(provider_models repo 若有专文件；否则在 settings/provider 相关 repo) + 设置 IPC + `renderer` 设置页模型列表编辑 + preload/types
- Test: `electron/tests/llm/model-catalog.test.ts`（新建）+ storage migration 测试扩展

**Interfaces:**
- Produces:
  - `lookupModelLimits(platform: 'openai' | 'anthropic', modelName: string): ModelLimits | null`，`ModelLimits = { contextWindow: number; outputTokens: number }`
  - `resolveModelLimits(providerId: string, modelId: string): Promise<ModelLimits | null>`（spawn-helpers 或专模块导出；用户列优先）
  - `RuntimeConfig.contextWindow: number`（0=未知）、`RuntimeConfig.outputTokens: number`（0=未知）
  - `session_compactions` 表与 `provider_models.context_window` 列（后续任务消费）

- [ ] **Step 1: 失败测试**——`tests/llm/model-catalog.test.ts`：①`lookupModelLimits('openai','gpt-4o')` 返回 `{contextWindow:128000,...}`；②`('anthropic','claude-sonnet-4-20250514')` → 200000；③`('openai','totally-unknown')` → null；④`('anthropic','claude-sonnet-4-1-20250805-1m')` 1M 变体匹配；⑤模糊匹配 `glm-4.7` 命中 glm 条目。migration 测试：新列可写读、`session_compactions` 建表 + CASCADE（沿既有 migration 测试文件模式，`tests/storage/` 下找 migration 测试扩展）。运行确认 FAIL。

- [ ] **Step 2: 实现**

migration（取当前最大版本号 +1，两段 SQL 一起）：

```sql
-- ─── vN：压缩改造（spec 2026-09-09）──────────────────────────────────────
-- 1. provider_models.context_window：用户手动覆盖的上下文窗口（token；NULL=未知，走内置目录）。
ALTER TABLE provider_models ADD COLUMN context_window INTEGER;
-- 2. session_compactions：会话压缩摘要（每会话单行 upsert；与 session_summaries 的
--    背景摘要语义分离——本表 covered_until 驱动历史收缩，extraction 语义不动）。
CREATE TABLE IF NOT EXISTS session_compactions (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  covered_until INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`model-catalog.ts`（完整新文件；条目 ≥15 覆盖 gpt-4o/4.1/5/o 系、claude-3.5/3.7/4 含 1M 变体、glm-4.x、deepseek-v3/r1、qwen-max/plus、kimi-k2、gemini-2.x——窗口值以官方公开文档为准，注释注明来源日期）：

```typescript
/** 内置模型窗口目录（spec §2.2）：按 (platform, 名称正则) 匹配；用户列优先于此表 */
export interface ModelLimits { contextWindow: number; outputTokens: number }
interface CatalogEntry { platform: 'openai' | 'anthropic'; pattern: RegExp; limits: ModelLimits }
const CATALOG: CatalogEntry[] = [ /* …按上述清单逐条… */ ];
export function lookupModelLimits(platform: 'openai' | 'anthropic', modelName: string): ModelLimits | null {
  for (const e of CATALOG) {
    if (e.platform === platform && e.pattern.test(modelName)) return { ...e.limits };
  }
  return null;
}
```

resolve 链（放 spawn-helpers.ts，读 provider_models 行的 context_window，非 NULL 且 >0 则覆盖目录值）：

```typescript
export async function resolveModelLimits(providerId: string, modelId: string): Promise<ModelLimits | null> {
  const row = getDb().prepare('SELECT context_window FROM provider_models WHERE provider_id = ? AND model_id = ?').get(providerId, modelId) as { context_window: number | null } | undefined;
  const userWindow = row?.context_window;
  const catalog = lookupModelLimits(platform, modelId); // platform 由 provider 行/platform 列取
  if (userWindow && userWindow > 0) {
    return { contextWindow: userWindow, outputTokens: catalog?.outputTokens ?? 0 };
  }
  return catalog;
}
```

（具体取 provider platform 与 repo 访问方式以现有 spawn-helpers 代码为准对齐——typecheck 驱动。）

`buildSpawnOpts`：解析 agent 的 provider/model 后调 `resolveModelLimits`，把 `contextWindow`/`outputTokens`（null→0）写入 AGENT_CONFIG 载荷；`runtime-config.ts` 的 `RuntimeConfig` 加两字段（`0=未知`），`runtime-entry` 侧 AGENT_CONFIG 解析处透传。

设置页：provider 模型列表行加「上下文窗口（可选）」数字编辑；IPC 沿 provider_models 既有写通道（若无则加 `provider:setModelWindow` 通道，types.d.ts 双端同步）。renderer 改动遵循 v2.1 语义 token。

- [ ] **Step 3: 绿 + 回归**——新测试绿；`tests/storage/` 全绿；typecheck 双 clean。
- [ ] **Step 4: Commit**——`feat: 模型窗口元数据全链——provider_models.context_window + 内置目录 + spawn 透传（spec §2）`

---

### Task 2: 纯函数包——token 估算 + 压缩模板 + 序列化

**Files:**
- Create: `electron/src/main/agent/tools/shared/token-estimate.ts`
- Create: `electron/src/main/compaction/prompt.ts`
- Create: `electron/src/main/compaction/serialize.ts`
- Test: `electron/tests/agent/tools/token-estimate.test.ts`、`electron/tests/compaction/prompt.test.ts`、`electron/tests/compaction/serialize.test.ts`（新建）

**Interfaces:**
- Produces:
  - `estimateTokens(text: string): number`（CJK ÷1.6 / 其余 ÷4）
  - `estimateConversation(input: { system: string; messages: LLMMessage[]; tools?: unknown[] }): number`
  - `COMPACTION_BUFFER_TOKENS = 20_000` / `COMPACTION_KEEP_TOKENS = 8_000` / `COMPACTION_MIN_TRIGGER = 4_000`（token-estimate.ts 导出）
  - `buildCompactionPrompt(input: { conversation: string; previousSummary?: string }): string`
  - `serializeMessages(messages: LLMMessage[]): string`

- [ ] **Step 1: 失败测试**

token-estimate：①纯中文「一二三四五六七八九十」（10 CJK）≈ ⌈10/1.6⌉=7；②纯英文 40 字符 ≈ 10；③混合样例锁定区间；④estimateConversation 含 system 与 tools 序列化（空 tools 与含 1 个工具定义单调递增）。prompt：①无 prior → 含「<conversation>」与五节模板全部节名（目标/重要细节/工作状态/下一步/相关文件）与「勿提及」规则；②有 prior → 含 `<prior-summary>` 与合并指令（「冲突以对话为准」）。serialize：①user/assistant 文本映射 `[用户]:`/`[助手]:`；②带 toolCalls 的 assistant → `[工具调用]: name(json)` + `[工具结果]:`；③工具结果 >2000 字符截断加 `[truncated]`。

- [ ] **Step 2: 实现**（三个纯函数文件，无 DB/IPC 依赖；LLMMessage 类型从 `../llm-provider` 导入）

模板核心（spec §4.1 中文化，固定节序 + terse 规则 + 保留标识符 + 勿提及压缩过程；prior 合并指令独立常量）。serialize 对 assistant 消息：text 部分 + toolCalls 逐个（`JSON.stringify(arguments)`），后随 role==='tool' 消息的结果文本（截断 2000）。

- [ ] **Step 3: 绿 + typecheck + Commit**——`feat: 压缩纯函数包——中文 token 估算/结构化摘要模板/对话序列化（spec §3-4.2）`

---

### Task 3: 主进程 CompactionService + IPC 桥 + /compact 迁移

**Files:**
- Create: `electron/src/main/compaction/service.ts`
- Modify: `electron/src/main/agent/runtime-spawner.ts`（messageHandler 新分支）
- Modify: `electron/src/main/agent/runtime-entry.ts`（compaction:result 处理 + pending map，沿 task-reply 模式）
- Modify: `electron/src/main/im/session-service.ts`（handleSessionCommand compact 分支迁移）
- Test: `electron/tests/compaction/service.test.ts`（新建）+ `electron/tests/im/session-command.test.ts` 适配

**Interfaces:**
- Consumes: T2 三纯函数；`resolveSessionLlm`（extraction 导出）
- Produces:
  - `generateCompaction(input: { sessionId: string; conversation: string }): Promise<{ summary: string }>`（prior 由服务自读 `session_compactions`；失败 throw）
  - `upsertSessionCompaction(sessionId: string, summary: string, coveredUntil: number): void`
  - `getSessionCompaction(sessionId: string): { summary: string; coveredUntil: number } | null`
  - IPC wire：子→主 `{ type: 'compaction:request', streamSessionId, sessionId, conversation, coveredUntil }`；主→子 `{ type: 'compaction:result', streamSessionId, ok: true, summary } | { …, ok: false, error }`

- [ ] **Step 1: 失败测试**——service.test.ts（mock resolveSessionLlm 与 DB）：①成功生成 + upsert（断言 SQL 效果或 mock 调用参数含截断到 SUMMARY_MAX_LEN）；②llm 返回空 → throw；③无 LLM 配置 → throw 指向「模型服务」；④有 prior 行 → buildCompactionPrompt 收到 previousSummary（mock 断言）。session-command 适配：mock compaction/service 模块，断言 /compact 走 generateCompaction 且 upsert 写 `session_compactions`（covered_until=最后覆盖消息 createdAt）。

- [ ] **Step 2: 实现**

service.ts：读 prior（`getSessionCompaction`）→ `resolveSessionLlm` → `buildCompactionPrompt({ conversation, previousSummary })` → `llm.chat` → 空摘要 throw → `slice(0, SUMMARY_MAX_LEN)` → 调用方决定 covered_until（本任务内 /compact 命令传值；子进程请求自带）。wire 桥：runtime-spawner messageHandler `compaction:request` 分支——`generateCompaction` 成功后 `upsertSessionCompaction(sessionId, summary, coveredUntil)`，回 `{type:'compaction:result', ok:true, summary}`；异常回 `ok:false, error: message`。runtime-entry：模块级 `pendingCompactions: Map<streamSessionId, {resolve,reject}>`，`requestCompaction(sessionId, conversation, coveredUntil): Promise<string>`（10s 超时 reject）；taskMessageListener 加 `compaction:result` 分支按 streamSessionId resolve。

/compact 命令迁移：`listRecentMessagesBySession` → 最近一轮（最后一条 user 消息起）verbatim 排除在序列化外，其余 `serializeMessages` 风格拉平（复用 T2；messages repo 行 → LLMMessage 形状的映射按 messageToContext 语义就地小函数）→ `generateCompaction` → `upsertSessionCompaction(sessionId, summary, 最后被覆盖消息的 createdAt)` → 确认消息文案不变。

- [ ] **Step 3: 绿 + tests/im 回归 + typecheck + Commit**——`feat: 主进程 CompactionService——结构化摘要生成+session_compactions 持久化+IPC 桥（spec §4）`

---

### Task 4: 历史收缩 + 摘要注入 + prune

**Files:**
- Modify: memory provider `getConversationContext` 实现层（`electron/src/main/memory/sqlite-provider.ts` 及接口默认实现；以实际文件为准）
- Test: `electron/tests/memory/`（新建 conversation-shrink.test.ts，真 DB harness 沿既有 memory 测试模式）

**Interfaces:**
- Consumes: T3 `getSessionCompaction`
- Produces: 行为契约——①有 compaction 行：`created_at > covered_until` 才拉取，且返回 messages 头部插 `{ role:'user', content:'[此前对话压缩摘要]\n'+summary }`；②无 compaction 行：现行为不变；③prune：除最后一条 user 消息之后（含该轮）外，工具结果文本 >2000 字符截断 `[truncated]`

- [ ] **Step 1: 失败测试**——真 DB harness：seed 消息 12 条 + 写 session_compactions（covered_until=第 8 条 createdAt）→ 断言返回 [摘要注入条, 第9..12条]；无行 → 12 条全返回；prune：第 2 条消息带 3000 字工具结果 → 截断，最后 user 回合的工具结果不截断。
- [ ] **Step 2: 实现**（provider 查询加条件 + 头部插条 + 映射层截断；接口签名不变——返回形态扩展）
- [ ] **Step 3: 绿 + tests/memory 回归（extraction/injection 既有用例不破）+ typecheck + Commit**——`feat: 会话历史收缩——covered_until 过滤+压缩摘要注入+旧工具结果 prune（spec §5/§8）`

---

### Task 5: 子进程接线——compact 工具改造 + auto 阈值 + 双态续行

**Files:**
- Modify: `electron/src/main/agent/builtin-tools.ts`（compact 工具 schema/描述）
- Modify: `electron/src/main/agent/runtime-entry.ts`（compact 分支重写 + auto 阈值 + prompt-hints 引用清理）
- Modify: `electron/src/main/agent/prompt-hints.ts`（删 buildCompactSuggestHint）
- Test: `electron/tests/agent/compact-wrapup.test.ts`（大改适配）+ `tests/agent/copy-neutral.test.ts` 适配 + 新 `tests/agent/compact-auto.test.ts`

**Interfaces:**
- Consumes: T1 `RuntimeConfig.contextWindow/outputTokens`；T2 估算/常量/serialize；T3 `requestCompaction`
- Produces: 行为契约——①compact 工具无 summary 参数，执行=尾部保留+IPC 摘要+替换 messages（尾部 verbatim 保留）；②auto：窗口>0 且 est 超阈值 → 压缩；有 user 挂靠 → synthetic 续行消息+继续；无 → wrapUpMode 收尾；③>30 注入块删除

- [ ] **Step 1: 失败测试**

新 `compact-auto.test.ts`（fake-LLM harness 沿 compact-wrapup 模式，mock `requestCompaction` 模块）：
(a) `contextWindow=1000`、构造超阈值 messages → 断言请求前发生 compaction IPC（mock 收到 conversation），压缩后 messages 含「[历史压缩摘要]」且尾部 verbatim 条目保留；
(b) 无 user 挂靠 + auto 压缩 → wrapUpMode（下一轮 tools undefined）；
(c) 有 user 挂靠 → synthetic「[系统] 上下文已自动压缩」消息存在且工具可用；
(d) `contextWindow=0` → 不触发（mock 零调用）。
compact-wrapup 适配：工具新 schema（无 summary）、断言意图不变（双态/收尾/steer/task 域不变式全部保留——mock requestCompaction 返回固定摘要）。

- [ ] **Step 2: 实现**

builtin-tools compact 定义替换：

```typescript
{
  name: 'compact',
  description: '触发系统级上下文压缩：由专用链路生成结构化摘要（目标/工作状态/下一步等固定节），无需你撰写总结。压缩会保留最近若干轮原文。当用户明确要求压缩、或你判断上下文过长影响工作质量时调用。',
  inputSchema: {
    type: 'object',
    properties: { note: { type: 'string', description: '压缩动机备注（可选，仅入审计）' } },
  },
}
```

runtime-entry：抽本地 async `runCompaction(coveredUntilBase: number): Promise<boolean>`——①尾部选择（从尾向前按 KEEP 预算累计 estimateTokens，边界不切断当前 user 消息与 mandate 所在轮）；②head=`serializeMessages(头部)`；③`await requestCompaction(roomId, head, coveredUntil)`；④成功则替换 messages 并按 `hasPendingUserTodos` 设 wrapUpMode / 注入续行消息；⑤失败返回 false。compact inline 分支调它（成功 tool result 报「上下文已压缩：N→1+尾部 M 条」）。auto 检查块置于每轮 refreshSystem 后（spec §6.2 伪码逐行落地；task 域跳过）。`:457-463` 注入块与 prompt-hints 函数删除，import 清理。

- [ ] **Step 3: 绿 + tests/agent 全量回归 + typecheck + Commit**——`feat: 子进程压缩接线——compact 工具 harness 化+token 阈值自动压缩+双态续行（spec §6）`

---

### Task 6: 溢出恢复 + 重放 + 防循环

**Files:**
- Modify: `electron/src/main/agent/runtime-entry.ts`（chatStream catch 路径）
- Test: `electron/tests/agent/overflow-recovery.test.ts`（新建）

- [ ] **Step 1: 失败测试**——fake LLM：第一次 chatStream throw `Error('Request too large: maximum context length exceeded')`，mock requestCompaction 成功 → 断言：压缩发生一次、`[历史压缩摘要]` 后**重放** user 消息（messages 含 mandate.userBody 文本）并继续到完成；第二次再溢出 → 回合按错误终止（end chunk error），compaction IPC 仍只 1 次（防循环）。abort 错误优先级不变。
- [ ] **Step 2: 实现**——catch 内先判 AbortError（现行为），再匹配 `/context|token.{0,20}(limit|exceed)|maximum.{0,20}length|too (long|many)/i`；`overflowRecovered` 回合级 flag 未置且 `estimateConversation > MIN_TRIGGER` → `runCompaction` 成功 → 置 flag、重放 mandate（userBody + steers 逐条 push user 消息）→ continue 外层轮循环；失败走原错误路径。
- [ ] **Step 3: 绿 + Commit**——`feat: 溢出恢复——provider 上下文溢出后压缩一次并重放本轮授权（spec §7）`

---

### Task 7: 全量回归与验收对照

- [ ] `npx pnpm@9.0.0 test` 全绿；typecheck 双 clean；红线 grep「继续工作」运行时零命中
- [ ] 契约抽查：AGENT_CONFIG 含 contextWindow；/compact 命令产出结构化五节摘要且写 session_compactions
- [ ] macOS 真机剧本（记录待主机）：长任务自动压缩续跑 / 压缩后跨回合摘要注入 / 窗口未知模型不自动压 / 溢出恢复
- [ ] 收尾提交（如有小修）

---

## Self-Review（已执行）

1. **Spec 覆盖**：§2→T1、§3/§4.1-4.2→T2、§4.3-4.5→T3、§5/§8→T4、§6→T5、§7→T6、§11→T7。无缺口。
2. **占位符**：T1 catalog 条目以「≥15 条清单+来源注释」给定（枚举内容属实现素材非逻辑缺口）；「以实际文件/typecheck 对齐」均为既有验证工作法。无 TBD。
3. **类型一致性**：`ModelLimits`/`resolveModelLimits`（T1 产、T1 自消费）；`estimateTokens/estimateConversation/COMPACTION_*`（T2 产、T5 消费）；`generateCompaction/upsertSessionCompaction/getSessionCompaction`（T3 产、T3/T4 消费）；`requestCompaction(sessionId, conversation, coveredUntil): Promise<string>`（T3 产 runtime-entry 内、T5/T6 消费）；IPC wire 形状 T3 内双端锁定。
