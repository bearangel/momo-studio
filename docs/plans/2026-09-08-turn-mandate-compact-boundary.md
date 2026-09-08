# Turn Mandate 与 compact 边界 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 chat 回合意图对象（mandate）与产品文案中性化——用户发起压缩 = 确定性回合终点，agent 自压缩按 user-source todo 双态续跑/收口，持久副作用软门禁。

**Architecture:** mandate 作为 system prompt 尾段由 runtime 每轮重写（跨压缩存活）；compact 分支读 todo store 判定双态，收尾态下一轮 `tools=undefined` 机械终止；`/compact` 斜杠命令走独立 IPC 由主进程确定性执行（摘要 upsert `session_summaries`，不经 LLM agent 回合）。

**Tech Stack:** Electron 主进程（CommonJS）+ React renderer（ESM）+ better-sqlite3 + vitest。

**Spec:** `docs/specs/2026-09-08-turn-mandate-compact-boundary-design.md`（本计划的唯一需求来源，冲突时以 spec 为准）

## Global Constraints

- Node 20 LTS：所有命令前先 `nvm use 20`（容器默认 Node 26 会破坏 better-sqlite3）
- pnpm 统一 `npx pnpm@9.0.0`；单测命令形态：`cd electron && npx pnpm@9.0.0 vitest run tests/<path>`
- TypeScript strict：禁止 `any` / `as any` / `@ts-ignore`（ESLint `no-explicit-any: error`）
- 全部注释中文；Conventional Commits（`feat:` / `docs:` / `test:` / `refactor:`）
- 单测位置：主进程测试集中在 `electron/tests/`（镜像 `src/` 结构）；renderer 测试贴源 colocated
- 验收红线：agent 运行时路径（runtime-entry / builtin-tools / prompt-hints 的注入与工具输出文案）不得出现「继续工作」字面串
- 每任务收尾跑 `npx pnpm@9.0.0 typecheck`（根目录，双 workspace）

---

### Task 1: todo `source` 挂靠字段与 `hasPendingUserTodos` 判定

**Files:**
- Modify: `electron/src/main/agent/tools/todo-types.ts`
- Modify: `electron/src/main/agent/tools/todo-tools.ts`
- Test: `electron/tests/agent/tools/todo-tools.test.ts`（已存在则扩展，不存在则新建）

**Interfaces:**
- Consumes: 无（基础任务）
- Produces（后续任务依赖的精确签名）:
  - `TodoItem.source: 'user' | 'agent'`（必填字段，解析层缺省 `'agent'`）
  - `hasPendingUserTodos(streamSessionId: string): boolean`（todo-tools.ts 导出）
  - `__setTodosForTest(streamSessionId: string, items: TodoItem[]): void`（测试种子钩子）

- [ ] **Step 1: 写失败测试**

在 `electron/tests/agent/tools/todo-tools.test.ts` 追加（文件不存在则新建，头部按仓库测试惯例注明中文文件注释）：

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { TodoTools, hasPendingUserTodos, __setTodosForTest } from '../../../src/main/agent/tools/todo-tools';
import type { ToolContext } from '../../../src/main/agent/tools/types';
import type { TodoItem } from '../../../src/main/agent/tools/todo-types';
import type { StreamChunk } from '../../../src/main/agent/stream-chunk';

/** 最小 ToolContext 桩——todo 工具只消费 streamSessionId / roomId / sendStreamChunk */
function mkCtx(streamSessionId: string): ToolContext {
  return {
    wsFs: {} as ToolContext['wsFs'],
    workspaceId: 'ws-test',
    workspaceDir: '/tmp',
    skillRegistry: {} as ToolContext['skillRegistry'],
    streamSessionId,
    parentStreamSessionId: undefined,
    roomId: 'room-test',
    sendStreamChunk: (_chunk: StreamChunk) => {},
    permissionConfig: { allowedTools: undefined, deniedTools: undefined },
    creatorUserId: 'owner',
  };
}

describe('todo source 挂靠', () => {
  const tools = new TodoTools();
  const sid = 'stream-source-test';

  beforeEach(() => __setTodosForTest(sid, []));

  it('source 缺省落 agent（保守取向：未标注不算 user 挂靠）', async () => {
    const out = await tools.execute('todowrite', {
      todos: [{ subject: '步骤A', status: 'pending' }],
    }, mkCtx(sid));
    expect(out).toContain('[a] 步骤A');
    expect(hasPendingUserTodos(sid)).toBe(false);
  });

  it('source=user 的 pending/in_progress 项计入挂靠；completed 不计', async () => {
    await tools.execute('todowrite', {
      todos: [
        { subject: '用户要求的主任务', status: 'in_progress', source: 'user' },
        { subject: '已完成的用户步骤', status: 'completed', source: 'user' },
        { subject: 'agent 自发项', status: 'pending', source: 'agent' },
      ],
    }, mkCtx(sid));
    expect(hasPendingUserTodos(sid)).toBe(true);
    await tools.execute('todowrite', {
      todos: [{ subject: '已完成的用户步骤', status: 'completed', source: 'user' }],
    }, mkCtx(sid));
    expect(hasPendingUserTodos(sid)).toBe(false);
  });

  it('source 非法值抛错（沿 status 校验同款错误风格）', async () => {
    await expect(
      tools.execute('todowrite', {
        todos: [{ subject: 'x', status: 'pending', source: 'wild' }],
      }, mkCtx(sid)),
    ).rejects.toThrow('source');
  });

  it('回显标注 [u]/[a]', async () => {
    const out = await tools.execute('todowrite', {
      todos: [
        { subject: 'U项', status: 'pending', source: 'user' },
        { subject: 'A项', status: 'pending' },
      ],
    }, mkCtx(sid));
    expect(out).toContain('[ ] [u] U项');
    expect(out).toContain('[ ] [a] A项');
  });
});
```

注：若 `ToolContext` 实际必填字段与桩不符，以 `electron/src/main/agent/tools/types.ts` 为准补齐（typecheck 会指出）；`permissionConfig` 形状以 types.ts 为准。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/todo-tools.test.ts
```
预期：FAIL——`source` 不在类型上 / `hasPendingUserTodos` 未导出。

- [ ] **Step 3: 最小实现**

`todo-types.ts`：

```typescript
/** 单条任务项。id 由 todo-tools 内部 randomUUID() 生成。 */
export interface TodoItem {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
  /**
   * 挂靠来源（turn mandate 契约）：'user'=本轮用户请求直接要求的步骤；
   * 'agent'=agent 自发扩展。缺省按 'agent' 解析（保守取向：未标注不算授权挂靠，
   * spec §5.3）。renderer 端为兼容旧 chunk 载荷可按可选字段消费。
   */
  source: 'user' | 'agent';
}
```

`todo-tools.ts` 修改三处：

