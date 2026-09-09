# 上下文压缩机制重构（Compaction Overhaul）设计

- **日期**：2026-09-09
- **状态**：已获用户批准（方向三轮呈现后拍板「一次过全部开展」）
- **上游输入**：opencode 压缩设计调研（`sst/opencode` `packages/core/src/session/compaction.ts` + `packages/opencode/src/session/compaction.ts` 全文对照）+ turn-mandate 特性（已合并 `1615239..d1a184c`）
- **前置 spec**：`docs/specs/2026-09-08-turn-mandate-compact-boundary-design.md`（mandate 双态机制保留并复用）

---

## 0. 背景与问题清单

turn-mandate 修复了「压缩后越界自驱」，但压缩机制本身仍是「对话 agent 回合内的 LLM 工具」，与 opencode 的 harness 级设计存在六项差距：

| # | 问题 | 现状证据 |
|---|---|---|
| P1 | 摘要由主模型 free-form 顺手写，无结构模板/无标识符保留规则/无长度上限 | compact 工具 `summary` 参数 ≥50 字符即收 |
| P2 | 无尾部保留——压缩把最近几轮原文一并抹掉 | `messages.length = 0` 全量替换 |
| P3 | agent 自压缩的总结回合结束即丢（每回合重拉 DB 20 条），跨回合零收益 | `getConversationContext(roomId, {limit:20})` |
| P4 | 无 token 感知：>30 条消息数阈值与窗口无关 | `runtime-entry.ts` 循环顶注入；且模型配置无窗口字段（`model_providers`/`provider_models` 零容量列，全库 grep `contextWindow` 0 命中） |
| P5 | 工具输出膨胀无轻量处置，只能整段压缩 | 无 prune 机制 |
| P6 | provider 溢出错误无恢复路径 | chatStream 错误直接终止回合 |

## 1. 目标与非目标

### 目标

1. **窗口元数据全链**：`provider_models.context_window` 列 + 内置模型目录 + resolve 链 + spawn 透传 + 设置页编辑；未知窗口 fail-safe。
2. **token 估算**（中文混合系数）：估算对象含 system + messages + tools。
3. **主进程 CompactionService**：结构化摘要模板（opencode 式固定节）+ 滚动合并 + 尾部预算选择 + 持久化 + IPC。
4. **历史收缩**：压缩覆盖点（covered_until）之前的 DB 历史不再拉取，跨回合上下文 = 结构化摘要 + 未覆盖近期原文。
5. **子进程接线**：compact 工具改造为 harness 触发器（LLM 不再写摘要）；请求前 token 阈值自动压缩；auto 后按 mandate 双态续跑/收尾；>30 提示退役。
6. **溢出恢复**：provider 溢出错误 → 压缩一次 → 重放本轮用户消息（防循环）。
7. **prune 微压缩**：历史拉取时旧轮次超长工具结果截断。

### 非目标

- 独立「compaction 专用模型」配置（v1 用会话 leader 模型，走 `resolveSessionLlm`——与 extraction 管线一致；后续可加）
- 摘要请求 maxTokens 参数（`llm.chat` 现无 generation 参数位；模板「terse」规则约束长度，超限兜底靠 SUMMARY_MAX_LEN 硬帽）
- 持久化工具输出的原地 prune（opencode 修改 part.state 那种）——本设计只在**拉取映射层**截断，不改存量数据
- dispatch 子 agent 路径的压缩行为变化（fresh 会话短，不触发）
- task 域（currentTaskId 非空）的 auto 压缩（mandate=task + complete_task 终态已足够；task 域仅保留 NL compact 触发器路径）

## 2. 窗口元数据（P4 数据依赖）

### 2.1 数据层

- **Migration（下一版本号）**：`ALTER TABLE provider_models ADD COLUMN context_window INTEGER;`（NULL=未知）。
- **新表 `session_compactions`**（与 `session_summaries` 分离，避免与 extraction 背景摘要的 covered_until 语义纠缠）：

