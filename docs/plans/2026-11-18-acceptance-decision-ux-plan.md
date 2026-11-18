# 验收裁决 UX 重构 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把验收从「执行方也能操作的模糊表单」改成「发起方三动作裁决（继续 / 完成 / 驳回）+ 跨节点交付物保真」。

**Architecture:** 裁决权在 `human:list` 投影层收敛（`canDecide`），卡片按投影分叉为可操作/只读两态；「继续」由 `lifecycle-runs.acceptAndContinue` 单点写路径实现（run accepted + 任务回 in_progress + 新 run），跨节点经 momo-hub 1.14 新增的 `task.continue` / `task.continued` 通道；交付物改走 `task.report.deliverable` 结构化字段，`reason` 仅作旧 hub 降级通道。

**Tech Stack:** Electron 主进程（CommonJS / TypeScript strict / better-sqlite3）、React + Zustand（renderer，vitest + @testing-library）、momo-hub（独立仓，Node + ws，协议包 `momo-hub-protocol`）。

**Spec:** `docs/specs/2026-11-18-acceptance-decision-ux-design.md`

## Global Constraints

- Node 24（`nvm use 24`）；pnpm 用 `npx pnpm@9.0.0`。
- TypeScript strict：禁 `any` / `@ts-ignore` / `as any`；ESLint `no-explicit-any: error`。
- 全部代码注释、文档用中文；标识符英文。
- 任务状态只经 `lifecycle-runs` 投影写入，禁 `updateTask({status})`（`lifecycle-runs.ts` 是任务/run 唯一写者）。
- renderer 单测贴源 colocated（`Foo.test.tsx` 与 `Foo.tsx` 同目录）；electron 单测集中 `electron/tests/` 且镜像 `src/` 目录。
- renderer UI 只用语义 token（`bg-surface-*` / `text-secondary` 等），图标用 lucide-react 16px/stroke 1.75。
- 提交信息 Conventional Commits；特性分支内不并发改动版本号（Task 12 统一 +1）。
- 跨仓：hub 改动在 `/Users/stbearangel/dev/AiProject/momo-hub`，走独立提交与 tag；studio 侧 pin 在 Task 12 一并升级。

## Review Focus

1. **继续要求是纯空白 / 超 4000 码点**：期望人话拒（`继续要求需 1-4000 字`），run/任务/请求零副作用——`acceptAndContinue` 与 IPC 两层都要拦。
2. **待裁决期间任务被取消后再收到 `task.continued`**：期望 worker 静默收敛（不复活任务、不建 run）；对应 `handleTaskContinued` 的 `isTerminal` 守卫测试。
3. **旧 hub（<1.14）/ 旧执行节点**：期望「继续」得到明确人话错误且本地零写入；不允许出现「A 已进 N+1、B 从未收到」。
4. **交付物超限（>16 KiB 或多文件长摘要）**：期望结构化截断（保 files/artifacts、只截 summary），ws 帧不炸；镜像行缺 `deliverable` 时卡片显式标「截断」。
5. **连点「继续」两次**：期望第二次 `not_submitted` 人话拒且不产生第三个 run（单活动 run 不变量）。

## File Structure

**studio（electron）**
- `electron/src/main/storage/tasks/state-machine.ts` — 任务状态机表（加 `submitted → in_progress`）
- `electron/src/main/storage/tasks/runs-repo.ts` — `TaskRunTrigger` 加 `'continue'`
- `electron/src/main/task/lifecycle-runs.ts` — 唯一写者：新增 `acceptAndContinue`
- `electron/src/main/task/human.ipc.handlers.ts` — `canDecide` 投影
- `electron/src/main/task/ipc.handlers.ts` — 裁决守卫、`task:continue` 路由、steer 守卫
- `electron/src/main/hub/delegation-wire.ts` — `TASK_RPC.continue`、`TaskReportPayload.deliverable`
- `electron/src/main/hub/remote-intervene-bridge.ts` — 上报结构化交付物、截断算法、`handleTaskContinued`、镜像 `truncated`
- `electron/src/main/hub/delegation-runner.ts` — `settleAcceptance` 联合类型加 `'continued'`
- `electron/src/main/hub/index.ts` — `task.continued` 事件接线
- `electron/src/main/ipc/index.ts` — `setContinueForwarder` 装配
- `electron/src/preload/index.ts`、`renderer/src/ipc/types.d.ts` — IPC 面
- `renderer/src/components/im/HumanRequestPanel.tsx` — 卡片重构（三动作 / 只读 / Markdown / 折叠）
- `renderer/src/components/hub/RemoteSteerComposer.tsx` — 待裁决禁用

**hub（momo-hub）**
- `src/delegation.ts` — `TASK_RPC.continue`、`TaskContinueReq/Res`、`TaskReportPayload.deliverable`、`TASK_CONTINUE_REQUIRED_MINOR`
- `src/events.ts` — `EVT.taskContinued` + `TaskContinuedEvent`
- `src/methods.ts` — 门槛 14
- `src/version.ts` — `PROTOCOL_VERSION = '1.14.0'`
- `packages/hub/src/delegations.ts` — `handleContinue` + deliverable 优先
- `packages/hub/src/server.ts` — 注册 handler
- `packages/hub/tests/delegations.test.ts` — wire 契约

---

### Task 1: 状态机新边与 `continue` 触发值

**Files:**
- Modify: `electron/src/main/storage/tasks/state-machine.ts:85-95`
- Modify: `electron/src/main/storage/tasks/runs-repo.ts:23`
- Test: `electron/tests/storage/task-state-machine.test.ts`

**Interfaces:**
- Produces: `canTransition('submitted','in_progress') === true`；`TaskRunTrigger` 含 `'continue'`

- [ ] **Step 1: 写失败测试**

在 `electron/tests/storage/task-state-machine.test.ts` 追加：

```ts
describe('1.14 继续（accept-and-continue）合法边', () => {
  it('submitted → in_progress 合法；completed 仍只能从 submitted 进入', () => {
    expect(canTransition('submitted', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'completed')).toBe(false);
    expect(canTransition('submitted', 'completed')).toBe(true);
    expect(canTransition('completed', 'in_progress')).toBe(false);
  });

  it('submitted 的其他出边不受影响（assigned/cancelled/failed）', () => {
    for (const to of ['assigned', 'cancelled', 'failed'] as const) {
      expect(canTransition('submitted', to), to).toBe(true);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/storage/task-state-machine.test.ts
```
Expected: FAIL（`submitted → in_progress` 返回 false）

- [ ] **Step 3: 最小实现**

`state-machine.ts` 的 `LEGAL_TRANSITIONS.submitted` 改为：

```ts
  // submitted → in_progress：验收「继续」专用边（spec 2026-11-18 DEC-12）——
  // 只有 lifecycle-runs.acceptAndContinue 单点可使用；completed 仍只能由 submitted 进入。
  submitted: new Set(['completed', 'assigned', 'in_progress', 'cancelled', 'failed']),
```

`runs-repo.ts`：

```ts
export type TaskRunTrigger = 'initial' | 'rework' | 'quota_retry' | 'manual' | 'continue';
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/storage/task-state-machine.test.ts
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/storage/tasks/state-machine.ts electron/src/main/storage/tasks/runs-repo.ts electron/tests/storage/task-state-machine.test.ts
git commit -m "feat(lifecycle): submitted→in_progress 继续边 + run trigger 'continue'"
```

---

### Task 2: `acceptAndContinue` 单点写路径

**Files:**
- Modify: `electron/src/main/task/lifecycle-runs.ts`（`answerAcceptance` 附近 + 新增导出）
- Test: `electron/tests/task/lifecycle-runs-continue.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的合法边与 `'continue'` trigger
- Produces: `acceptAndContinue(taskId: string, requirement: string, byNodeId?: string): void`

- [ ] **Step 1: 写失败测试**

新建 `electron/tests/task/lifecycle-runs-continue.test.ts`：

```ts
// lifecycle-runs 继续写路径契约锁（spec 2026-11-18 DEC-14）：
// run#N accepted + 任务 in_progress + run#N+1(trigger='continue') + 验收答复带 requirement。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { getActiveRun, listRuns } from '../../src/main/storage/tasks/runs-repo';
import { listByTask } from '../../src/main/storage/tasks/human-requests-repo';
import { startRun, submitRun, acceptAndContinue } from '../../src/main/task/lifecycle-runs';

const tmpRoot = path.join(os.tmpdir(), `ap-continue-${Date.now()}-${Math.random().toString(36).slice(2)}`);
let execSessionId = '';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb().prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  execSessionId = insertSession({ workspaceId: 'ws1', title: '执行', kind: 'chat' }).id;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function seedSubmitted(): string {
  const t = insertTask({
    workspaceId: 'ws1', title: 'T', creatorUserId: '@owner:home',
    assigneeAgentId: 'inst-1', status: 'assigned', executionSessionId: execSessionId,
  });
  startRun(t.id, { trigger: 'initial' });
  return t.id;
}