```typescript
// ① 文件头导出区追加测试种子钩子（沿 __resetExtractionStateForTest 惯例）
/** 测试用：直接播种指定流式会话的 todo 表（绕过 execute 全量替换协议） */
export function __setTodosForTest(streamSessionId: string, items: TodoItem[]): void {
  todoStore.set(streamSessionId, items);
}

/** mandate 判定（spec §5.2）：是否存在未完成的 user 挂靠项 */
export function hasPendingUserTodos(streamSessionId: string): boolean {
  return (todoStore.get(streamSessionId) ?? []).some(
    (t) => t.status !== 'completed' && t.source === 'user',
  );
}
```

```typescript
// ② execute 的逐项校验内（status 校验之后、长度校验之前）追加 source 解析
const rawSource = (item as { source?: unknown }).source;
let source: TodoItem['source'];
if (rawSource === undefined) {
  source = 'agent'; // 缺省保守取向（spec §5.3）
} else if (rawSource === 'user' || rawSource === 'agent') {
  source = rawSource;
} else {
  throw new Error(
    `todos[${i}].source 必须是 user/agent，实际: ${String(rawSource)}`,
  );
}
return { id: randomUUID(), subject, status, source };
```

```typescript
// ③ formatSummary 行加标注
const mark = t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '>' : ' ';
const src = t.source === 'user' ? 'u' : 'a';
return `${i + 1}. [${mark}] [${src}] ${t.subject}`;
```

同时更新 getDefs 中 todowrite 描述（spec §5.6 #8a）：

```typescript
description:
  '管理任务列表（全量替换）。为「本轮用户请求直接要求」的步骤标 source=user——这是' +
  '系统判定你本轮授权范围的依据；你自己扩展的可选工作标 source=agent。收到改变方向或' +
  '要求停止的用户补充时，必须先更新本表使其反映用户当前意图。复杂任务（≥3 步骤）建议先建表。',
// inputSchema.todos.items.properties 追加：
//   source: { type: 'string', enum: ['user', 'agent'], description: '挂靠来源（缺省 agent）' }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/todo-tools.test.ts
```
预期：PASS。

- [ ] **Step 5: typecheck + 提交**

```bash
npx pnpm@9.0.0 typecheck
GIT_MASTER=1 git add electron/src/main/agent/tools/todo-types.ts electron/src/main/agent/tools/todo-tools.ts electron/tests/agent/tools/todo-tools.test.ts
GIT_MASTER=1 git commit -m "feat: todo source 挂靠字段与 hasPendingUserTodos 判定（turn mandate 基础）"
```

---

### Task 2: 文案中性化第一批 + 文案回归锁

**Files:**
- Modify: `electron/src/main/agent/prompt-hints.ts`（新增 `buildCompactSuggestHint`；dispatchHint 措辞）
- Modify: `electron/src/main/agent/runtime-entry.ts:457-463`（改用新函数）
- Modify: `electron/src/main/agent/builtin-tools.ts`（compact / task_complete 描述）
- Modify: `electron/src/main/agent/tools/memory-tools.ts`（memory_save 描述）
- Test: `electron/tests/agent/copy-neutral.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `buildCompactSuggestHint(msgCount: number): string`（prompt-hints.ts 导出；Task 4 之前 runtime-entry 即改用它）

- [ ] **Step 1: 写失败测试**

`electron/tests/agent/copy-neutral.test.ts`：

```typescript
// 文案回归锁（spec §5.6 / §11-3）：锁死中性化关键串，防止回退到「继续工作」类前进祈使句。
import { describe, it, expect } from 'vitest';
import { buildCompactSuggestHint, formatDispatchHint } from '../../src/main/agent/prompt-hints';
import { getBuiltinLoopToolDefs } from '../../src/main/agent/builtin-tools';
import { MemoryTools } from '../../src/main/agent/tools/memory-tools';

describe('文案中性化回归锁', () => {
  it('>30 条压缩建议不含「继续工作」，含授权状态判定引导', () => {
    const hint = buildCompactSuggestHint(36);
    expect(hint).toContain('36');
    expect(hint).not.toContain('继续工作');
    expect(hint).toContain('决定继续或收尾');
  });

  it('dispatch 教学限定当前任务语境', () => {
    const hint = formatDispatchHint({
      isLeader: true,
      subAgents: [{ slug: 'coder', assignmentId: 'a1', description: '编码' }],
    } as Parameters<typeof formatDispatchHint>[0]);
    expect(hint).toContain('当前任务');
    expect(hint).not.toContain('不要全部自己做');
  });

  it('compact 描述含两节模板且不含无条件继续指令', () => {
    const compact = getBuiltinLoopToolDefs().find((t) => t.name === 'compact')!;
    expect(compact.description).toContain('用户指令');
    expect(compact.description).toContain('agent 备忘');
    expect(compact.description).not.toContain('后续工作基于总结继续');
  });

  it('task_complete 的 nextStep 声明非新任务授权', () => {
    const tc = getBuiltinLoopToolDefs().find((t) => t.name === 'task_complete')!;
    expect(JSON.stringify(tc.inputSchema)).toContain('不是新任务授权');
  });

  it('memory_save 描述含证据核实约束', () => {
    const save = new MemoryTools().getDefs().find((t) => t.name === 'memory_save')!;
    expect(save.description).toContain('核实原始证据');
  });
});
```

注：`formatDispatchHint` 参数为 `RuntimeConfig`——测试传最小对象 + `as Parameters<...>[0]` 断言会触碰 strict；改为构造完整 `RuntimeConfig` 最小实例（以 `electron/src/main/agent/runtime-config.ts` 的接口为准，typecheck 校验）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/copy-neutral.test.ts
```
预期：FAIL（函数不存在 / 文案不匹配）。

- [ ] **Step 3: 实现**

`prompt-hints.ts` 追加：

```typescript
/**
 * >30 条历史时的压缩建议（spec §5.6 #1）：只建议动作，不内嵌前进指令——
 * 压缩后的续跑/收尾由 compact 分支按 mandate 判定（runtime-entry）。
 */
export function buildCompactSuggestHint(msgCount: number): string {
  return (
    `[系统提示] 对话历史已较长（${msgCount} 条消息）。如影响工作质量，可调用 compact ` +
    '工具压缩上下文（写一份 ≥200 字符的总结）。压缩后依据本轮授权状态决定继续或收尾。'
  );
}
```

`runtime-entry.ts:457-463` 替换为：

```typescript
    if (messages.length > 30 && round > 0) {
      messages.push({ role: 'system', content: buildCompactSuggestHint(messages.length) });
    }
```

（import 区补 `buildCompactSuggestHint`。）

`prompt-hints.ts` dispatchHint 的「主动拆分原则」条目改写（保持结构，替换措辞）：

```typescript
**拆分原则（限当前任务）**：
1. **当前任务**涉及 ≥3 个文件、多个模块、或含可并行子任务时，优先 dispatch 给合适的子 agent
2. 每个子任务描述清晰、自包含（不要让子 agent 猜测上下文）
3. 子 agent 完成后会有回执，PM 整合结果再回复用户
4. 简单请求（<3 文件 / 单步）直接完成，不要为拆分而拆分
5. 子任务相互独立时，在**同一次回复中连续发出多个 dispatch 工具调用**并行执行，不要拆到多轮（多轮 = 串行等待）
```