```sql
CREATE TABLE IF NOT EXISTS session_compactions (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  covered_until INTEGER NOT NULL,   -- 已被摘要覆盖的最后一条消息 createdAt（毫秒）
  updated_at INTEGER NOT NULL
);
```

### 2.2 内置模型目录

新文件 `electron/src/main/llm/model-catalog.ts`：`(platform, 名称正则) → { contextWindow, outputTokens }` 静态表，覆盖常见系列（openai gpt-4o/4.1/5/o-series、anthropic claude 3.5/3.7/4（200k/1M 变体）、glm-4.x、deepseek、qwen、kimi 等，≥15 条目）。导出：

```typescript
export interface ModelLimits { contextWindow: number; outputTokens: number }
export function lookupModelLimits(platform: 'openai' | 'anthropic', modelName: string): ModelLimits | null
```

### 2.3 resolve 链（单一真相源）

`resolveModelLimits(providerId, modelId)`：`provider_models.context_window`（用户覆盖，非 NULL 优先）→ 目录匹配 → `null`（未知）。消费方：`buildSpawnOpts` 把 `contextWindow`/`outputTokens` 写入 AGENT_CONFIG → `RuntimeConfig` 新字段（`0` 表示未知）。

### 2.4 fail-safe 语义

窗口未知（0）→ **不做自动阈值压缩**；NL compact 工具与 `/compact` 命令路径不受影响（显式请求总是允许压缩）。

## 3. Token 估算

新文件 `electron/src/main/agent/tools/shared/token-estimate.ts`（子进程可用的纯函数，无 DB 依赖）：

```typescript
/** 中文混合系数估算：CJK 字符 ÷1.6，其余 ÷4（opencode ÷4 会系统性低估中文 50%+） */
export function estimateTokens(text: string): number
/** 估算对象 = system + 全部 messages（含工具 JSON）+ 工具定义序列化 */
export function estimateConversation(input: { system: string; messages: LLMMessage[]; tools?: LLMToolDef[] }): number
```

常量（子进程与主进程共享，全部经 AGENT_CONFIG 透传，runtime 侧不硬编码）：
- `COMPACTION_BUFFER_TOKENS = 20_000`（输出预留下限）
- `COMPACTION_KEEP_TOKENS = 8_000`（尾部保留预算）
- `COMPACTION_MIN_TRIGGER = 4_000`（估算低于此值不压——对话太短压缩无意义）

## 4. 主进程 CompactionService

新目录 `electron/src/main/compaction/`：

### 4.1 prompt.ts（结构化模板，opencode 式中文化）

```typescript
export function buildCompactionPrompt(input: { conversation: string; previousSummary?: string }): string
```

固定节模板：`## 目标 / ## 重要细节 / ## 工作状态（已完成·进行中·阻塞）/ ## 下一步 / ## 相关文件`，规则三条（terse 要点、保留精确路径/符号/命令/错误串、**勿提及摘要过程本身**）。滚动合并指令：`<prior-summary>` 与 `<conversation>` 冲突以对话为准、完成项搬家、用户指令/决策必须携带。

### 4.2 serialize.ts（对话序列化）

`serializeMessages(messages: LLMMessage[]): string`——`[用户]: …` / `[助手]: …` / `[工具调用]: name(args)` + `[工具结果]: …`（单结果截断 2000 字符），与 opencode serialize 对齐的中文版。

### 4.3 service.ts

```typescript
export async function generateCompaction(input: {
  sessionId: string;
  conversation: string;        // 子进程已 select 的 head 序列化
  previousSummary: string | null;
}): Promise<{ summary: string }>   // 失败 throw（显式路径显式反馈）
```

流程：读 `session_compactions` 取 prior → `resolveSessionLlm(sessionId)`（复用 extraction 链，null → throw 指向模型服务配置）→ `buildCompactionPrompt` → `llm.chat` → 摘要空/失败 throw → `slice(0, SUMMARY_MAX_LEN)` 硬帽 → upsert `session_compactions`（covered_until 由调用方传入——子进程路径传「尾部起始消息的 createdAt 或回合内当前时间」，`/compact` 命令路径传 `Date.now()`）。