describe('acceptAndContinue', () => {
  it('run#1 accepted + 任务 in_progress + run#2(continue/running) + 答复含 requirement', async () => {
    const id = seedSubmitted();
    await submitRun(id, { summary: '第 1 轮交付', files: ['a.md'] });

    acceptAndContinue(id, '按主题一写正文');

    const runs = listRuns(id);
    expect(runs).toHaveLength(2);
    expect(runs[0].status).toBe('accepted');
    expect(runs[0].endedAt).not.toBeNull();
    expect(runs[1].runNo).toBe(2);
    expect(runs[1].trigger).toBe('continue');
    expect(runs[1].status).toBe('running');
    expect(getTask(id)!.status).toBe('in_progress');
    expect(getActiveRun(id)!.id).toBe(runs[1].id);
    const acceptance = listByTask(id).filter((r) => r.kind === 'acceptance').pop()!;
    expect(acceptance.status).toBe('answered');
    expect(JSON.parse(acceptance.answerJson!)).toEqual({ decision: 'accept', requirement: '按主题一写正文' });
  });

  it('空白要求 / 超 4000 码点 → 人话拒且零副作用', async () => {
    const id = seedSubmitted();
    await submitRun(id, { summary: 'x' });
    expect(() => acceptAndContinue(id, '   ')).toThrow('继续要求需 1-4000 字');
    expect(() => acceptAndContinue(id, '字'.repeat(4001))).toThrow('继续要求需 1-4000 字');
    expect(getTask(id)!.status).toBe('submitted');
    expect(listRuns(id)).toHaveLength(1);
  });

  it('run 非 submitted → 人话拒（连点第二次）', async () => {
    const id = seedSubmitted();
    await submitRun(id, { summary: 'x' });
    acceptAndContinue(id, '继续做');
    expect(() => acceptAndContinue(id, '再继续')).toThrow('只有已提交待验收（submitted）的 run');
    expect(listRuns(id)).toHaveLength(2);
  });

  it('返工配额不受 continue 影响（countRuns 只数总量，continue 不额外拒绝）', async () => {
    const id = seedSubmitted();
    await submitRun(id, { summary: 'x' });
    acceptAndContinue(id, '继续');
    expect(listRuns(id).filter((r) => r.status === 'rejected')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/task/lifecycle-runs-continue.test.ts
```
Expected: FAIL（`acceptAndContinue` 未导出）

- [ ] **Step 3: 实现**

`lifecycle-runs.ts` —— 先扩 `answerAcceptance` 的 answer 类型（文件内私有）：

```ts
function answerAcceptance(
  taskId: string,
  runId: string,
  answer: { decision: 'accept'; requirement?: string } | { decision: 'reject'; reason: string },
  byNodeId: string,
): void {
```

再在 `rejectTask` 之后新增导出（沿用 `completeAcceptance` 注释风格）：

```ts
/** 继续要求长度上限（协议 TaskContinueReq 1..4000 同界，spec 2026-11-18 DEC-14） */
const CONTINUE_REQUIREMENT_MAX = 4000;

/**
 * 验收「继续」（spec 2026-11-18 DEC-14）：run#N → accepted + 验收单答复
 * accept(requirement) + 任务回 in_progress + 新 run#N+1（trigger='continue'）。
 * 单活动 run 不变量由部分唯一索引兜底；本函数是 `submitted → in_progress`
 * 边的唯一使用者（状态机注释同源）。本地任务与 worker 远端消费共用。
 */
export function acceptAndContinue(
  taskId: string,
  requirement: string,
  byNodeId: string = LOCAL_ACCEPT_BY,
): void {
  const text = requirement.trim();
  const codepoints = Array.from(text).length;
  if (codepoints < 1 || codepoints > CONTINUE_REQUIREMENT_MAX) {
    throw new Error(`继续要求需 1-${CONTINUE_REQUIREMENT_MAX} 字`);
  }
  const task = getTask(taskId);
  if (!task) throw new Error(`任务 ${taskId} 不存在`);
  if (task.status === 'paused') throw new Error(`任务 ${taskId} 已暂停，先恢复或取消`);
  const active = requireActiveRun(taskId);
  if (active.status !== 'submitted') {
    throw new Error(
      `任务 ${taskId} 当前 run（run #${active.runNo}）状态为 ${active.status}，` +
        `只有已提交待验收（submitted）的 run 可执行继续操作`,
    );
  }
  const now = Date.now();
  const nextRunId = getDb().transaction((): string => {
    updateRun(active.id, { status: 'accepted', endedAt: now });
    answerAcceptance(taskId, active.id, { decision: 'accept', requirement: text }, byNodeId);
    projectTaskStatus(taskId, 'in_progress');
    const next = insertRun({
      taskId,
      runNo: active.runNo + 1,
      status: 'running',
      trigger: 'continue',
      executionSessionId: task.executionSessionId,
    });
    ensureRunBookkeeping(taskId, next.id, 'running');
    return next.id;
  })();
  emitRunChanged(taskId, active.id, 'accepted');
  emitRunChanged(taskId, nextRunId, 'running');
}
```

- [ ] **Step 4: 跑测试**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/task/lifecycle-runs-continue.test.ts tests/task/lifecycle-runs-submit.test.ts
```
Expected: PASS（submit 套件不得回归）

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/task/lifecycle-runs.ts electron/tests/task/lifecycle-runs-continue.test.ts
git commit -m "feat(lifecycle): acceptAndContinue 单点写路径（run accepted + 续作 run N+1）"
```

---

### Task 3: `human:list` 的 `canDecide` 投影 + 验收 IPC 守卫

**Files:**
- Modify: `electron/src/main/task/human.ipc.handlers.ts:165-195`
- Modify: `electron/src/main/task/ipc.handlers.ts:314-338`
- Modify: `renderer/src/ipc/types.d.ts:676-683`
- Test: `electron/tests/task/human-list-projection.test.ts`（新建）、`electron/tests/task/accept-authority.test.ts`（新建）

**Interfaces:**
- Produces: `HumanRequestWireRow.canDecide?: boolean`；`acceptTaskRouted` / `rejectTaskRouted` 对 `delegationRole === 'in'` 抛 `验收裁决权归发起方（本机为执行方）`

- [ ] **Step 1: 写失败测试（投影）**

新建 `electron/tests/task/human-list-projection.test.ts`：

```ts
// human:list 投影 canDecide 契约锁（spec 2026-11-18 DEC-2）：
// acceptance 行按任务 delegation_role 判定裁决权；其他 kind 恒 true。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { insertHumanRequest, listPendingBySession } from '../../src/main/storage/tasks/human-requests-repo';
import { projectHumanListRows } from '../../src/main/task/human.ipc.handlers';

const tmpRoot = path.join(os.tmpdir(), `ap-can-decide-${Date.now()}-${Math.random().toString(36).slice(2)}`);
let sessionId = '';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb().prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  sessionId = insertSession({ workspaceId: 'ws1', title: 's', kind: 'chat' }).id;
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

const ACCEPTANCE_PAYLOAD = JSON.stringify({
  acceptance: { runNo: 1, summary: 'x', files: [], artifacts: [] },
});

/** 种一个 acceptance 请求行；返回 taskId */
function seedAcceptance(delegationRole: 'in' | 'out' | null): string {
  const task = insertTask({
    workspaceId: 'ws1', title: 'T', creatorUserId: '@owner:home',
    assigneeAgentId: 'inst-1', status: 'submitted',
    ...(delegationRole !== null ? { delegationRole, delegationId: 'dl-1' } : {}),
  });
  insertHumanRequest({
    sessionId, taskId: task.id, kind: 'acceptance', title: '第 1 轮交付',
    prompt: 'T', payloadJson: ACCEPTANCE_PAYLOAD, timeoutPolicy: 'keep_waiting',
  });
  return task.id;
}

describe('projectHumanListRows.canDecide', () => {
  it('执行方（role=in）→ false；本地任务 → true；发起方镜像行 → true', () => {
    const inTaskId = seedAcceptance('in');
    const localTaskId = seedAcceptance(null);
    const outTaskId = seedAcceptance('out');
    const mirror = insertHumanRequest({
      sessionId, taskId: outTaskId, kind: 'acceptance', title: '第 1 轮交付',
      prompt: 'T', payloadJson: ACCEPTANCE_PAYLOAD, timeoutPolicy: 'keep_waiting',
      delegationId: 'dl-1', originNodeId: 'node-b', remoteId: 'dl-1#1',
    });
    const rows = projectHumanListRows(listPendingBySession(sessionId));
    const byTask = new Map(rows.filter((r) => r.taskId !== null).map((r) => [r.taskId!, r]));
    expect(byTask.get(inTaskId)!.canDecide).toBe(false);
    expect(byTask.get(localTaskId)!.canDecide).not.toBe(false);
    expect(byTask.get(outTaskId)!.canDecide).not.toBe(false);
    const mirrorRow = rows.find((r) => r.id === mirror.id)!;
    expect(mirrorRow.canDecide).not.toBe(false);
    expect(mirrorRow.originNodeName).toBeDefined();
  });
});
```

- [ ] **Step 2: 写失败测试（IPC 守卫）**

新建 `electron/tests/task/accept-authority.test.ts`：

```ts
// 验收 IPC 权威守卫（spec 2026-11-18 DEC-4）：执行方（role='in'）不得本地验收/打回。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { startRun, submitRun } from '../../src/main/task/lifecycle-runs';
import { acceptTaskRouted, rejectTaskRouted } from '../../src/main/task/ipc.handlers';

const tmpRoot = path.join(os.tmpdir(), `ap-accept-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
let sessionId = '';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb().prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  sessionId = insertSession({ workspaceId: 'ws1', title: 's', kind: 'chat' }).id;
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

async function submittedWithRole(role: 'in' | 'out' | null): Promise<string> {
  const t = insertTask({
    workspaceId: 'ws1', title: 'T', creatorUserId: '@owner:home',
    assigneeAgentId: 'inst-1', status: 'assigned', executionSessionId: sessionId,
    ...(role !== null ? { delegationRole: role, delegationId: 'dl-1' } : {}),
  });
  startRun(t.id, { trigger: 'initial' });
  await submitRun(t.id, { summary: 'x' });
  return t.id;
}

describe('验收权威守卫', () => {
  it('执行方（in）accept/reject 人话拒', async () => {
    const id = await submittedWithRole('in');
    await expect(acceptTaskRouted(id)).rejects.toThrow('验收裁决权归发起方（本机为执行方）');
    await expect(rejectTaskRouted(id, '重做')).rejects.toThrow('验收裁决权归发起方（本机为执行方）');
  });

  it('本地任务照常可验收', async () => {
    const id = await submittedWithRole(null);
    const after = await acceptTaskRouted(id);
    expect(after.status).toBe('completed');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/task/human-list-projection.test.ts tests/task/accept-authority.test.ts
```
Expected: FAIL（无 `canDecide`；执行方未拒）

- [ ] **Step 4: 实现**

`human.ipc.handlers.ts`：

```ts
export type HumanRequestWireRow = HumanRequestRow & {
  originNodeName?: string | null;
  peerMirror?: boolean;
  /** 本端是否可裁决（spec 2026-11-18 DEC-2）：仅 acceptance 行有 false 值
   *  （任务 delegation_role='in' = 执行方，等待发起方）；其他 kind 恒 true。 */
  canDecide?: boolean;
};

function canDecideRow(row: HumanRequestRow): boolean {
  if (row.kind !== 'acceptance' || row.taskId === null) return true;
  const task = getTask(row.taskId);
  return task?.delegationRole !== 'in';
}

export function projectHumanListRows(rows: HumanRequestRow[]): HumanRequestWireRow[] {
  return rows.map((row) => {
    const canDecide = canDecideRow(row);
    if (row.originNodeId === null || row.remoteId === null) {
      return canDecide ? row : { ...row, canDecide: false };
    }
    const task = row.taskId !== null ? getTask(row.taskId) : null;
    return {
      ...row,
      originNodeName: originNodeNameOf(row.originNodeId),
      ...(task?.origin === 'peer_draft' ? { peerMirror: true } : {}),
      ...(canDecide ? {} : { canDecide: false }),
    };
  });
}
```

`ipc.handlers.ts` 的 `acceptTaskRouted` / `rejectTaskRouted` 开头（`const before = getTask(id);` 之后）：

```ts
  if (before !== null && before.delegationRole === 'in') {
    throw new Error('验收裁决权归发起方（本机为执行方）');
  }
```

`renderer/src/ipc/types.d.ts` 的 `HumanRequestRow` 增：

```ts
  /** 本端是否可裁决（human:list 投影响应键；acceptance 在执行方为 false） */
  canDecide?: boolean;
```

- [ ] **Step 5: 跑测试**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/task/human-list-projection.test.ts tests/task/accept-authority.test.ts tests/task/human-ipc.test.ts
cd .. && npx pnpm@9.0.0 --filter momo-studio-renderer typecheck
```
Expected: PASS / typecheck 0

- [ ] **Step 6: 提交**

```bash
git add electron/src/main/task/human.ipc.handlers.ts electron/src/main/task/ipc.handlers.ts renderer/src/ipc/types.d.ts electron/tests/task/human-list-projection.test.ts electron/tests/task/accept-authority.test.ts
git commit -m "feat(acceptance): 裁决权收敛——canDecide 投影 + 执行方 IPC 守卫"
```

---

### Task 4: 待裁决期禁用补充指令（主进程守卫）

**Files:**
- Modify: `electron/src/main/task/ipc.handlers.ts:270-290`
- Test: `electron/tests/task/steer-ipc.test.ts`

**Interfaces:**
- Produces: `steerTaskRouted` 在 `task.status === 'submitted'` 抛 `任务待验收，请先裁决（继续 / 完成 / 驳回）后再补充指令`

- [ ] **Step 1: 写失败测试**

在 `electron/tests/task/steer-ipc.test.ts` 的 out 校验 describe 内追加：

```ts
  it('任务 submitted（待裁决）→ 人话拒且 forwarder 不被调（DEC-11）', async () => {
    const t = insertTask({
      workspaceId: 'ws1', title: 'T', creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-1', status: 'submitted',
      delegationRole: 'out', delegationId: DELEGATION_ID,
      executionSessionId: trackingSessionId,
    });
    await expect(steerTaskRouted(t.id, '先别动')).rejects.toThrow(
      '任务待验收，请先裁决（继续 / 完成 / 驳回）后再补充指令',
    );
    expect(forwarderMock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/task/steer-ipc.test.ts
```
Expected: FAIL（转发被调用）

- [ ] **Step 3: 实现**

`steerTaskRouted` 在 `delegationRole` 校验之后追加：

```ts
  if (task.status === 'submitted') {
    // spec 2026-11-18 DEC-11：待裁决期 steer 会在执行方开出与验收单不一致的僵尸回合
    throw new Error('任务待验收，请先裁决（继续 / 完成 / 驳回）后再补充指令');
  }
```

- [ ] **Step 4: 跑测试**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/task/steer-ipc.test.ts
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/task/ipc.handlers.ts electron/tests/task/steer-ipc.test.ts
git commit -m "fix(steer): 待裁决期拒绝补充指令——防与验收单脱节的僵尸回合"
```

---

### Task 5: `task:continue` IPC 路由（本地分支 + 远端先行）

**Files:**
- Modify: `electron/src/main/hub/delegation-wire.ts`（`TASK_RPC` 增 `continue`）
- Modify: `electron/src/main/task/ipc.handlers.ts`（forwarder 容器 + `continueTaskRouted` + handler）
- Modify: `electron/src/main/ipc/index.ts`（装配 forwarder）
- Modify: `electron/src/preload/index.ts:652-658`
- Modify: `renderer/src/ipc/types.d.ts:489-501`
- Test: `electron/tests/task/continue-ipc.test.ts`（新建）

**Interfaces:**
- Consumes: `acceptAndContinue`（Task 2）、`TASK_RPC.continue`
- Produces: `continueTaskRouted(id, requirement): Promise<TaskRow>`、`setContinueForwarder(fn)`、`ipc.task.continue(taskId, requirement)`

- [ ] **Step 1: 写失败测试**

新建 `electron/tests/task/continue-ipc.test.ts`（骨架照 `steer-ipc.test.ts`：mock electron ipcMain）：

```ts
// task:continue IPC 契约（spec 2026-11-18 DEC-16）：
// 本地任务直接写；委派任务远端先行（失败零本地写入）；成功回读 TaskRow。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface IpcHandler { (event: unknown, ...args: unknown[]): Promise<unknown> | unknown }
const handlers = vi.hoisted(() => new Map<string, IpcHandler>());
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: IpcHandler): void => { handlers.set(channel, fn); } },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { listRuns } from '../../src/main/storage/tasks/runs-repo';
import { startRun, submitRun } from '../../src/main/task/lifecycle-runs';
import {
  registerTaskHandlers, setContinueForwarder, continueTaskRouted,
  type ContinueForwardInput,
} from '../../src/main/task/ipc.handlers';

const DELEGATION_ID = 'dl-cont-1';
const tmpRoot = path.join(os.tmpdir(), `ap-continue-ipc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const forwarderMock = vi.fn<(input: ContinueForwardInput) => Promise<void>>();
let sessionId = '';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb().prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  sessionId = insertSession({ workspaceId: 'ws1', title: 's', kind: 'chat' }).id;
  forwarderMock.mockReset().mockResolvedValue(undefined);
  setContinueForwarder(forwarderMock);
  registerTaskHandlers();
});
afterEach(() => {
  setContinueForwarder(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

async function submittedTask(role: 'out' | null): Promise<string> {
  const t = insertTask({
    workspaceId: 'ws1', title: 'T', creatorUserId: '@owner:home',
    assigneeAgentId: 'inst-1', status: 'assigned', executionSessionId: sessionId,
    ...(role === 'out' ? { delegationRole: 'out', delegationId: DELEGATION_ID } : {}),
  });
  startRun(t.id, { trigger: 'initial' });
  await submitRun(t.id, { summary: 'x' });
  return t.id;
}

describe('task:continue', () => {
  it('本地任务：直接续作，不走 forwarder', async () => {
    const id = await submittedTask(null);
    await continueTaskRouted(id, '按主题一写正文');
    expect(forwarderMock).not.toHaveBeenCalled();
    expect(getTask(id)!.status).toBe('in_progress');
    expect(listRuns(id)).toHaveLength(2);
  });

  it('委派任务：先远端后本地，转发载荷 {delegationId, requirement}', async () => {
    const id = await submittedTask('out');
    await continueTaskRouted(id, '按主题一写正文');
    expect(forwarderMock).toHaveBeenCalledWith({ delegationId: DELEGATION_ID, requirement: '按主题一写正文' });
    expect(listRuns(id)).toHaveLength(2);
  });

  it('远端失败 → 人话抛且本地零写入（卡片保持待裁决）', async () => {
    const id = await submittedTask('out');
    forwarderMock.mockRejectedValueOnce(new Error('[peer_version_unsupported] 执行节点协议版本不足'));
    await expect(continueTaskRouted(id, '继续')).rejects.toThrow('执行节点版本不支持继续，可改用完成或驳回');
    expect(getTask(id)!.status).toBe('submitted');
    expect(listRuns(id)).toHaveLength(1);
  });

  it('IPC 通道注册 + 空白要求人话拒', async () => {
    const handler = handlers.get('task:continue')!;
    expect(handler).toBeTruthy();
    const id = await submittedTask(null);
    await expect(handler({}, id, '  ')).rejects.toThrow('继续要求需 1-4000 字');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/task/continue-ipc.test.ts
```
Expected: FAIL（未导出）

- [ ] **Step 3: 实现**

`delegation-wire.ts` 的 `TASK_RPC` 增：

```ts
  // 1.14.0（验收继续，门槛 minor 14）：发起方 → hub → 执行节点；账本
  // submitted→running + run_no+1，事件 task.continued 携带 requirement。
  continue: 'task.continue',
```

`ipc.handlers.ts`（照 `steerForwarder` 模式）：

```ts
/** 继续通道转发载荷（= hub TaskContinueReq：taskId 为委派 id） */
export interface ContinueForwardInput {
  delegationId: string;
  requirement: string;
}

let continueForwarder: ((input: ContinueForwardInput) => Promise<void>) | null = null;

/** 继续转发装配点（hub 域 ipc/index.ts 接线） */
export function setContinueForwarder(fn: ((input: ContinueForwardInput) => Promise<void>) | null): void {
  continueForwarder = fn;
}

/** hub 错误码 → 人话（peer_version_unsupported 是 1.14 版本门的唯一新增码） */
function humanizeContinueError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('peer_version_unsupported')) {
    return '执行节点版本不支持继续，可改用完成或驳回';
  }
  if (message.includes('node_offline')) return '执行节点离线，稍后再试';
  return message;
}

/**
 * 验收「继续」路由单点（spec 2026-11-18 DEC-16）：本地任务直接续作；
 * 委派任务「远端先行、本地后落」——远端失败本地零写入，卡片保持待裁决。
 */
export async function continueTaskRouted(
  id: string,
  requirement: string,
): Promise<TaskRow & { remoteWarning?: string }> {
  const before = getTask(id);
  if (!before) throw new Error(`task ${id} 不存在`);
  if (before.delegationRole !== 'out') {
    acceptAndContinue(id, requirement);
    notifyExecutor();
    return { ...getTask(id)! };
  }
  if (before.delegationId === null) throw new Error('任务未委派，无可送达的执行节点');
  const forward = continueForwarder;
  if (forward === null) throw new Error('继续通道未就绪（hub 未配置）');
  try {
    await forward({ delegationId: before.delegationId, requirement: requirement.trim() });
  } catch (err) {
    throw new Error(humanizeContinueError(err));
  }
  acceptAndContinue(id, requirement);
  notifyExecutor();
  return { ...getTask(id)! };
}
```

`registerTaskHandlers()` 内（`task:steer` 之后）：

```ts
  ipcMain.handle(
    'task:continue',
    async (_evt, id: string, requirement: string): Promise<TaskRow & { remoteWarning?: string }> => {
      if (typeof id !== 'string') throw new Error('task:continue 需要 taskId');
      if (typeof requirement !== 'string') throw new Error('task:continue 需要 requirement 字符串');
      return continueTaskRouted(id, requirement);
    },
  );
```

`ipc/index.ts`（`setSteerForwarder` 之后）：

```ts
  // 1.14.0 验收继续转发（DEC-16 远端先行）：hub 错误码经 RpcRemoteError.code
  // 原样到达，humanizeContinueError 在 handler 映射人话
  setContinueForwarder(async ({ delegationId, requirement }) => {
    await hubRequest(TASK_RPC.continue, { taskId: delegationId, requirement }, undefined);
  });
```

`preload/index.ts`（`steer` 之后）：

```ts
    // 1.14.0 验收继续（spec 2026-11-18 DEC-16）：继续要求必填；远端失败人话 throw
    continue: (id, requirement) =>
      invoke<TaskRow & { remoteWarning?: string }>('task:continue', id, requirement),
```

`renderer/src/ipc/types.d.ts`（`steer` 之前）：

```ts
  /**
   * 验收继续（spec 2026-11-18 DEC-16）：当前 run 验收通过 + 同一任务立即开
   * run#N+1，requirement 随事件送达执行方（1..4000 字，空白人话拒）。
   * 委派任务为「远端先行」——远端失败本地零写入、卡片保持待裁决。
   */
  continue(id: string, requirement: string): Promise<TaskRow & { remoteWarning?: string }>;
```

- [ ] **Step 4: 跑测试**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/task/continue-ipc.test.ts
cd .. && npx pnpm@9.0.0 typecheck
```
Expected: PASS / typecheck 0

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/hub/delegation-wire.ts electron/src/main/task/ipc.handlers.ts electron/src/main/ipc/index.ts electron/src/preload/index.ts renderer/src/ipc/types.d.ts electron/tests/task/continue-ipc.test.ts
git commit -m "feat(acceptance): task:continue IPC（本地直写 / 委派远端先行）+ preload 面"
```

---

### Task 6: hub 协议 1.14.0（task.continue + 结构化 deliverable）

**Files:**
- Modify: `/Users/stbearangel/dev/AiProject/momo-hub/src/delegation.ts`
- Modify: `/Users/stbearangel/dev/AiProject/momo-hub/src/events.ts`
- Modify: `/Users/stbearangel/dev/AiProject/momo-hub/src/methods.ts`
- Modify: `/Users/stbearangel/dev/AiProject/momo-hub/src/version.ts`
- Modify: `/Users/stbearangel/dev/AiProject/momo-hub/packages/hub/src/delegations.ts`
- Modify: `/Users/stbearangel/dev/AiProject/momo-hub/packages/hub/src/server.ts`
- Test: `/Users/stbearangel/dev/AiProject/momo-hub/packages/hub/tests/delegations.test.ts`

**Interfaces:**
- Produces: `RPC.task.continue = 'task.continue'`、`EVT.taskContinued = 'task.continued'`、`TaskContinueReq { taskId; requirement }`、`TaskContinueRes { runNo }`、`TaskContinuedEvent { taskId; runNo; requirement }`、`TaskReportPayload.deliverable?`、`TASK_CONTINUE_REQUIRED_MINOR = 14`

- [ ] **Step 1: 写失败测试**

在 `packages/hub/tests/delegations.test.ts` 末尾追加（复用该文件既有 `setupGroup` / `delegateOk` / `delegateReq` / `report` / `ledgerRow` / `callRpc` helpers）：

```ts
/** 驱入 submitted（1.11 两段式：running → submitted 上报） */
async function driveToSubmitted(leader: Client, target: Client, groupId: string, pref: string): Promise<string> {
  const taskId = await delegateOk(leader, delegateReq(groupId, target.nodeId, { workspaceName: `ws-${pref}` }));
  report(target.ws, taskId, { status: 'running', sessionId: `sess-${pref}` });
  await settle(100);
  report(target.ws, taskId, { status: 'submitted', runNo: 1, reason: JSON.stringify({ summary: '摘要' }) });
  await leader.next((e) => e.kind === 'evt' && e.method === EVT.taskSubmitted
    && (e.payload as { taskId: string }).taskId === taskId);
  expect(ledgerRow(taskId)?.status).toBe('submitted');
  return taskId;
}

describe('1.14.0 task.continue（验收继续）', () => {
  it('发起方继续 → 账本 submitted→running + run_no+1 + 定向 task.continued', async () => {
    const { leader, target, groupId } = await setupGroup('cont1');
    const taskId = await driveToSubmitted(leader, target, groupId, 'cont1');
    const res = await callRpc(leader, RPC.task.continue, { taskId, requirement: '按主题一写正文' });
    expect((resPayload(res) as { runNo: number }).runNo).toBe(2);
    const row = ledgerRow(taskId)!;
    expect(row.status).toBe('running');
    const runNoRow = db.prepare('SELECT run_no FROM delegations WHERE task_id = ?').get(taskId) as { run_no: number };
    expect(runNoRow.run_no).toBe(2);
    const evt = await target.next((e) => e.kind === 'evt' && e.method === EVT.taskContinued);
    expect(evt.payload).toEqual({ taskId, runNo: 2, requirement: '按主题一写正文' });
  });

  it('非发起方 / 非 submitted / 空白 requirement → forbidden / not_submitted / bad_request', async () => {
    const { leader, target, outsider, groupId } = await setupGroup('cont2');
    const taskId = await driveToSubmitted(leader, target, groupId, 'cont2');
    expect(errOf(await callRpc(outsider, RPC.task.continue, { taskId, requirement: 'x' })).code).toBe('forbidden');
    expect(errOf(await callRpc(leader, RPC.task.continue, { taskId, requirement: '  ' })).code).toBe('bad_request');
    await callRpc(leader, RPC.task.continue, { taskId, requirement: '继续' });
    expect(errOf(await callRpc(leader, RPC.task.continue, { taskId, requirement: '再继续' })).code).toBe('not_submitted');
  });

  it('执行节点协议 <1.14 → peer_version_unsupported 且账本不动', async () => {
    const leader = await connect('cont3-leader');
    const target = await connect('cont3-target', '1.13.1');
    const created = await callRpc(leader, RPC.group.create, { groupName: 'Team-cont3' });
    const { groupId } = resPayload(created) as { groupId: string };
    const { inviteCode } = resPayload(await callRpc(leader, RPC.group.invite, { groupId })) as { inviteCode: string };
    await callRpc(target, RPC.group.join, { inviteCode });
    const taskId = await driveToSubmitted(leader, target, groupId, 'cont3');
    const res = await callRpc(leader, RPC.task.continue, { taskId, requirement: '继续' });
    expect(errOf(res).code).toBe('peer_version_unsupported');
    expect(ledgerRow(taskId)?.status).toBe('submitted');
  });

  it('task.report 携带 deliverable → task.submitted 事件原样透传（优先于 reason JSON）', async () => {
    const { leader, target, groupId } = await setupGroup('cont4');
    const taskId = await delegateOk(leader, delegateReq(groupId, target.nodeId, { workspaceName: 'ws-cont4' }));
    report(target.ws, taskId, { status: 'running' });
    await settle(100);
    const deliverable = { summary: '完整摘要', files: ['a.md'], artifacts: [{ label: 'x', value: 'y' }] };
    report(target.ws, taskId, { status: 'submitted', runNo: 1, reason: '{"summary":"截断"}', deliverable });
    const evt = await leader.next((e) => e.kind === 'evt' && e.method === EVT.taskSubmitted
      && (e.payload as { taskId: string }).taskId === taskId);
    expect((evt.payload as { deliverable: unknown }).deliverable).toEqual(deliverable);
  });
});
```

同步更新 `packages/hub/tests/snapshots.test.ts` 中对 `PROTOCOL_VERSION` 的断言（若硬编码 1.13.x → 改 1.14.0）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/stbearangel/dev/AiProject/momo-hub && npx pnpm@9.0.0 --filter momo-hub exec vitest run tests/delegations.test.ts
```
Expected: FAIL（`RPC.task.continue` undefined）

- [ ] **Step 3: 实现协议包**

`src/version.ts`：`PROTOCOL_VERSION = '1.14.0'`，并在版本注释块补一行：

```ts
// 1.14.0（验收继续 + 结构化交付物，spec moo-studio docs/specs/2026-11-18-acceptance-decision-ux-design.md §7）：
// TASK_RPC 增 task.continue（TaskContinueReq {taskId, requirement 1..4000}/TaskContinueRes {runNo}）、
// EVT 增 task.continued {taskId, runNo, requirement}；TaskReportPayload 增可选 deliverable（16 KiB 上限，
// hub 优先消费、缺省回落 reason-JSON 通道）。
```

`src/delegation.ts`：

```ts
  // 1.14.0（验收继续，门槛 minor 14）：账本 submitted→running + run_no+1，
  // 定向 task.continued 携带 requirement。
  continue: 'task.continue',
```

```ts
/** task.continue 请求（1.14.0，发起方 → hub，门槛 minor 14）：submitted 态
 *  「验收通过并要求继续」——账本 submitted→running + run_no+1（accepted_at 不写，
 *  submitted_at 保留历史），定向 worker task.continued。requirement 为追加要求，
 *  trim 后 1..4000 字。 */
export interface TaskContinueReq { taskId: string; requirement: string }

/** task.continue 响应：新 run 号（与 task.continued 事件一致）。 */
export interface TaskContinueRes { runNo: number }

/** 继续要求长度上限（与 steer message 同界） */
export const CONTINUE_REQUIREMENT_MAX = 4000;

/** task.continue 所需最低 minor（1.14.0） */
export const TASK_CONTINUE_REQUIRED_MINOR = 14;
```

`src/delegation.ts` 的 `TaskReportPayload` 增：

```ts
  /** 结构化交付物（1.14.0，仅 status='submitted' 消费）：hub 优先透传
   *  task.submitted.deliverable；缺省回落 reason-JSON 通道（1.11 兼容）。
   *  JSON.stringify 后 ≤16 KiB，超限 hub 丢弃该键并记录 warn。 */
  deliverable?: Record<string, unknown>;
```

`src/events.ts`：

```ts
  // 1.14.0（验收继续）：发起方「通过并继续」——定向→执行节点，账本已回 running。
  taskContinued: 'task.continued',
```

```ts
/** task.continued（1.14.0）：定向→worker——run #(runNo-1) 已验收通过，请开
 *  run #runNo 并按 requirement 继续；worker 复用 acceptAndContinue 单点写路径。 */
export interface TaskContinuedEvent {
  taskId: string;
  runNo: number;
  requirement: string;
}
```

`src/methods.ts`：

```ts
METHOD_REQUIRED_MINOR[RPC.task.continue] = 14;
```

（常量注释块补一行 1.14.0 说明，不删既有。）

- [ ] **Step 4: 实现 hub handler**

`packages/hub/src/delegations.ts` 在 `handleSteer` 之后新增（照 handleReject 结构）：

```ts
  /**
   * task.continue RPC（1.14.0 验收继续，spec 2026-11-18 §7.1）：发起方（by_node_id）
   * 在 submitted 态要求「通过并继续」——账本 submitted→running + run_no+1，
   * 定向 worker task.continued { taskId, runNo: 新, requirement }。执行节点协议
   * minor <14 时返回 peer_version_unsupported（旧节点无该事件消费者，静默丢事件
   * 会让发起方误以为已继续——必须显式拒）。accepted_at 不写（任务未结束）。
   */
  async handleContinue(ctx: GroupHandlerContext, payload: unknown): Promise<RpcOutcome> {
    const taskId = reqStr(payload, 'taskId');
    if (!taskId) return { ok: false, error: err('bad_request', 'taskId 缺失') };
    const reqRaw = isRecord(payload) ? payload.requirement : undefined;
    const requirement =
      typeof reqRaw === 'string' && reqRaw.trim().length >= 1 && reqRaw.length <= CONTINUE_REQUIREMENT_MAX
        ? reqRaw
        : null;
    if (requirement === null) {
      return { ok: false, error: err('bad_request', `requirement 非法（非空白 1-${CONTINUE_REQUIREMENT_MAX} 字符）`) };
    }
    const row = this.getTask(taskId);
    if (!row) return { ok: false, error: err('not_found', '任务不存在') };
    if (ctx.nodeId !== row.by_node_id) {
      return { ok: false, error: err('forbidden', '仅委派发起方可要求继续') };
    }
    if (row.status !== 'submitted') {
      return { ok: false, error: err('not_submitted', `任务当前状态为 ${row.status}，非待验收态不可继续`) };
    }
    const workerConn = this.registry.get(row.target_node_id);
    const workerMinor = workerConn !== undefined ? minorOf(workerConn.peerProtoVer) : null;
    if (workerMinor === null || workerMinor < TASK_CONTINUE_REQUIRED_MINOR) {
      return {
        ok: false,
        error: err('peer_version_unsupported', `执行节点协议版本不足（需 1.${TASK_CONTINUE_REQUIRED_MINOR}）`),
      };
    }
    const newRunNo = (row.run_no ?? 1) + 1;
    const now = Date.now();
    const upd = this.db
      .prepare("UPDATE delegations SET status = 'running', run_no = ?, updated_at = ? WHERE task_id = ? AND status = 'submitted'")
      .run(newRunNo, now, taskId);
    if (upd.changes !== 1) {
      return { ok: false, error: err('not_submitted', `任务当前状态为 ${row.status}，非待验收态不可继续`) };
    }
    logger.info('委派继续', { taskId, newRunNo, byNode: ctx.nodeId });
    const sent = await this.registry.sendTo(row.target_node_id, {
      v: 1, kind: 'evt', method: EVT.taskContinued,
      payload: { taskId, runNo: newRunNo, requirement } satisfies TaskContinuedEvent,
    });
    if (sent === 'offline') logger.info('继续通知未送达（目标离线，重连对账收敛）', { taskId });
    return { ok: true, payload: { runNo: newRunNo } satisfies TaskContinueRes };
  }
```

`submitted` 上报分支的 deliverable 解析改为优先字段（替换现有 `let deliverable …` 段）：

```ts
      // 1.14.0：结构化 deliverable 优先（TaskReportPayload.deliverable，上限 16 KiB），
      // 缺省回落 1.11 的 reason-JSON 通道（旧节点零破坏）。
      let deliverable: Record<string, unknown> | undefined;
      if (isRecord(report.deliverable)) {
        const size = Buffer.byteLength(JSON.stringify(report.deliverable), 'utf8');
        if (size <= DELIVERABLE_MAX_BYTES) deliverable = report.deliverable;
        else logger.warn('deliverable 超限被丢弃（回落 reason 通道）', { taskId: row.task_id, size });
      }
      if (deliverable === undefined && report.reason !== undefined) {
        try {
          const parsed: unknown = JSON.parse(report.reason);
          if (isRecord(parsed)) deliverable = parsed;
        } catch { /* 非 JSON 串——不带 deliverable 键 */ }
      }
```

同文件加常量：

```ts
/** 结构化交付物体积上限（spec 2026-11-18 §7.3） */
const DELIVERABLE_MAX_BYTES = 16 * 1024;
```

`packages/hub/src/server.ts` 的 `[RPC.task.reject]` 之后：

```ts
    // 1.14.0 验收继续：发起方（by_node_id）特权——非 leader-only，权限锚在
    // handler 来源校验（delegations.handleContinue）
    [RPC.task.continue]: (ctx, payload) => delegationRouter.handleContinue(ctx, payload),
```

- [ ] **Step 5: 跑测试**

```bash
cd /Users/stbearangel/dev/AiProject/momo-hub && npx pnpm@9.0.0 build && npx pnpm@9.0.0 --filter momo-hub exec vitest run tests/delegations.test.ts tests/snapshots.test.ts
```
Expected: PASS

- [ ] **Step 6: 提交 + tag（本地）**

```bash
cd /Users/stbearangel/dev/AiProject/momo-hub
git add src packages/hub/src packages/hub/tests
git commit -m "feat(protocol): 1.14.0——task.continue/task.continued 验收继续 + report.deliverable 结构化交付物"
git tag v0.7.7
git push origin main --tags
```

---

### Task 7: studio 上报结构化交付物 + 截断算法

**Files:**
- Modify: `electron/src/main/hub/delegation-wire.ts`（`TaskReportPayload.deliverable`）
- Modify: `electron/src/main/hub/remote-intervene-bridge.ts`（`buildDeliverableReason` + `submitToHub`）
- Test: `electron/tests/hub/worker-intervene-bridge.test.ts` 或新建 `electron/tests/hub/deliverable-fidelity.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `deliverable` 字段
- Produces: 上报同时带 `reason`（旧 hub 降级）与 `deliverable`（1.14 全量）

- [ ] **Step 1: 写失败测试**

新建 `electron/tests/hub/deliverable-fidelity.test.ts`：

```ts
// 交付物保真（spec 2026-11-18 §7.3/DEC-19）：
// 1) buildDeliverableReason 超限时保 files/artifacts，只截 summary；
// 2) submitToHub 同时发 deliverable（全量）与 reason（降级串）。
import { describe, it, expect } from 'vitest';
import { buildDeliverableReason } from '../../src/main/hub/remote-intervene-bridge';

describe('buildDeliverableReason', () => {
  it('放得下 → 全量 JSON', () => {
    const out = buildDeliverableReason({ summary: '短摘要', files: ['a.md'] });
    expect(JSON.parse(out)).toEqual({ summary: '短摘要', files: ['a.md'], artifacts: [] });
  });

  it('超限 → 保留 files/artifacts，summary 截断', () => {
    const out = buildDeliverableReason({
      summary: '长'.repeat(2000),
      files: ['二十四节气散文-三个候选主题.md'],
      artifacts: [{ label: '三个候选主题', value: '1. 春雷落处\n2. 长昼如沸' }],
    });
    expect(out.length).toBeLessThanOrEqual(512);
    const parsed = JSON.parse(out) as { summary: string; files: string[]; artifacts: unknown[] };
    expect(parsed.files).toEqual(['二十四节气散文-三个候选主题.md']);
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.summary.length).toBeLessThan(2000);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/hub/deliverable-fidelity.test.ts
```
Expected: FAIL（超限时 files 丢失）

- [ ] **Step 3: 实现**

`delegation-wire.ts` 的 `TaskReportPayload` 增：

```ts
  /** 结构化交付物（1.14.0，仅 submitted 上报携带）：hub 优先透传；reason 仍带
   *  摘要串作旧 hub（<1.14）降级通道。 */
  deliverable?: Record<string, unknown>;
```

`remote-intervene-bridge.ts` 重写 `buildDeliverableReason`：

```ts
/** 交付物体积/截断预算（reason 上限由 hub REASON_MAX=512 把守） */
const REASON_MAX_BYTES = 512;
const FILES_MAX = 20;
const ARTIFACTS_MAX = 10;

/**
 * deliverable → report.reason（旧 hub <1.14 降级通道，spec 2026-11-18 §7.3）：
 * 1.14 hub 优先消费 deliverable 字段，本函数只服务旧 hub——因此必须在 512 字符
 * 内尽量保住结构化信息：先保 files/artifacts（各截条数），再用剩余预算截 summary；
 * 实在放不下才退化为 summary-only。
 */
export function buildDeliverableReason(deliverable: {
  summary: string;
  files?: string[];
  artifacts?: Array<{ label: string; value: string }>;
}): string {
  const files = (deliverable.files ?? []).slice(0, FILES_MAX);
  const artifacts = (deliverable.artifacts ?? []).slice(0, ARTIFACTS_MAX).map((a) => ({
    label: truncateCodePoints(a.label, 40),
    value: truncateCodePoints(a.value, 80),
  }));
  const full = JSON.stringify({ summary: deliverable.summary, files, artifacts });
  if (full.length <= REASON_MAX_BYTES) return full;
  let take = 160;
  while (take > 0) {
    const candidate = JSON.stringify({ summary: truncateCodePoints(deliverable.summary, take), files, artifacts });
    if (candidate.length <= REASON_MAX_BYTES) return candidate;
    take = Math.floor(take / 2);
  }
  return JSON.stringify({ summary: truncateCodePoints(deliverable.summary, 80) });
}
```

`submitToHub` 的 `sendRes` 载荷追加 `deliverable`：

```ts
    const sent = client.sendRes(task.delegationId, TASK_WIRE.report, {
      status: 'submitted',
      runNo: e.runNo,
      reason: buildDeliverableReason(e.deliverable),
      // 1.14 hub 优先消费；旧 hub 剥除未知字段（零破坏）
      deliverable: {
        summary: e.deliverable.summary,
        files: e.deliverable.files ?? [],
        artifacts: e.deliverable.artifacts ?? [],
      },
    });
```

- [ ] **Step 4: 跑测试**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/hub/deliverable-fidelity.test.ts tests/hub/worker-intervene-bridge.test.ts tests/hub/worker-terminal-consume.test.ts
```
Expected: PASS（既有 bridge 用例不回归）

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/hub/delegation-wire.ts electron/src/main/hub/remote-intervene-bridge.ts electron/tests/hub/deliverable-fidelity.test.ts
git commit -m "feat(hub-bridge): 上报结构化 deliverable + reason 降级保留 files/artifacts"
```

---

### Task 8: worker 消费 `task.continued`

**Files:**
- Modify: `electron/src/main/hub/remote-intervene-bridge.ts`（`settleDocked` 类型 + `handleTaskContinued` + `injectContinuedIntoExecutionSession`）
- Modify: `electron/src/main/hub/delegation-runner.ts:879-893`（`settleAcceptance` 支持 `'continued'`）
- Modify: `electron/src/main/hub/index.ts`（`task.continued` 事件接线）
- Test: `electron/tests/hub/worker-continue-consume.test.ts`（新建）

**Interfaces:**
- Consumes: `acceptAndContinue`（Task 2）、`TaskContinuedEvent`（Task 6）
- Produces: `handleTaskContinued(payload, ports)`；`settleDocked(taskId, 'accepted' | 'rejected' | 'continued')`

- [ ] **Step 1: 写失败测试**

新建 `electron/tests/hub/worker-continue-consume.test.ts`（骨架照 `worker-terminal-consume.test.ts`，含 router/push mock）：

```ts
// task.continued worker 消费契约（spec 2026-11-18 §7.2）：
// 1) submitted 承接行 → acceptAndContinue + 里程碑 kind='continued' + 注入要求 + 停靠出清；
// 2) 非 submitted / 终态 / 无承接行 → 静默幂等收敛（不复活任务、不建 run）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { routeUserChatMock, pushSessionMessageMock } = vi.hoisted(() => ({
  routeUserChatMock: vi.fn<(input: unknown) => Promise<void>>(),
  pushSessionMessageMock: vi.fn<(msg: unknown) => void>(),
}));
vi.mock('../../src/main/agent/router-bootstrap', () => ({
  getRouterService: () => ({ routeUserChat: routeUserChatMock }),
}));
vi.mock('../../src/main/agent/stream-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/agent/stream-relay')>()),
  pushSessionMessage: (msg: unknown) => pushSessionMessageMock(msg),
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask } from '../../src/main/storage/tasks/repo';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import { listRuns } from '../../src/main/storage/tasks/runs-repo';
import { startRun, submitRun } from '../../src/main/task/lifecycle-runs';
import {
  handleTaskContinued,
  type WorkerTerminalConsumePorts,
} from '../../src/main/hub/remote-intervene-bridge';

const SELF_NODE = 'node-self';
const DELEGATION_ID = 'dl-cont-consume';
const tmpRoot = path.join(os.tmpdir(), `ap-continue-consume-${Date.now()}-${Math.random().toString(36).slice(2)}`);
let sessionId = '';
const settleDocked = vi.fn();

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb().prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  sessionId = insertSession({ workspaceId: 'ws1', title: '执行', kind: 'chat' }).id;
  addSessionMember(sessionId, 'agent-1', true);
  routeUserChatMock.mockReset().mockResolvedValue(undefined);
  pushSessionMessageMock.mockClear();
  settleDocked.mockClear();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

const ports: WorkerTerminalConsumePorts = {
  selfNodeId: () => SELF_NODE,
  settleDocked: (taskId, outcome) => settleDocked(taskId, outcome),
};

async function seedSubmitted(): Promise<string> {
  const t = insertTask({
    workspaceId: 'ws1', title: 'T', creatorUserId: '@owner:home', assigneeAgentId: 'agent-1',
    status: 'assigned', delegationId: DELEGATION_ID, delegationRole: 'in',
    executionSessionId: sessionId,
  });
  startRun(t.id, { trigger: 'initial' });
  await submitRun(t.id, { summary: '第 1 轮' });
  return t.id;
}

describe('handleTaskContinued', () => {
  it('submitted → 续作 run#2 + 里程碑 continued + 注入要求 + 停靠出清', async () => {
    const id = await seedSubmitted();
    handleTaskContinued({ taskId: DELEGATION_ID, runNo: 2, requirement: '按主题一写正文' }, ports);
    expect(getTask(id)!.status).toBe('in_progress');
    expect(listRuns(id)).toHaveLength(2);
    expect(listRuns(id)[1].trigger).toBe('continue');
    const msg = pushSessionMessageMock.mock.calls.at(-1)?.[0] as { body: string };
    expect(msg.body).toContain('【发起方要求继续】按主题一写正文');
    expect(routeUserChatMock).toHaveBeenCalled();
    expect(settleDocked).toHaveBeenCalledWith(DELEGATION_ID, 'continued');
  });

  it('任务已终态 / 非 submitted / 空白要求 → 静默零写入', async () => {
    const id = await seedSubmitted();
    handleTaskContinued({ taskId: DELEGATION_ID, runNo: 2, requirement: '   ' }, ports);
    expect(getTask(id)!.status).toBe('submitted');
    handleTaskContinued({ taskId: DELEGATION_ID, runNo: 2, requirement: '继续' }, ports);
    handleTaskContinued({ taskId: DELEGATION_ID, runNo: 3, requirement: '再继续' }, ports);
    expect(listRuns(id)).toHaveLength(2); // 第二次是重复事件，非 submitted 后不再建 run
    expect(settleDocked).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/hub/worker-continue-consume.test.ts
```
Expected: FAIL（`handleTaskContinued` 未导出）

- [ ] **Step 3: 实现**

`delegation-runner.ts`：`settleAcceptance` 签名与实现

```ts
  settleAcceptance(taskId: string, outcome: 'accepted' | 'rejected' | 'continued'): void;
```
```ts
      if (outcome === 'accepted') {
        store.updateState(taskId, 'done');
      } else if (outcome === 'continued') {
        // 验收继续：任务未结束——本地委派账本回 running，等本轮回合终态重新停靠
        store.updateState(taskId, 'running');
      }
```

`remote-intervene-bridge.ts`：`WorkerTerminalConsumePorts.settleDocked` 联合类型加 `'continued'`；新增：

```ts
/** 继续要求注入（spec 2026-11-18 DEC-15）：复用 steer 注入管线，尾行明示复提契约 */
function injectContinuedIntoExecutionSession(task: TaskRow, requirement: string): void {
  injectExecutionSessionNotice(task, {
    body: `【发起方要求继续】${requirement}\n完成后请再次调用 submit_task 提交。`,
    kind: 'continued',
    meta: { requirement: truncateCodePoints(requirement, 79) },
    logLabel: '【发起方要求继续】',
  });
}

/**
 * task.continued 事件消费（hub/index onEvent 装配；spec 2026-11-18 §7.2）：
 * run#(runNo-1) 已验收通过 → acceptAndContinue（run accepted + 新 run + 答复）
 * + 里程碑 kind='continued' + 注入要求 + 停靠出清（continued 变体）。
 * 幂等：无承接行 / 终态 / 非 submitted → 静默；total 语义不向上抛。
 */
export function handleTaskContinued(payload: unknown, ports: WorkerTerminalConsumePorts): void {
  try {
    if (typeof payload !== 'object' || payload === null) return;
    const p = payload as { taskId?: unknown; runNo?: unknown; requirement?: unknown };
    if (typeof p.requirement !== 'string' || p.requirement.trim() === '') return;
    const resolved = resolveWorkerTask(p.taskId, ports.selfNodeId());
    if (resolved === null) {
      logger.info('继续指令到达但无本机承接行（幂等收敛，丢弃）', {
        taskId: typeof p.taskId === 'string' ? p.taskId : undefined,
      });
      return;
    }
    const { task, delegationId } = resolved;
    if (isTerminal(task.status) || task.status !== 'submitted') {
      logger.info('继续指令到达但任务非 submitted（乱序/迟到，丢弃）', {
        taskId: task.id,
        status: task.status,
      });
      return;
    }
    const requirement = p.requirement.trim();
    acceptAndContinue(task.id, requirement, REMOTE_ORIGIN_BY);
    const runNo = payloadRunNo(p.runNo);
    writeSessionMilestone(
      task,
      `已要求继续（第 ${runNo !== undefined ? runNo - 1 : '?'} 轮通过）：${truncateCodePoints(requirement, 60)}`,
      { kind: 'continued', ...(runNo !== undefined ? { runNo } : {}) },
    );
    injectContinuedIntoExecutionSession(getTask(task.id) ?? task, requirement);
    ports.settleDocked(delegationId, 'continued');
    logger.info('远端继续已消费（acceptAndContinue + 注入）', { taskId: task.id, delegationId });
  } catch (err) {
    logger.warn('远端继续消费内部异常（事件丢弃，S7 对账兜底）', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

注意：`writeSessionMilestone` / `injectExecutionSessionNotice` 取的是任务行；`acceptAndContinue` 后任务已变 `in_progress`，因此注入前用 `getTask(task.id) ?? task` 取新行（`injectExecutionSessionNotice` 只读 `executionSessionId`）。

`hub/index.ts` 在 `EVT.taskSteered` 分支之后：

```ts
      if (evt.method === EVT.taskContinued) {
        // worker 侧验收继续消费（1.14.0，spec 2026-11-18 §7.2）：账本已回 running
        // （hub 单源），本地 acceptAndContinue + 注入要求 + 停靠出清。
        handleTaskContinued(evt.payload, terminalConsumePorts());
        return;
      }
```

并补 import：`handleTaskContinued`。

- [ ] **Step 4: 跑测试**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/hub/worker-continue-consume.test.ts tests/hub/worker-terminal-consume.test.ts tests/hub/delegation-runner.test.ts
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/hub/remote-intervene-bridge.ts electron/src/main/hub/delegation-runner.ts electron/src/main/hub/index.ts electron/tests/hub/worker-continue-consume.test.ts
git commit -m "feat(hub-bridge): task.continued worker 消费——acceptAndContinue + 要求注入 + 停靠出清"
```

---

### Task 9: 卡片文案统一 + 镜像截断标注

**Files:**
- Modify: `electron/src/main/task/lifecycle-runs.ts:541-559`（submitRun 的 title/prompt）
- Modify: `electron/src/main/hub/remote-intervene-bridge.ts:1291-1316`（镜像 title/prompt + truncated）
- Test: `electron/tests/task/lifecycle-runs-submit.test.ts`、`electron/tests/hub/worker-terminal-consume.test.ts`（镜像断言所在文件）

**Interfaces:**
- Produces: acceptance `title = 第 N 轮交付`、`prompt = 任务标题`、`payload.remote.truncated? = true`

- [ ] **Step 1: 写失败测试**

`lifecycle-runs-submit.test.ts:138`（现为 `expect(req.title).toContain(taskId)`）改为：

```ts
    expect(req.title).toBe('第 1 轮交付');
    expect(req.prompt).toBe('T');
```

`electron/tests/hub/origin-submitted-mirror.test.ts:455`（现为 ``expect(row.title).toBe(`#${task.id} 提交验收（run #1）`)``）改为：

```ts
    expect(row.title).toBe('第 1 轮交付');
    expect(row.prompt).toBe('T'); // 种子任务标题
```

并在该文件用例中补一条截断标注断言（同一行对象）：

```ts
    expect((JSON.parse(row.payloadJson!) as { remote?: { truncated?: boolean } }).remote?.truncated).toBe(true);
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/task/lifecycle-runs-submit.test.ts
```
Expected: FAIL（title 仍是 `T-… 提交验收（run #1）`）

- [ ] **Step 3: 实现**

`submitRun` 的 `insertHumanRequest`：

```ts
      title: `第 ${active.runNo} 轮交付`,
      prompt: task.title,
```

镜像插入（`remote-intervene-bridge.ts`）：

```ts
      title: `第 ${runNo} 轮交付`,
      prompt: task.title,
```
```ts
      payloadJson: JSON.stringify(
        withRemoteSegment(
          { acceptance: { runNo, summary: deliverable.summary, files: deliverable.files, artifacts: deliverable.artifacts } },
          workstation,
          p.deliverable === undefined,
        ),
      ),
```

`withRemoteSegment` 扩参：

```ts
function withRemoteSegment(
  base: Record<string, unknown> | undefined,
  workstation: string | null,
  truncated: boolean,
): Record<string, unknown> | undefined {
  if (base === undefined && workstation === null && !truncated) return undefined;
  const rest = { ...(base ?? {}) };
  delete rest.remote;
  const remote: Record<string, unknown> = {};
  if (workstation !== null) remote.workstation = workstation;
  if (truncated) remote.truncated = true;
  return { ...rest, ...(Object.keys(remote).length > 0 ? { remote } : {}) };
}
```

- [ ] **Step 4: 跑测试**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/task/lifecycle-runs-submit.test.ts tests/hub/origin-submitted-mirror.test.ts tests/hub/simhub-interventions.test.ts
```
Expected: PASS（其他断言按新 title/prompt 同步更新）

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/task/lifecycle-runs.ts electron/src/main/hub/remote-intervene-bridge.ts electron/tests/task/lifecycle-runs-submit.test.ts electron/tests/hub/origin-submitted-mirror.test.ts
git commit -m "feat(acceptance): 卡片标题统一「第 N 轮交付」+ 镜像截断标记"
```

---

### Task 10: 验收卡重构（三动作 / 只读 / Markdown / 折叠）

**Files:**
- Modify: `renderer/src/components/im/HumanRequestPanel.tsx:612-697`（`AcceptanceBody` 重写 + `DeliverableBlock`）+ `701-729`（`KindCard` 分叉）
- Test: `renderer/src/components/im/HumanRequestPanel.test.tsx`

**Interfaces:**
- Consumes: `HumanRequestRow.canDecide`（Task 3）、`ipc.task.continue`（Task 5）
- Produces: 三动作卡（继续/完成/驳回）、只读卡

- [ ] **Step 1: 更新测试（先改断言为新契约）**

`HumanRequestPanel.test.tsx`：

1) `mockApi.task` 增 `continueMock` 与 `continue: continueMock`。
2) `makeRow` 增 `canDecide: true` 默认。
3) 替换原 acceptance 用例（288-302、527、549-578 附近）：

```tsx
  it('渲染交付摘要（Markdown）/ 文件 / 产物；继续 → 必填要求后调 task.continue', async () => {
    listMock.mockResolvedValue([makeRow({
      kind: 'acceptance', title: '第 1 轮交付', taskId: 'T-1',
      payloadJson: ACCEPTANCE_JSON.replace('回调重试改为幂等键 + 指数退避', '**粗体**摘要'),
    })]);
    await mountPanel();
    // Markdown 已渲染（不再出现字面量 **）
    expect(screen.queryByText(/\*\*粗体\*\*摘要/)).not.toBeInTheDocument();
    expect(screen.getByText('粗体')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    const input = screen.getByLabelText('下一步要求');
    expect(screen.getByRole('button', { name: '发送要求并继续' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '按主题一写正文' } });
    fireEvent.click(screen.getByRole('button', { name: '发送要求并继续' }));
    await act(async () => {});
    expect(continueMock).toHaveBeenCalledWith('T-1', '按主题一写正文');
  });

  it('完成 → 二次确认后才调 task.accept', async () => {
    listMock.mockResolvedValue([makeRow({ kind: 'acceptance', title: '第 1 轮交付', taskId: 'T-1', payloadJson: ACCEPTANCE_JSON })]);
    await mountPanel();
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(acceptMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '完成', hidden: false }));
    // ConfirmDialog 的确认钮与卡片按钮同名——以对话框内「完成」二次点击收口
    await act(async () => {});
    expect(acceptMock).toHaveBeenCalledWith('T-1');
  });

  it('驳回 → 展开理由必填，空理由禁用确认', async () => {
    listMock.mockResolvedValue([makeRow({ kind: 'acceptance', title: '第 1 轮交付', taskId: 'T-1', payloadJson: ACCEPTANCE_JSON })]);
    await mountPanel();
    fireEvent.click(screen.getByRole('button', { name: '驳回' }));
    expect(screen.getByRole('button', { name: '确认驳回' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('驳回理由'), { target: { value: '主题不新' } });
    fireEvent.click(screen.getByRole('button', { name: '确认驳回' }));
    await act(async () => {});
    expect(rejectMock).toHaveBeenCalledWith('T-1', '主题不新');
  });

  it('执行方（canDecide=false）→ 只读卡：零按钮零输入 + 等待发起方裁决', async () => {
    listMock.mockResolvedValue([makeRow({
      kind: 'acceptance', title: '第 1 轮交付', taskId: 'T-1', canDecide: false,
      originNodeId: 'node-a', payloadJson: ACCEPTANCE_JSON,
    })]);
    await mountPanel();
    expect(screen.getByText(/等待发起方裁决/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('驳回理由')).not.toBeInTheDocument();
  });

  it('镜像行 remote.truncated → 显示截断警示', async () => {
    listMock.mockResolvedValue([makeRow({
      kind: 'acceptance', taskId: 'T-1', originNodeId: 'node-b',
      payloadJson: JSON.stringify({ acceptance: { runNo: 1, summary: 'x', files: [], artifacts: [] }, remote: { truncated: true } }),
    })]);
    await mountPanel();
    expect(screen.getByText(/交付内容经旧版通道截断/)).toBeInTheDocument();
  });
```

> 「完成」确认框与卡片按钮同名，实施时给 ConfirmDialog 的确认钮传 `confirmLabel="确认完成"`，并把上面的断言改为 `{ name: '确认完成' }`——**以实际实现为准，同步改测试**。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/HumanRequestPanel.test.tsx
```
Expected: FAIL（按钮不存在）

- [ ] **Step 3: 实现卡片**

`HumanRequestPanel.tsx` 新增 `DeliverableBlock`（放 `AcceptanceBody` 之前）：

```tsx
/** 长交付说明折叠阈值（行数/字数启发式，jsdom 可测；spec DEC-22） */
const SUMMARY_COLLAPSE_LINES = 12;
const SUMMARY_COLLAPSE_CHARS = 600;

function DeliverableBlock({ payload, fallback, truncated }: {
  payload: AcceptancePayload | null;
  fallback: string;
  truncated: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const body = payload?.summary ?? fallback;
  const long = body.split('\n').length > SUMMARY_COLLAPSE_LINES || body.length > SUMMARY_COLLAPSE_CHARS;
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] font-medium text-tertiary">交付说明</div>
      <div className={cn('text-[11.5px] leading-[1.7] text-primary', long && !expanded && 'max-h-[14rem] overflow-hidden')}>
        <MarkdownBody>{body}</MarkdownBody>
      </div>
      {long && (
        <button type="button" className="self-start text-[11px] text-accent-600 hover:underline dark:text-accent-300"
          onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : '展开全文'}
        </button>
      )}
      {payload !== null && payload.files.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-medium text-tertiary">文件</div>
          <Chips items={payload.files} />
        </div>
      )}
      {payload !== null && payload.artifacts.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-medium text-tertiary">产物</div>
          {payload.artifacts.map((a) => (
            <div key={a.label} className="flex items-start gap-1.5 text-[11.5px] text-secondary">
              <CircleCheck size={12} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-status-success" />
              <span className="whitespace-pre-wrap break-words">
                {a.label}
                {a.value !== '' ? `：${a.value}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      {truncated && (
        <p className="text-[10.5px] text-status-warning" role="alert">
          交付内容经旧版通道截断，完整内容请在执行节点查看
        </p>
      )}
    </div>
  );
}
```

`AcceptanceBody` 重写：

```tsx
type AcceptanceAction = 'continue' | 'reject';

/** 镜像交付物截断标记（旧执行节点/旧 hub 上报缺 deliverable 时由镜像消费写入） */
function isTruncatedMirror(row: HumanRequestRow): boolean {
  const parsed = parseJson(row.payloadJson);
  if (typeof parsed !== 'object' || parsed === null) return false;
  return (parsed as { remote?: { truncated?: unknown } }).remote?.truncated === true;
}

function AcceptanceBody({ row, onError, onRemoteWarning }: {
  row: HumanRequestRow;
  onError: (msg: string) => void;
  onRemoteWarning: (msg: string | null) => void;
}) {
  const loadPending = useHumanStore((s) => s.loadPending);
  const payload = parseAcceptance(row);
  const truncated = isTruncatedMirror(row);
  const [action, setAction] = useState<AcceptanceAction | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const canOperate = row.taskId !== null && row.canDecide !== false;

  const operate = (fn: () => Promise<{ remoteWarning?: string } | void>): void => {
    setBusy(true);
    fn()
      .then((res) => {
        const warning = res && typeof res === 'object' && typeof res.remoteWarning === 'string' ? res.remoteWarning : null;
        onRemoteWarning(warning);
        setAction(null);
        setText('');
        return loadPending(row.sessionId);
      })
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  if (row.taskId === null || row.canDecide === false) {
    return (
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <DeliverableBlock payload={payload} fallback={row.prompt} truncated={truncated} />
        <p className="text-[10.5px] text-tertiary">
          {row.originNodeName !== null && row.originNodeName !== undefined
            ? `发起方在 ${row.originNodeName} 上裁决，结果会显示在这里`
            : '等待发起方裁决，结果会显示在这里'}
        </p>
      </div>
    );
  }

  const expandLabel = action === 'continue' ? '下一步要求' : '驳回理由';

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <DeliverableBlock payload={payload} fallback={row.prompt} truncated={truncated} />
      <div className="flex flex-wrap items-center gap-[7px]">
        <Button variant="primary" size="sm" className={BTN_SM} disabled={busy}
          onClick={() => { setAction('continue'); setText(''); }}>
          继续
        </Button>
        <Button size="sm" className={cn(BTN_SM, 'border border-strong bg-surface-1 text-primary hover:bg-surface-3')}
          disabled={busy} onClick={() => setConfirmFinish(true)}>
          完成
        </Button>
        <Button variant="danger-outline" size="sm" className={BTN_SM} disabled={busy}
          onClick={() => { setAction('reject'); setText(''); }}>
          驳回
        </Button>
      </div>
      <p className="text-[10.5px] text-tertiary">
        继续 = 认可本轮，按你的要求让它再跑一轮（任务继续）· 完成 = 结束任务（不可撤销）· 驳回 = 退回重做
      </p>
      {action !== null && (
        <div className="flex flex-col gap-1.5">
          <textarea
            aria-label={expandLabel}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder={action === 'continue' ? '写清下一步要它做什么（必填）…' : '写清退回原因（必填）…'}
            className="w-full resize-none rounded-md border border-subtle bg-surface-2 px-[9px] py-[7px] text-xs leading-[1.6] text-primary placeholder:text-tertiary focus:border-focus focus:outline-none"
          />
          <div className="flex items-center gap-[7px]">
            <Button variant="primary" size="sm" className={BTN_SM}
              disabled={busy || text.trim() === ''}
              onClick={() => operate(action === 'continue'
                ? () => ipc.task.continue(row.taskId!, text.trim())
                : () => ipc.task.reject(row.taskId!, text.trim()))}>
              {action === 'continue' ? '发送要求并继续' : '确认驳回'}
            </Button>
            <Button variant="ghost" size="sm" className={BTN_SM} onClick={() => setAction(null)}>
              取消
            </Button>
          </div>
        </div>
      )}
      {confirmFinish && (
        <ConfirmDialog
          title="验收完成"
          message={`将结束任务 ${row.prompt !== '' ? row.prompt : ''}，完成后不可撤销。`}
          confirmLabel="确认完成"
          onConfirm={() => operate(() => ipc.task.accept(row.taskId!))}
          onClose={() => setConfirmFinish(false)}
        />
      )}
    </div>
  );
}
```

`KindCard` 中验收卡不再受 `peerMirror` 特判影响（现状已排除 acceptance，保持），无需改；只需确认 `AcceptanceBody` 的新 props 签名一致。

导入：`MarkdownBody`、`ConfirmDialog`。

- [ ] **Step 4: 跑测试**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/HumanRequestPanel.test.tsx
```
Expected: PASS（按实际 ConfirmDialog 文案与 Step 1 同步）

- [ ] **Step 5: 提交**

```bash
git add renderer/src/components/im/HumanRequestPanel.tsx renderer/src/components/im/HumanRequestPanel.test.tsx
git commit -m "feat(acceptance): 三动作裁决卡（继续/完成/驳回）+ 执行方只读卡 + Markdown/折叠渲染"
```

---

### Task 11: 待裁决期禁用补充指令框

**Files:**
- Modify: `renderer/src/components/hub/RemoteSteerComposer.tsx:23-52`
- Test: `renderer/src/components/hub/RemoteSteerComposer.test.tsx`

**Interfaces:**
- Consumes: `useRemoteSessionStore.task.status`
- Produces: `submitted` 时禁用 + placeholder `等待你的裁决——裁决后可继续补充指令`

- [ ] **Step 1: 写失败测试**

```tsx
  it('任务 submitted（待裁决）→ 输入禁用 + 占位提示（DEC-10）', () => {
    seedTask({ status: 'submitted' }); // 沿用该文件既有 store 种子写法
    render(<RemoteSteerComposer />);
    const input = screen.getByTestId('remote-steer-input') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('等待你的裁决——裁决后可继续补充指令');
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/hub/RemoteSteerComposer.test.tsx
```
Expected: FAIL

- [ ] **Step 3: 实现**

```tsx
  const terminal = task !== null && isTerminalStatus(task.status);
  const awaitingDecision = task !== null && task.status === 'submitted';
  const disabled = terminal || awaitingDecision;
```
`disabled={disabled}`；`canSend` 增加 `&& !awaitingDecision`；placeholder 三态：

```tsx
          placeholder={
            terminal
              ? '任务已结束'
              : awaitingDecision
                ? '等待你的裁决——裁决后可继续补充指令'
                : '补充指令…（Enter 发送 · Shift+Enter 换行）'
          }
```

- [ ] **Step 4: 跑测试**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/hub/RemoteSteerComposer.test.tsx src/components/hub/RemoteSessionPanel.test.tsx
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add renderer/src/components/hub/RemoteSteerComposer.tsx renderer/src/components/hub/RemoteSteerComposer.test.tsx
git commit -m "feat(composer): 待裁决期禁用补充指令框——一屏只有一个输入口"
```

---

### Task 12: 端到端复验、回执与版本收尾

**Files:**
- Modify: `docs/specs/2026-11-18-acceptance-decision-ux-design.md`（补交付回执节）
- Modify: `CHANGELOG.md`（研发账本新条目）
- Modify: `package.json` / `electron/package.json` / `renderer/package.json`（`2.1.0-alpha.72` → `2.1.0-alpha.73`）
- Modify: `electron/package.json`（pin `momo-hub-protocol` → `#v0.7.7`）

- [ ] **Step 1: 升级 pin 并重装**

```bash
cd /Users/stbearangel/dev/AiProject/moo-studio
# 手工把 electron/package.json 的 momo-hub-protocol 改成 github:bearangel/momo-hub#v0.7.7
npx pnpm@9.0.0 install
npx pnpm@9.0.0 typecheck
```
Expected: typecheck 0

- [ ] **Step 2: 跑全量门**

```bash
npx pnpm@9.0.0 test
npx pnpm@9.0.0 lint
```
Expected: electron / renderer 全绿；lint 0 error（存量 warning 不计）

- [ ] **Step 3: 真机 A/B 复验（10 项）**

按既有拓扑启动（vite + hub 9801 + 实例 A/B 各带独立 `AP_USER_DATA_DIR` / `--user-data-dir`），逐项确认：

1. B 侧验收卡为只读（无按钮/输入框），文案「等待发起方裁决」。
2. A 侧卡片显示完整交付：summary 与 B 一致（含未被截断的结尾）、files 与 artifacts 齐全。
3. A 侧「继续」→ 填「按主题一写正文」→ B 立即出现「【发起方要求继续】…」里程碑并开新回合。
4. B 侧任务状态回 `in_progress`，B 卡片消失（旧验收单已答）。
5. B 再次 `submit_task` → A 侧出现「第 2 轮交付」卡片（标题不含任务 id）。
6. A 侧「完成」→ 二次确认 → 任务 `completed`，B 侧任务同步完成。
7. A 侧「驳回」+ 理由 → B 收「【发起方打回】…」，返工 run 建立。
8. 待裁决期 A 的补充指令框禁用且提示正确；尝试绕过（IPC 直调）被拒。
9. 双节点关闭 hub 后点「继续」→ 人话错误、卡片保持待裁决、本地任务仍 `submitted`。
10. 查库：`task_runs` 中 continue 后 run#N+1 `trigger='continue'`；`human_requests.answer_json` 含 requirement。

- [ ] **Step 4: 写回执与 CHANGELOG**

spec 末尾追加「## 13. 交付回执」：记录 10 项复验结果、偏离项、遗留 minor；CHANGELOG 加一条研发账本条目（中文，含 spec 路径与 DEC 编号）。

- [ ] **Step 5: 版本号 +1（只改 alpha）**

三处 `package.json` 的 `2.1.0-alpha.72` → `2.1.0-alpha.73`（根 / electron / renderer）。

- [ ] **Step 6: 提交**

```bash
git add CHANGELOG.md docs/specs/2026-11-18-acceptance-decision-ux-design.md package.json electron/package.json renderer/package.json pnpm-lock.yaml
git commit -m "chore(release): alpha.73——验收裁决 UX（三动作/只读卡/续作 run/协议 1.14）"
```

---

## Self-Review

**Spec 覆盖**：§3→Task 3；§4/§4.1.1→Task 10；§5（DEC-5~9）→Task 2/5/10；§5.1（DEC-10~11）→Task 4/11；§6（DEC-12~16）→Task 1/2/5；§7（DEC-17~19）→Task 6/7；§8→Task 9/10；§9→Task 5/8/10；§10→各任务测试；§11 阶段顺序→任务编号顺序。无遗漏。

**占位扫描**：Task 3 Step 1 的「占位式写法」块已显式标注「不要照抄」，紧随其后给出真实测试代码；其余无 TBD/TODO。

**类型一致**：`acceptAndContinue` / `continueTaskRouted` / `ContinueForwardInput` / `setContinueForwarder` / `handleTaskContinued` / `settleDocked(...,'continued')` / `canDecide` / `remote.truncated` 在定义任务与消费任务中命名一致。

**Review Focus 对应测试**：①Task 2 空白/超限；②Task 8 终态静默；③Task 5 远端失败 + Task 6 `peer_version_unsupported`；④Task 7 截断 + Task 10 `truncated` 警示；⑤Task 2 第二次 continue 人话拒（run 数不变）。