`builtin-tools.ts` compact 描述替换为：

```typescript
description:
  '压缩对话历史。当多轮对话累积导致上下文过长（>20 轮或接近模型上下文上限）时调用。' +
  '总结必须分两节：【用户指令】——本轮用户消息与中途补充中尚未完成的要求，逐条列出（无则写「无」）；' +
  '【agent 备忘】——你自己的观察与可选想法，标注「非用户指令，勿据此发起工作」。' +
  '压缩后系统将依据「用户指令」节的未完成项自动决定继续或收尾。总结 ≥200 字符。',
```

task_complete 的 nextStep 描述与工具描述替换：

```typescript
nextStep: {
  type: 'string',
  description: '下一段的内容提示（仅用于分段连贯性，不是新任务授权；可选）',
},
// 工具 description 中「然后继续输出下一段」保留，但删除任何「继续工作」字样；
// :611/:623 的输出文案在 Task 4 一并处理（本任务仅改声明）。
```

`memory-tools.ts` memory_save 描述追加一句：

```typescript
+ '仅在用户请求或明确受益时保存；记录系统性结论（如产品缺陷判定）前必须先核实原始工具调用证据。'
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/copy-neutral.test.ts
```
预期：PASS。

- [ ] **Step 5: 全量回归 + 提交**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/
npx pnpm@9.0.0 typecheck
GIT_MASTER=1 git add electron/src/main/agent/prompt-hints.ts electron/src/main/agent/runtime-entry.ts electron/src/main/agent/builtin-tools.ts electron/src/main/agent/tools/memory-tools.ts electron/tests/agent/copy-neutral.test.ts
GIT_MASTER=1 git commit -m "feat: 文案中性化第一批——压缩建议/拆分教学/工具描述去前进祈使句（spec §5.6）"
```

---

### Task 3: mandate 注入与每轮重写

**Files:**
- Modify: `electron/src/main/agent/prompt-hints.ts`
- Modify: `electron/src/main/agent/runtime-entry.ts`（`:295-306` 装配区 + `:441-455` steer drain 区）
- Test: `electron/tests/agent/mandate-hint.test.ts`（新建）

**Interfaces:**
- Consumes: `hasPendingUserTodos`（Task 1）
- Produces: `buildMandateHint(opts: { userBody: string; steers: string[]; streamSessionId: string }): string`

- [ ] **Step 1: 写失败测试**

`electron/tests/agent/mandate-hint.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { buildMandateHint } from '../../src/main/agent/prompt-hints';
import { __setTodosForTest } from '../../src/main/agent/tools/todo-tools';
import type { TodoItem } from '../../src/main/agent/tools/todo-types';

function todo(subject: string, status: TodoItem['status'], source: TodoItem['source']): TodoItem {
  return { id: `id-${subject}`, subject, status, source };
}