### 4.4 IPC 契约（子进程 ↔ 主进程）

- 子进程 → 主进程：`{ type: 'compaction:request', streamSessionId, sessionId, conversation, previousSummary, coveredUntil }`
- 主进程 → 子进程：`{ type: 'compaction:result', streamSessionId, ok: true, summary }` 或 `{ ok: false, error }`
- 接线点：`runtime-spawner.ts` messageHandler 新分支（沿 `audit:toolCall` 桥模式）；子进程侧 runtime-entry 注册 pending promise（沿 task-reply 模式）。

### 4.5 `/compact` 命令迁移

`session-service.handleSessionCommand` 的 compact 分支改调 CompactionService：拉历史（`listRecentMessagesBySession`）→ 头部序列化（keep 预算内尾部从摘要中排除，直接不序列化尾部段）→ `generateCompaction` → upsert（covered_until = 最后一条被覆盖消息的 createdAt）→ 确认消息不变。行为变化：摘要从两节自由模板变为结构化模板 + 写入 `session_compactions`（而非 `session_summaries`）→ 自动获得历史收缩效果。

## 5. 历史收缩与注入（P3 修复核心）

`getConversationContext`（memory provider）改造：

```
读 session_compactions(session_id)
  存在 → 消息查询加 WHERE created_at > covered_until（被覆盖历史不再拉取）
        → 返回 messages 头部插一条 { role: 'user', content: '[此前对话压缩摘要]\n' + summary }
  不存在 → 现行为不变
```

效果：跨回合上下文 = 结构化摘要 + 未覆盖近期原文（opencode summary+recent 的 Momo 映射，天然复用每回合重拉机制）。`session_summaries`（extraction 背景摘要）语义不动。

## 6. 子进程接线（runtime-entry.ts）

### 6.1 compact 工具改造（P1）

- 工具 schema：`summary` 参数删除，改可选 `note`（压缩动机备注，仅入审计）；描述改为「触发系统级上下文压缩（结构化摘要由专用链路生成，无需你提供总结）」。
- 执行体（inline 分支重写）：
  1. 尾部选择：从 messages 末尾向前按 `COMPACTION_KEEP_TOKENS` 预算保留 verbatim（至少保留当前 user 消息与 mandate；保护最近一轮完整回合）
  2. head 序列化（serialize.ts）+ 读 prior（子进程无 DB——prior 经 compaction:request 由主进程回填：请求不带 prior，主进程读表合并后生成）
  3. IPC `compaction:request` → 等 `compaction:result`
  4. 成功：`messages = [system, user('[历史压缩摘要]\n' + summary + '\n\n' + tailDirective), ...尾部 verbatim]`；tailDirective 沿用 T4 双态（有 user 挂靠→「请继续完成」；无→「输出简短总结后结束本轮」）；wrapUpMode 判定复用
  5. 失败：tool result 报错（「压缩失败：…，可重试」），messages 原样不动
- budget 计 1 次；segment/task_complete 逻辑不涉。

### 6.2 自动阈值压缩（P4）

每轮构建 LLM 请求前（refreshSystem 之后）：

```
if (config.contextWindow > 0 && !wrapUpMode) {
  const est = estimateConversation({ system: messages[0].content, messages, tools: chatTools })
  if (est > config.contextWindow - Math.max(config.outputTokens, COMPACTION_BUFFER_TOKENS)
      && est > COMPACTION_MIN_TRIGGER) {
    执行与 6.1 相同的压缩流程（不经 LLM 决策）；
    压缩后：hasPendingUserTodos → 注入 synthetic user
      「[系统] 上下文已自动压缩。若仍有未完成的用户请求步骤请继续；否则输出总结并停下。」
      无 → wrapUpMode = true（下一轮无工具，机械收口）
  }
}
```