describe('buildMandateHint', () => {
  beforeEach(() => __setTodosForTest('sid-m', []));

  it('含用户消息原文与授权约束；无补充无未完成项时两节均显式标注', () => {
    const hint = buildMandateHint({ userBody: '帮我重构X模块', steers: [], streamSessionId: 'sid-m' });
    expect(hint).toContain('帮我重构X模块');
    expect(hint).toContain('本轮用户授权');
    expect(hint).toContain('无');
    expect(hint).toContain('勿据此发起新工作');
  });

  it('中途补充与未完成 user 项实时反映', () => {
    __setTodosForTest('sid-m', [todo('主任务', 'in_progress', 'user'), todo('扩展', 'pending', 'agent')]);
    const hint = buildMandateHint({
      userBody: '帮我重构X模块',
      steers: ['顺便把第二个任务改成pwd'],
      streamSessionId: 'sid-m',
    });
    expect(hint).toContain('顺便把第二个任务改成pwd');
    expect(hint).toContain('主任务');
    expect(hint).not.toContain('扩展'); // agent 项不进「用户请求的未完成项」节
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/mandate-hint.test.ts
```
预期：FAIL——`buildMandateHint` 未导出。

- [ ] **Step 3: 实现**

`prompt-hints.ts` 追加（import `getTodosForSession` 自 todo-tools——已有导出）：

```typescript
import { getTodosForSession } from '../agent/tools/todo-tools';

/**
 * Turn mandate 尾段（spec §2）：本轮用户授权的结构化呈现。
 * 每轮重写 messages[0] 时调用——「中途补充」与「未完成项」保持实时。
 * 未完成项只列 source=user 且非 completed 的条目（agent 自发项不进授权节）。
 */
export function buildMandateHint(opts: {
  userBody: string;
  steers: string[];
  streamSessionId: string;
}): string {
  const pending = getTodosForSession(opts.streamSessionId).filter(
    (t) => t.status !== 'completed' && t.source === 'user',
  );
  const lines: string[] = ['## 本轮用户授权（mandate）'];
  lines.push(`- 用户消息：「${opts.userBody}」`);
  if (opts.steers.length > 0) {
    lines.push(`- 中途补充：${opts.steers.map((s) => `「${s}」`).join(' ')}`);
  }
  lines.push(
    pending.length > 0
      ? `- 用户请求的未完成项：\n${pending.map((t) => `  - [${t.status === 'in_progress' ? '>' : ' '}] ${t.subject}`).join('\n')}`
      : '- 用户请求的未完成项：无',
  );
  lines.push(
    '约束：以上是你本轮被授权完成的工作范围。「agent 备忘」类信息（你自己想到的可选方向）' +
    '不属于授权——除非用户在本轮明确要求，否则不要据此发起新工作；需要时先向用户提出。' +
    '中途补充与原始消息同等授权效力，可扩大、修改、撤销原授权；收到改变方向或要求停止的' +
    '补充时，必须先用 todowrite 同步更新 user-source 待办项，然后再继续。',
  );
  return `\n\n${lines.join('\n')}`;
}
```

`runtime-entry.ts` 装配区（`:295-306`）改造：

```typescript
  // static 段一次组装；mandate 尾段每轮重写（spec §2「每轮重写」）
  const staticSystem = ctx.systemPrompt + budgetHint + dispatchHint + taskHint + pinnedMem.hint;
  const mandate = { userBody: currentBody, steers: [] as string[] };
  const refreshSystem = (): void => {
    messages[0] = {
      role: 'system',
      content: staticSystem + buildMandateHint({ ...mandate, streamSessionId }),
    };
  };

  const messages: LLMMessage[] = [
    { role: 'system', content: '' }, // 占位，refreshSystem 立即填充
    ...convMessages,
    { role: 'user', content: currentBody },
  ];
  refreshSystem();
```

steer drain 区（`:445-455`）追加 mandate 维护与重写：

```typescript
    let drained = false;
    while (pendingSteers.length > 0) {
      const steer = pendingSteers.shift()!;
      mandate.steers.push(steer);
      messages.push({ role: 'user', content: `[用户中途补充] ${steer}` });
      drained = true;
    }
    if (drained) {
      wrapUpMode = false; // 新指令优先于收尾（spec §5.1，Task 4 落地该变量）
      refreshSystem();
    }
```

（`wrapUpMode` 变量 Task 4 声明；本任务先以注释占位说明并在 Task 4 接线——**为保持本任务可独立编译**，本任务仅实现 `drained → refreshSystem()`，`wrapUpMode = false` 行留给 Task 4。）
同时在每轮 `for` 循环顶部（round 递增后、steer drain 前）调用 `refreshSystem()`。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/mandate-hint.test.ts
```
预期：PASS。

- [ ] **Step 5: typecheck + 提交**

```bash
npx pnpm@9.0.0 typecheck
GIT_MASTER=1 git add electron/src/main/agent/prompt-hints.ts electron/src/main/agent/runtime-entry.ts electron/tests/agent/mandate-hint.test.ts
GIT_MASTER=1 git commit -m "feat: turn mandate 注入与 system prompt 每轮重写（跨压缩存活的授权边界）"
```

---

### Task 4: compact 双态与确定性收尾轮

**Files:**
- Modify: `electron/src/main/agent/runtime-entry.ts`（compact 分支 `:631-694`；tools 装配行 `:472`；循环顶部）
- Test: `electron/tests/agent/compact-wrapup.test.ts`（新建）

**Interfaces:**
- Consumes: `hasPendingUserTodos`（Task 1）、`buildMandateHint`/`refreshSystem`（Task 3）
- Produces: 无对外新接口；行为契约（compact 后 `tools === undefined` 且回合终止）由测试锁定

- [ ] **Step 1: 写失败测试**

`electron/tests/agent/compact-wrapup.test.ts`（fake-LLM harness 驱动真实 runChatLoop；mock 模块边界为 `llm-provider` 与 `memory`）：

```typescript
// compact 双态回归锁（spec §7-2）：真实 runChatLoop + fake LLM。
// momo-test-rules：不 mock 被测单元内部，只 mock 外部副作用（LLM / 记忆 provider）。
import { describe, it, expect, beforeEach, vi } from 'vitest';

// —— 捕获每轮 LLM 请求的 messages/tools，按剧本回放 ——
type Captured = { messages: unknown[]; tools: unknown };
const captured: Captured[] = [];
type Scripted = { text?: string; toolCall?: { name: string; arguments: Record<string, unknown> } };
let script: Scripted[] = [];

vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: () => ({
    chatStream: async function* (_messages: unknown[], tools: unknown) {
      captured.push({ messages: _messages, tools });
      const step = script.shift() ?? { text: '(完)' };
      if (step.toolCall) {
        yield { type: 'tool_use' as const, toolCall: { id: `call-${captured.length}`, name: step.toolCall.name, arguments: step.toolCall.arguments } };
        yield { type: 'done' as const, finishReason: 'tool_use' as const };
      } else {
        yield { type: 'thinking' as const, content: '' };
        yield { type: 'text' as const, delta: step.text ?? '' };
        yield { type: 'done' as const, finishReason: 'stop' as const };
      }
    },
  }),
}));

vi.mock('../../src/main/agent/memory', () => ({
  getMemoryProvider: () => ({
    getConversationContext: async () => ({ messages: [] }),
    getPinnedContext: async () => ({ hint: '', truncatedCount: 0, pinnedIds: [] }),
    getTaskContext: async () => null,
  }),
}));

import { runChatLoop } from '../../src/main/agent/runtime-entry';
import { __setTodosForTest } from '../../src/main/agent/tools/todo-tools';
import type { TodoItem } from '../../src/main/agent/tools/todo-types';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';
import type { RuntimeContext } from '../../src/main/agent/runtime-entry';
import { SkillRegistry } from '../../src/main/skill/registry';

const SUMMARY = 'x'.repeat(80); // ≥50 字符过 compact 校验

function mkConfig(): RuntimeConfig {
  // 以 runtime-config.ts 的 RuntimeConfig 接口为准的最小实例；typecheck 保证字段完整
  return {
    workspaceId: 'ws-t',
    workspaceDir: '/tmp',
    modelName: 'test-model',
    llmApiKey: 'k',
    maxToolCalls: 10,
    skills: [],
    subAgents: [],
    isLeader: false,
    allowedTools: undefined,
    deniedTools: undefined,
  } as RuntimeConfig;
}

function mkCtx(): RuntimeContext {
  return {
    wsFs: {} as RuntimeContext['wsFs'],
    skillRegistry: new SkillRegistry(),
    tools: [],
    systemPrompt: 'BASE',
    workspaceId: 'ws-t',
    workspaceDir: '/tmp',
    roomId: 'room-t',
    streamSessionId: 'sid-wrap',
    sendStreamChunk: () => {},
    toolModules: [],
    creatorUserId: 'owner',
  };
}

/** stream chunk 的 text 增量字段名以 llm-provider 实际 delta 类型为准（text|delta）；
 *  若 typecheck 报错，按 provider 类型修正字段名后重跑。 */

describe('compact 双态（chat 路径）', () => {
  const sid = 'sid-wrap';

  function userTodo(subject: string): TodoItem {
    return { id: `u-${subject}`, subject, status: 'in_progress', source: 'user' };
  }

  beforeEach(() => {
    captured.length = 0;
    __setTodosForTest(sid, []);
    vi.clearAllMocks();
  });

  it('无 user 挂靠 → 压缩后下一轮 tools=undefined，回合终止（收尾模式）', async () => {
    script = [
      { toolCall: { name: 'compact', arguments: { summary: SUMMARY } } },
      { text: '已按要求压缩，本轮结束。' },
    ];
    const out = await runChatLoop('room-t', '压缩上下文', mkConfig(), mkCtx(), undefined, undefined, sid);
    expect(captured.length).toBe(2);
    expect(captured[1]!.tools).toBeUndefined(); // 收尾轮无工具
    expect(out).toContain('本轮结束');
  });

  it('有 user 挂靠 → 压缩后工具正常（续跑模式），mandate 段跨压缩存活', async () => {
    __setTodosForTest(sid, [userTodo('重构X模块-步骤1')]);
    script = [
      { toolCall: { name: 'compact', arguments: { summary: SUMMARY } } },
      { text: '继续完成重构。' },
    ];
    const out = await runChatLoop('room-t', '帮我重构X模块', mkConfig(), mkCtx(), undefined, undefined, sid);
    expect(captured.length).toBe(2);
    expect(Array.isArray(captured[1]!.tools)).toBe(true);
    expect(out).toContain('继续完成重构');
    // 压缩后 messages[0] 仍含 mandate（system 保留）
    const sys = (captured[1]!.messages as Array<{ role: string; content: string }>)[0]!;
    expect(sys.role).toBe('system');
    expect(sys.content).toContain('本轮用户授权');
  });

  it('task 域（currentTaskId 非空）compact 行为不变：工具正常、不进收尾', async () => {
    const cfg = { ...mkConfig(), currentTaskId: 'T-001' };
    script = [
      { toolCall: { name: 'compact', arguments: { summary: SUMMARY } } },
      { text: '任务继续。' },
    ];
    await runChatLoop('room-t', '任务正文', cfg, mkCtx(), undefined, undefined, sid);
    expect(Array.isArray(captured[1]!.tools)).toBe(true);
  });
});
```

注：`script`/`captured` 为模块级，`vi.mock` 工厂引用需 hoist 安全（工厂内不引用外层变量——上面工厂只闭包 `captured`/`script`，vitest 的 `vi.mock` hoisting 要求工厂无外部依赖；若 lint 报 hoist 错误，改用 `vi.hoisted(() => ({ captured: [], script: [] }))` 承载两个引用再在工厂与用例间共享）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/compact-wrapup.test.ts
```
预期：FAIL——现状压缩后三处「继续工作」且工具照常（第 1/3 用例断言 `tools` 为 undefined 失败）。

- [ ] **Step 3: 实现（runtime-entry.ts compact 分支重写）**

变量区（`segmentCount` 附近）声明：

```typescript
  // turn mandate（spec §5.1）：收尾模式标记——置位后下一轮不传 tools，机械终止回合
  let wrapUpMode = false;
```

tools 装配行（`:472`）改为：

```typescript
    const tools = wrapUpMode || budgetRemaining <= 0 ? undefined : chatTools;
```

steer drain 的 `drained` 分支补一行（Task 3 预留位）：

```typescript
    if (drained) {
      wrapUpMode = false; // 新指令优先于收尾（spec §5.1）
      refreshSystem();
    }
```

compact 分支（`:631-694`）整体替换为：

```typescript
      // turn mandate（spec §5.1）：仅顶层 chat 路径做双态判定；task 域 / dispatch
      // 子路径（parentStreamSessionId 非空）维持「压缩后继续当前任务」语义。
      if (tc.name === 'compact') {
        const summary = typeof tc.arguments.summary === 'string' ? tc.arguments.summary : '';
        if (!summary || summary.length < 50) {
          // ……过短拒绝分支保持原样（:636-651），不改动 ……
        }

        const oldMsgCount = messages.length;
        const mandateGated = parentStreamSessionId == null && !config.currentTaskId;
        const pendingUser = mandateGated && hasPendingUserTodos(streamSessionId);
        wrapUpMode = mandateGated && !pendingUser;

        const tailDirective = pendingUser
          ? '[历史已压缩。本轮仍有用户请求的未完成工作，请继续完成]'
          : mandateGated
            ? '[本轮用户请求已无未完成项，请输出简短总结后结束本轮，不要开始新工作]'
            : '[历史已压缩。请基于总结继续当前任务]';
        const systemMsg = messages[0]!;
        messages.length = 0;
        messages.push(systemMsg);
        messages.push({ role: 'user', content: `[历史对话总结]\n${summary}\n\n${tailDirective}` });

        // ……sendStreamChunk（tool_call / tool_result）两段保持原结构，result 文案改为：……
        // `上下文已压缩：${oldMsgCount} 条消息 → 1 条总结（${summary.length} 字符）。` +
        // (pendingUser ? `仍有 ${K} 项用户待办，请继续完成。`
        //  : mandateGated ? '无用户待办，请输出总结收尾。'
        //  : '请基于总结继续当前任务。')
        // 其中 K = getTodosForSession(streamSessionId).filter(...).length

        // 回填 LLM：保留一条 tool result（删除原第二条「请继续基于总结工作」消息，spec §5.6 #4）
        messages.push({ role: 'assistant', content: '', toolCalls: [tc] });
        messages.push({
          role: 'tool',
          content: `上下文已压缩（${oldMsgCount} → 2 条消息）。`,
          toolCallId: tc.id,
        });
        refreshSystem(); // system prompt 重建（含 mandate，spec §2）
        toolCallCount++;
        budgetRemaining--;
        ti++; continue;
      }
```

（实现时以上注释段展开为完整代码——`K` 的取数逻辑与 `hasPendingUserTodos` 同谓词，抽本地 `pendingUserItems()` 闭包复用，勿复制粘贴两份过滤条件。）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/compact-wrapup.test.ts
```
预期：3 用例 PASS。

- [ ] **Step 5: agent 域全量回归 + 提交**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/
npx pnpm@9.0.0 typecheck
GIT_MASTER=1 git add electron/src/main/agent/runtime-entry.ts electron/tests/agent/compact-wrapup.test.ts
GIT_MASTER=1 git commit -m "feat: compact 双态——user 挂靠续跑/无挂靠收尾轮无工具机械终止（spec §5.1）"
```

---

### Task 5: 持久副作用软门禁

**Files:**
- Create: `electron/src/main/agent/tools/shared/mandate-warning.ts`
- Modify: `electron/src/main/agent/tools/task-tools.ts`（create_task 分支 `:549-557`）
- Modify: `electron/src/main/agent/tools/memory-tools.ts`（executeSave `:181-182`）
- Test: `electron/tests/agent/tools/scope-gate.test.ts`（新建）

**Interfaces:**
- Consumes: `hasPendingUserTodos`（Task 1）
- Produces: `SIDEEFFECT_UNLINKED_WARNING: string`（shared/mandate-warning.ts 导出）

- [ ] **Step 1: 写失败测试**

`electron/tests/agent/tools/scope-gate.test.ts`：

```typescript
// 软门禁回归锁（spec §5.3）：无 user 挂靠时 create_task / memory_save 附 warning，不阻断。
import { describe, it, expect, beforeEach } from 'vitest';
import { TaskTools } from '../../../src/main/agent/tools/task-tools';
import { __setTodosForTest } from '../../../src/main/agent/tools/todo-tools';
import { mkCtx } from './todo-tools.test'; // 复用 Task 1 的 ctx 桩（若未导出则在本文件复制）

vi.mock('../../../src/main/storage/tasks/repo', () => ({
  insertTask: (input: { title: string }) => ({
    id: 'T-900', status: 'assigned', recurrenceRule: null, ...input,
  }),
  transitionTaskStatus: vi.fn(),
}));
vi.mock('../../../src/main/task/executor', () => ({ notifyExecutor: vi.fn() }));
vi.mock('../../../src/main/p2p/task-broadcast', () => ({ broadcastLocalTaskSnapshot: vi.fn() }));
vi.mock('../../../src/main/memory', () => ({
  getMemoryProvider: () => ({
    saveMemory: async (input: { content: string }) => ({
      id: 'mem-1', kind: 'summary', content: input.content, pinned: false,
    }),
  }),
}));
// memory repo 的 getMemory（forget 用）与本测试无关，按需 mock

describe('副作用软门禁', () => {
  const sid = 'sid-gate';
  beforeEach(() => __setTodosForTest(sid, []));

  it('create_task 无挂靠 → TaskRow 顶层附 warning', async () => {
    const out = JSON.parse(
      await new TaskTools().execute('create_task', {
        title: '测试任务', assigneeAgentId: 'a1',
      }, { ...mkCtx(sid), workspaceId: 'ws-g', creatorUserId: 'owner' }),
    );
    expect(out.id).toBe('T-900');            // 未阻断
    expect(out.warning).toContain('未挂靠到本轮用户请求');
  });

  it('memory_save 无挂靠 → 返回串追加警告行', async () => {
    const { MemoryTools } = await import('../../../src/main/agent/tools/memory-tools');
    const out = await new MemoryTools().execute('memory_save', {
      kind: 'summary', content: '测试记忆内容',
    }, mkCtx(sid));
    expect(out).toContain('已保存记忆');
    expect(out).toContain('⚠');
  });
});
```

（`vi` 需在文件头 import；`mkCtx` 若 Task 1 测试未导出，则把桩函数复制到本文件——两处测试各自独立持有桩是可接受的重复。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/scope-gate.test.ts
```
预期：FAIL——无 warning。

- [ ] **Step 3: 实现**

`shared/mandate-warning.ts`（新建）：

```typescript
// 持久副作用软门禁文案（spec §5.3）——task-tools 与 memory-tools 共享，避免双份漂移。
export const SIDEEFFECT_UNLINKED_WARNING =
  '⚠ 本操作未挂靠到本轮用户请求（当前无 source=user 待办项）。若确属用户本轮请求范围，' +
  '请先用 todowrite 建立对应 user 待办；若属你自行发起的工作，请先向用户说明并获同意。' +
  '本警告不阻断操作。';
```

`task-tools.ts` create_task 分支（现有 `if (!hasDelegationTarget(input))` 之后追加）：

```typescript
        import { hasPendingUserTodos } from './todo-tools';
        import { SIDEEFFECT_UNLINKED_WARNING } from './shared/mandate-warning';
        // ……
        const result = await createTask(input);
        const noMandate = !hasPendingUserTodos(ctx.streamSessionId);
        if (!hasDelegationTarget(input)) {
          return JSON.stringify({ ...result, warning: NO_ASSIGNMENT_WARNING });
        }
        if (noMandate) {
          return JSON.stringify({ ...result, warning: SIDEEFFECT_UNLINKED_WARNING });
        }
        return JSON.stringify(result);
```

`memory-tools.ts` executeSave 返回处：

```typescript
    const entry = await getMemoryProvider().saveMemory(input);
    const base = `已保存记忆（id=${entry.id}，kind=${entry.kind}，常驻=${entry.pinned ? '是' : '否'}）`;
    // 软门禁（spec §5.3）：无 user 挂靠追加警告行，不阻断
    if (!hasPendingUserTodos(ctx.streamSessionId)) {
      return `${base}\n${SIDEEFFECT_UNLINKED_WARNING}`;
    }
    return base;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/scope-gate.test.ts tests/agent/tools/task-tools-delegation.test.ts
```
预期：PASS（含既有 delegation 回归——已有指派路径不受影响）。

- [ ] **Step 5: typecheck + 提交**

```bash
npx pnpm@9.0.0 typecheck
GIT_MASTER=1 git add electron/src/main/agent/tools/shared/mandate-warning.ts electron/src/main/agent/tools/task-tools.ts electron/src/main/agent/tools/memory-tools.ts electron/tests/agent/tools/scope-gate.test.ts
GIT_MASTER=1 git commit -m "feat: create_task/memory_save 软门禁——无 user 挂靠附 warning 不阻断（spec §5.3）"
```

---

### Task 6: `/compact` 主进程链路

**Files:**
- Modify: `electron/src/main/memory/extraction.ts`（导出 `resolveSessionLlm`；抽取 `upsertSessionSummary`）
- Modify: `electron/src/main/agent/agent-runner.ts`（新增 `hasActiveForSession`）
- Modify: `electron/src/main/agent/runtime-registry.ts`（新增 `isSessionRunning`）
- Modify: `electron/src/main/im/session-service.ts`（新增 `handleSessionCommand`）
- Modify: `electron/src/main/im/session.ipc.handlers.ts`（注册 `session:command`）
- Test: `electron/tests/im/session-command.test.ts`（新建）

**Interfaces:**
- Consumes: 无（独立于 Task 3-5 的运行时改动）
- Produces:
  - `resolveSessionLlm(sessionId: string): Promise<LLMProvider | null>`（extraction.ts 导出）
  - `upsertSessionSummary(sessionId: string, summary: string, coveredUntil: number): void`（extraction.ts 导出）
  - `isSessionRunning(sessionId: string): boolean`（runtime-registry 导出）
  - `handleSessionCommand(input: { sessionId: string; command: string }): Promise<{ ok: true; message: string }>`（抛错语义沿 IPC：失败 throw Error，renderer invoke 捕获）——Task 7 的 renderer 依赖此通道名 `session:command`
  - IPC 通道：`session:command (sessionId: string, command: string)`

- [ ] **Step 1: 写失败测试**

`electron/tests/im/session-command.test.ts`：

```typescript
// /compact 主进程链路单测（spec §5.4）：全 mock 外部依赖，不落真库。
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/main/storage/sessions/repo', () => ({
  getSession: (id: string) => (id === 's1' ? { id: 's1', workspaceId: 'w1' } : null),
}));
vi.mock('../../src/main/storage/messages/repo', () => ({
  listMessagesBySession: () => Array.from({ length: 3 }, (_, i) => ({
    id: `m${i}`, sessionId: 's1', sender: i % 2 ? 'owner' : 'agent-x', body: `消息${i}`,
    eventType: 'm.room.message', createdAt: 1000 + i,
  })),
  insertMessage: vi.fn((m: { body: string }) => ({ ...m, id: 'm-new' })),
}));
vi.mock('../../src/main/im/session-ops', () => ({ getSessionMembersInfo: () => [] }));
vi.mock('../../src/main/agent/runtime-registry', () => ({ isSessionRunning: (id: string) => id === 'busy' }));
vi.mock('../../src/main/memory/extraction', () => ({
  resolveSessionLlm: async () => ({
    chat: async () => ({ content: '【用户指令】无\n【agent 备忘】测试摘要' }),
  }),
  upsertSessionSummary: vi.fn(),
  scheduleExtraction: vi.fn(),
  TRIGGER_TURN_INTERVAL: 20,
}));
vi.mock('../../src/main/p2p/sync', () => ({ broadcastLocalMessage: vi.fn() }));
// 其余 session-service 依赖（冲突检测 / #T 激活 / 命名）按模块路径 mock 为 no-op

import { handleSessionCommand } from '../../src/main/im/session-service';
import { upsertSessionSummary } from '../../src/main/memory/extraction';
import { insertMessage } from '../../src/main/storage/messages/repo';

describe('handleSessionCommand(compact)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path：摘要 upsert + 确认消息落库（不路由）', async () => {
    const r = await handleSessionCommand({ sessionId: 's1', command: 'compact' });
    expect(r.ok).toBe(true);
    expect(upsertSessionSummary).toHaveBeenCalledWith('s1', expect.stringContaining('测试摘要'), expect.any(Number));
    expect(insertMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1', body: expect.stringContaining('[系统] 会话已压缩'),
    }));
  });

  it('运行中回查拒绝', async () => {
    await expect(handleSessionCommand({ sessionId: 'busy', command: 'compact' }))
      .rejects.toThrow('正在执行中');
  });

  it('未知命令拒绝', async () => {
    await expect(handleSessionCommand({ sessionId: 's1', command: 'wat' }))
      .rejects.toThrow('未知命令');
  });
});
```

（mock 路径与 session-service 实际 import 逐一对照补齐——typecheck + 首跑报错即对齐清单。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/im/session-command.test.ts
```
预期：FAIL——`handleSessionCommand` 不存在。

- [ ] **Step 3: 实现**

`extraction.ts`：`resolveSessionLlm` 去掉模块私有（加 `export`）；`runExtractionInner` 中 `:196-205` 的 upsert SQL 抽为导出函数并在原位复用：

```typescript
/** 会话滚动摘要 upsert（extraction 与 /compact 命令共用；SQL 语义与 v2.2 一致） */
export function upsertSessionSummary(sessionId: string, summary: string, coveredUntil: number): void {
  getDb()
    .prepare(
      `INSERT INTO session_summaries (session_id, summary, covered_until, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         summary = excluded.summary,
         covered_until = excluded.covered_until,
         updated_at = excluded.updated_at`,
    )
    .run(sessionId, summary.slice(0, SUMMARY_MAX_LEN), coveredUntil, Date.now());
}
```

`agent-runtime.ts` AgentRunner 新增公有方法：

```typescript
  /** 该会话是否有进行中的活跃回合（/compact 运行中拒绝判定用，spec §5.4-0） */
  hasActiveForSession(sessionId: string): boolean {
    for (const active of this.activeTasks.values()) {
      if (active.executionSessionId === sessionId) return true;
    }
    return false;
  }
```

`runtime-registry.ts` 导出：

```typescript
/** 任一 runner 在该会话上有活跃回合（chat / task 执行统一判定） */
export function isSessionRunning(sessionId: string): boolean {
  for (const runner of agentRunners.values()) {
    if (runner.hasActiveForSession(sessionId)) return true;
  }
  return false;
}
```

`session-service.ts` 新增：

```typescript
import { isSessionRunning } from '../agent/runtime-registry';
import { resolveSessionLlm, upsertSessionSummary } from '../memory/extraction';

/** /compact 命令的消息拉取上限 */
const COMPACT_WINDOW = 200;

/**
 * 会话命令入口（spec §5.4）。v1 仅支持 compact。
 * 与 extraction 的差异：显式命令显式反馈——失败 throw，不静默。
 */
export async function handleSessionCommand(input: {
  sessionId: string;
  command: string;
}): Promise<{ ok: true; message: string }> {
  if (input.command !== 'compact') {
    throw new Error(`未知命令: /${input.command}（当前支持 /compact）`);
  }
  const session = getSession(input.sessionId);
  if (!session) throw new Error(`会话不存在: ${input.sessionId}`);
  if (isSessionRunning(input.sessionId)) {
    throw new Error('会话正在执行中，请先停止或等待完成后再压缩');
  }
  const history = listMessagesBySession(input.sessionId).slice(-COMPACT_WINDOW);
  if (history.length === 0) throw new Error('会话暂无消息，无内容可压缩');

  const llm = await resolveSessionLlm(input.sessionId);
  if (!llm) throw new Error('未配置可用模型服务（设置 → 模型服务），无法生成压缩摘要');

  const transcript = history
    .map((m) => `${m.sender === 'owner' ? '用户' : m.sender}: ${m.body}`)
    .join('\n');
  const res = await llm.chat([
    {
      role: 'user',
      content:
        '请把以下会话历史压缩为总结，严格分两节输出：\n' +
        '【用户指令】用户明确提出、尚未完成的要求（无则写「无」）\n' +
        '【agent 备忘】其他值得保留的上下文（标注：非用户指令）\n\n' +
        `会话历史：\n${transcript}`,
    },
  ]);
  const summary = res.content.trim();
  if (!summary) throw new Error('压缩摘要生成为空，请重试');

  upsertSessionSummary(input.sessionId, summary, Date.now());

  const ack = insertMessage({
    sessionId: input.sessionId,
    sender: 'owner',
    eventType: 'm.room.message',
    body: `[系统] 会话已压缩：${history.length} 条消息 → 摘要（下轮生效）`,
    workspaceId: session.workspaceId,
  });
  touchSessionLastMessage(input.sessionId);
  pushMessageRow(ack);
  void broadcastLocalMessage({
    roomId: input.sessionId,
    sender: 'owner',
    body: ack.body,
    eventType: 'm.room.message',
  });
  return { ok: true, message: ack.body };
}
```

`session.ipc.handlers.ts` 注册（`registerSessionIpcHandlers` 内）：

```typescript
  // 斜杠命令通道（spec §5.4）：/compact 等确定性命令，不经 agent 回合。
  ipcMain.handle(
    'session:command',
    async (_evt, sessionId: string, command: string) => {
      return handleSessionCommand({ sessionId, command });
    },
  );
```

- [ ] **Step 4: 跑测试确认通过 + 既有 im 域回归**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/im/session-command.test.ts tests/im/
```
预期：PASS。

- [ ] **Step 5: typecheck + 提交**

```bash
npx pnpm@9.0.0 typecheck
GIT_MASTER=1 git add electron/src/main/memory/extraction.ts electron/src/main/agent/agent-runner.ts electron/src/main/agent/runtime-registry.ts electron/src/main/im/session-service.ts electron/src/main/im/session.ipc.handlers.ts electron/tests/im/session-command.test.ts
GIT_MASTER=1 git commit -m "feat: /compact 主进程确定性链路——摘要 upsert+确认消息+运行中拒绝（spec §5.4）"
```

---

### Task 7: renderer 命令拦截与 IPC 双端类型

**Files:**
- Modify: `renderer/src/ipc/types.d.ts`（SessionApiSurface 加 `command`）
- Modify: `electron/src/preload/index.ts`（session 命名空间加绑定）
- Modify: `renderer/src/stores/session.store.ts`（sendMessage 前置拦截 + `commandHint` 状态）
- Modify: `renderer/src/components/im/MentionInput.tsx`（hint 展示，语义 token）
- Test: `renderer/src/stores/session.store.test.ts`（扩展）

**Interfaces:**
- Consumes: IPC 通道 `session:command`（Task 6）
- Produces: `ipc.session.command(sessionId: string, command: string): Promise<{ ok: true; message: string }>`；store 状态 `commandHint: string | null`

- [ ] **Step 1: 写失败测试**

`renderer/src/stores/session.store.test.ts` 追加（沿用该文件既有的 ipc mock 方式——顶部已有 `vi.mock('../../ipc/client'...)` 或等价物，保持一致）：

```typescript
describe('/ 命令拦截', () => {
  it('整条以 / 开头且白名单命中 → 走 session.command，不走 send', async () => {
    const { ipc } = await import('../../ipc/client');
    store.setState({ activeSessionId: 's1' });
    await store.getState().sendMessage('/compact');
    expect(ipc.session.command).toHaveBeenCalledWith('s1', 'compact');
    expect(ipc.session.send).not.toHaveBeenCalled();
  });

  it('未知命令 → 不发送，置 commandHint 提示', async () => {
    store.setState({ activeSessionId: 's1' });
    await store.getState().sendMessage('/wat');
    expect(ipc.session.send).not.toHaveBeenCalled();
    expect(store.getState().commandHint).toContain('未知命令');
  });

  it('// 前缀转义为原样发送', async () => {
    store.setState({ activeSessionId: 's1' });
    await store.getState().sendMessage('//not-a-command');
    expect(ipc.session.send).toHaveBeenCalledWith('s1', '/not-a-command', undefined);
    expect(store.getState().commandHint).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/stores/session.store.test.ts
```
预期：FAIL——拦截逻辑不存在。

- [ ] **Step 3: 实现**

`types.d.ts` SessionApiSurface 追加（与 Task 6 的通道契约一致）：

```typescript
  /** 斜杠命令（spec §5.4）：/compact 等确定性命令。未知命令/运行中/无模型配置时 reject（Error.message 中文提示） */
  command(sessionId: string, command: string): Promise<{ ok: true; message: string }>;
```

`preload/index.ts` session 命名空间（`send` 绑定后）追加：

```typescript
    command: (sessionId: string, command: string) => invoke('session:command', sessionId, command),
```

`session.store.ts`：

```typescript
// 状态字段
commandHint: string | null;

// sendMessage 顶部（ipc.session.send 调用之前）：
sendMessage: async (body, mentionedInstanceIds) => {
  const { activeSessionId } = get();
  if (!activeSessionId) return undefined;

  // / 命令拦截（spec §5.4）：白名单本地判定；'//' 转义原样发送
  if (body.startsWith('//')) {
    body = body.slice(1);
  } else if (body.startsWith('/')) {
    const command = body.slice(1).trim();
    if (command === 'compact') {
      try {
        const r = await ipc.session.command(activeSessionId, command);
        set({ commandHint: r.message });
      } catch (err) {
        set({ commandHint: err instanceof Error ? err.message : String(err) });
      }
      return undefined;
    }
    set({ commandHint: `未知命令: /${command}（当前支持 /compact）` });
    return undefined;
  }
  set({ commandHint: null });
  // ……原 send 逻辑不动 ……
```

`MentionInput.tsx`：输入区上方条件渲染 hint（语义 token，禁硬编码色）：

```tsx
{commandHint && (
  <div className="px-3 py-1 text-xs text-secondary border-t border-subtle">{commandHint}</div>
)}
```

（`commandHint` 经 `useSessionStore((s) => s.commandHint)` 取用；下一次正常发消息时置 null 自动消失。）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/stores/session.store.test.ts src/components/im/MentionInput.test.tsx
```
预期：PASS（含既有 MentionInput 回归）。

- [ ] **Step 5: typecheck + 提交**

```bash
npx pnpm@9.0.0 typecheck
GIT_MASTER=1 git add renderer/src/ipc/types.d.ts electron/src/preload/index.ts renderer/src/stores/session.store.ts renderer/src/components/im/MentionInput.tsx renderer/src/stores/session.store.test.ts
GIT_MASTER=1 git commit -m "feat: renderer 斜杠命令拦截——/compact 白名单与 // 转义（spec §5.4）"
```

---

### Task 8: 全量回归与验收对照

**Files:**
- 无新代码；验证型任务

- [ ] **Step 1: 全量测试**

```bash
nvm use 20 && npx pnpm@9.0.0 test
```
预期：electron + renderer 全绿（对照基线：改动前全绿）。

- [ ] **Step 2: typecheck 双 clean**

```bash
npx pnpm@9.0.0 typecheck
```

- [ ] **Step 3: 「继续工作」残留扫描（spec §11-3）**

```bash
grep -rn "继续工作" electron/src/main/agent/ renderer/src/
```
预期：0 命中。

- [ ] **Step 4: 真机验收剧本（macOS 主机，spec §7）**

逐项执行并记录截图/结论：
1. chat 会话说「压缩上下文」→ agent 压缩后输出确认即停，不自驱
2. 大任务（带 user-source todos）中途自压缩 → 续跑至完成
3. steer「停下」后压缩 → 收口
4. `/compact` → 确认消息落库、下轮摘要生效、未知命令提示、`//` 转义可用

- [ ] **Step 5: 收尾提交（如有验收期小修）**

```bash
GIT_MASTER=1 git add -A && GIT_MASTER=1 git commit -m "test: turn mandate 收官——全量回归与真机验收剧本对照"
```

---

## Self-Review（已执行）

1. **Spec 覆盖**：§2 mandate（Task 3）、§4 三场景（Task 3 steer 维护 + Task 4 wrapUp-steer 交互；场景 2/3 为零改动契约，由 Task 4 测试 (b) 侧证）、§5.1（Task 4）、§5.2（Task 1）、§5.3（Task 5）、§5.4（Task 6+7）、§5.5（Task 3）、§5.6 八处文案（#1/#5/#6/#7/#8=Task 2；#2/#3/#4=Task 4；#8a todo 描述=Task 1）、§6 错误处理（Task 6 显式报错 + Task 4 过短拒绝保留）、§7 测试（各任务步骤 + Task 8）、§11 验收（Task 8）。无缺口。
2. **占位符扫描**：Task 4 Step 3 的「注释段展开为完整代码」为实现指引（含精确逻辑与取数谓词说明），非 TBD；Task 1/4 测试中两处「以 types.ts / provider 类型为准修正桩」为 typecheck 驱动的对齐指令，均给出完整可跑基线代码。无「适当处理」「稍后实现」类空步。
3. **类型一致性**：`hasPendingUserTodos(streamId: string): boolean`（T1 产、T3/T4/T5 消费）；`buildMandateHint({userBody, steers, streamSessionId})`（T3 产、T4 经 refreshSystem 消费）；`SIDEEFFECT_UNLINKED_WARNING`（T5 内部自洽）；`session:command (sessionId, command) → {ok, message}`（T6 产、T7 消费，两侧签名逐字一致）；`__setTodosForTest`（T1 产、T3/T4/T5 测试消费）。