窗口未知（0）→ 跳过检查（fail-safe）。task 域（currentTaskId 非空）跳过 auto（非目标），仅 NL 工具路径可用。

### 6.3 >30 提示退役

`buildCompactSuggestHint` 与 `:457-463` 注入块删除；`copy-neutral.test.ts` 相应用例改为锁「新描述不含『总结』书写义务」。（auto 阈值取代自觉提示。）

## 7. 溢出恢复（P6）

chatStream catch 路径中，错误信息匹配 `/context|token.*(limit|exceed)|maximum.*length|too (long|many)/i` 且：
- 本回合未恢复过（`overflowRecovered` flag，回合级）
- est > MIN_TRIGGER（有可压内容）

→ 执行压缩流程 → **重放本轮授权**：把 `mandate.userBody` + steers 重新 push 为 user 消息 → continue loop。二次溢出 → 按原错误路径终止（防循环）。abort 分支语义不变。

## 8. prune 微压缩（P5）

`getConversationContext` 的消息映射层：非最近一轮（created_at 距最新一条超过一轮间隔，简化为「除最后一条 user 消息所在回合外」）的 tool result 文本 > 2000 字符 → 截断加 `[truncated]`。纯拉取时变换，零持久化。

## 9. 错误处理汇总

| 路径 | 行为 |
|---|---|
| compaction:result 失败（NL 工具路径） | tool result 报错可重试，messages 原样 |
| auto 压缩失败 | 记 warn，本轮继续原 messages（宁可继续不阻塞回合）；下轮再试 |
| 溢出恢复压缩失败 | 按原溢出错误终止回合 |
| 窗口未知 | auto 路径整体禁用；显式路径不受限 |
| IPC 超时（10s） | 视为失败，按上两行处理 |
| /compact 命令失败 | 沿用现有显式 throw |

## 10. 测试策略（momo-test-rules）

- 单元：model-catalog 匹配表 / estimateTokens 中文系数（中英混合样例锁定）/ buildCompactionPrompt 模板与合并指令 / serialize / resolveModelLimits 优先级（用户列 > 目录 > null）/ getConversationContext 收缩+注入+prune（真 DB harness）
- 子进程 loop（fake-LLM harness 扩展，沿 compact-wrapup 模式）：auto 阈值触发与不触发 / 压缩后双态（复用 wrapUpMode 断言）/ 溢出恢复一次+防循环 / compact 工具新 schema（无 summary 参数）
- IPC 契约：compaction:request/result 形状锁
- 回归：既有 compact-wrapup 6 用例需适配（工具 schema 变化）但断言意图不弱化；copy-neutral 更新；全量套件绿

## 11. 验收标准

1. 长会话（构造超预算对话）请求前自动压缩，摘要为结构化五节格式，尾部原文保留 verbatim
2. 压缩后跨回合：covered_until 前历史不再拉取，摘要注入可见
3. 窗口未知模型：无 auto 压缩，NL/命令路径正常
4. 溢出错误恢复一次并重放授权
5. 旧工具结果拉取时截断
6. macOS 真机：`/compact` 命令产出结构化摘要 + 历史收缩生效 + 长任务自动压缩续跑

## 12. 实施切分（plan 输入）

| 任务 | 内容 | 依赖 |
|---|---|---|
| T1 | 窗口元数据全链（migration×2 + catalog + resolve + spawn 透传 + RuntimeConfig 字段 + 设置页编辑） | — |
| T2 | 纯函数包：token-estimate + compaction prompt + serialize（+单测） | — |
| T3 | 主进程 CompactionService + IPC 桥 + /compact 命令迁移 | T2 |
| T4 | getConversationContext 收缩 + 摘要注入 + prune | T1（表）, T3（写入方） |
| T5 | 子进程接线：compact 工具改造 + auto 阈值 + 双态续行 + >30 退役 | T1, T2, T3 |
| T6 | 溢出恢复 + 重放 + 防循环 | T5 |
| T7 | 全量回归 + 验收对照 | 全部 |
