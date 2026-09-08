# 会话车道与 steer 注入实施计划（v2.3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一会话同一时刻至多一条顶层活跃流（看板任务排队 `session_queued`），活跃流期间用户手输以 steer 在下一个 LLM 轮次注入；顺带修复任务暂停误杀同会话 dispatch 子流。

**Architecture:** 新增内存态车道注册表（session-lane 模块，`Map<sessionId, {taskId, streamSessionId, assignmentId}>`）；executor 放行前查车道，被占则任务转 `session_queued`；routeUserChat 分流（kickoff 注册车道 / 活跃期手输 steer 注入子进程 / 空闲正常派发）；runtime-entry 在 abort 监听器上扩展 steer 分支，chat loop 每轮构建 LLM 请求前 drain；任务暂停经 taskId 反查车道精确 abort。

**Tech Stack:** Electron 主进程（CommonJS）+ better-sqlite3 + vitest；renderer React + zustand。

**Spec:** `docs/specs/2026-09-08-session-lane-steer-design.md`（本计划的唯一上游依据）

## Global Constraints

- Node 20 LTS：容器内必须先 `nvm use 20`（默认 Node 26 破坏 better-sqlite3）
- pnpm 一律 `npx pnpm@9.0.0`
- TypeScript strict：禁止 `any` / `@ts-ignore` / `as any`
- 所有代码注释、文档使用中文；标识符英文
- 测试位置：electron 单测集中 `electron/tests/`（子目录镜像 `src/`）；renderer 单测贴源同目录
- renderer UI：语义 token、禁 emoji 图标、状态色一律 `lib/task-status.ts` 单源
- 涉及 IPC / 跨模块契约（T1 的 TaskStatus 双端、T3 的 sendKickoff→sendUserMessage→routeUserChat 链）：改动后跑 `npx pnpm@9.0.0 typecheck` 双 workspace 验证
- Conventional Commits（feat / fix / test / chore）
- 单测命令模板：`cd electron && npx pnpm@9.0.0 vitest run tests/<路径>`（renderer 同理）

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `electron/src/main/storage/tasks/state-machine.ts` | 修改 | TaskStatus 加 `session_queued` + 转换表 |
| `renderer/src/ipc/types.d.ts` | 修改 | TaskStatus 镜像同步 |
| `renderer/src/lib/task-status.ts` | 修改 | STATUS_LABEL / STATUS_TONE 新条目 |
| `renderer/src/components/task-board/task-filter.ts` | 修改 | ALL_STATUSES 数组加新状态 |
| `renderer/src/components/task-board/TaskFilters.tsx` | 修改 | 状态 select 加选项 |
| `electron/src/main/agent/session-lane.ts` | **新建** | 车道注册表：注册/清除/查询/精确中止 |
| `electron/src/main/task/executor.ts` | 修改 | 放行 gate + 双状态队列 + taskId 透传 |
| `electron/src/main/task/starter.ts` | 修改 | startTask 接受 session_queued 起点 |
| `electron/src/main/task/runtime-init.ts` | 修改 | sendKickoff 包装透传 taskId |
| `electron/src/main/im/session-service.ts` | 修改 | sendUserMessage 加 sourceTaskId + SessionRouter 扩展 |
| `electron/src/main/agent/router-service.ts` | 修改 | routeUserChat 注册车道 + steer 分流 |
| `electron/src/main/agent/agent-runner.ts` | 修改 | 流收尾清车道 + steer 方法 |
| `electron/src/main/agent/runtime-entry.ts` | 修改 | 消息监听 steer 分支 + 每轮 drain |
| `electron/src/main/task/ipc.handlers.ts` | 修改 | 暂停/取消精确中止接线 |
| `electron/tests/storage/state-machine-session-queued.test.ts` | **新建** | 状态机新转换 |
| `electron/tests/agent/session-lane.test.ts` | **新建** | 车道注册表全行为 |
| `electron/tests/task/executor-lane.test.ts` | **新建** | executor 车道 gate |
| `electron/tests/agent/router-steer.test.ts` | **新建** | routeUserChat 分流 |
| `electron/tests/agent/runtime-entry-steer.test.ts` | **新建** | steer 注入 chat loop |
| `renderer/src/lib/task-status.test.ts` | 修改 | 新 key 断言 |
| `renderer/src/components/task-board/task-filter.test.ts` | 修改 | all 过滤保留新状态 |

不改动：`MentionInput.tsx` 的 `MENU_STATUSES = ['draft','pending','assigned']`——`session_queued` 任务已在等车道，#T 激活到其他会话会绕过排队语义，**有意不加入**激活菜单。

---

### Task 1: 状态机 session_queued + renderer 状态呈现

**Files:**
- Modify: `electron/src/main/storage/tasks/state-machine.ts`
- Modify: `renderer/src/ipc/types.d.ts`（TaskStatus 定义处，约 :113）
- Modify: `renderer/src/lib/task-status.ts`
- Modify: `renderer/src/components/task-board/task-filter.ts:11`
- Modify: `renderer/src/components/task-board/TaskFilters.tsx:48-57`
- Test: `electron/tests/storage/state-machine-session-queued.test.ts`（新建）
- Test: `renderer/src/lib/task-status.test.ts`、`renderer/src/components/task-board/task-filter.test.ts`（扩展）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `TaskStatus` 联合类型含 `'session_queued'`（electron state-machine 与 renderer types.d.ts 双端一致）；`taskStatusStyle('session_queued')` 返回 `{ label: '排队中', tone: 'neutral', className }`；`applyTaskFilters` 的 `all` 过滤保留 `session_queued` 行。后续任务全部依赖此类型。

- [ ] **Step 1: 写状态机失败测试**

新建 `electron/tests/storage/state-machine-session-queued.test.ts`：

```typescript
// 会话车道（v2.3 spec §3）：session_queued 状态机转换锁
import { describe, expect, it } from 'vitest';
import { canTransition, isTerminal } from '../../../src/main/storage/tasks/state-machine';

describe('state-machine session_queued', () => {
  it('assigned → session_queued 合法（executor 放行时车道被占）', () => {
    expect(canTransition('assigned', 'session_queued')).toBe(true);
  });

  it('session_queued → in_progress / failed / cancelled 合法', () => {
    expect(canTransition('session_queued', 'in_progress')).toBe(true);
    expect(canTransition('session_queued', 'failed')).toBe(true);
    expect(canTransition('session_queued', 'cancelled')).toBe(true);
  });

  it('session_queued → completed / paused / assigned 非法（未执行不可完成、无暂停语义、不可回退）', () => {
    expect(canTransition('session_queued', 'completed')).toBe(false);
    expect(canTransition('session_queued', 'paused')).toBe(false);
    expect(canTransition('session_queued', 'assigned')).toBe(false);
  });

  it('session_queued 非终态', () => {
    expect(isTerminal('session_queued')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/storage/state-machine-session-queued.test.ts
```
预期：FAIL——`canTransition` 收到未知状态（TS 编译期即报 `session_queued` 不在联合类型）。

- [ ] **Step 3: 修改 state-machine.ts**

`TaskStatus` 联合类型在 `'assigned'` 后插入一行：

```typescript
export type TaskStatus =
  | 'draft'
  | 'pending'
  | 'assigned'
  | 'session_queued'
  | 'in_progress'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';
```

`LEGAL_TRANSITIONS` 两处改动（assigned 行替换 + 新增 session_queued 行）：

```typescript
  assigned: new Set(['in_progress', 'session_queued', 'failed', 'cancelled']),
  session_queued: new Set(['in_progress', 'failed', 'cancelled']),
```

文件头注释「8 个状态」改为「9 个状态」，并在状态语义清单 `assigned` 条目后补一行：

```typescript
//       session_queued → executor 放行时目标会话车道被占（v2.3 spec §3）；
//                        车道空闲后放行进 in_progress，也可取消/失败
```

- [ ] **Step 4: 运行确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/storage/state-machine-session-queued.test.ts
```
预期：PASS（4 用例）。

- [ ] **Step 5: renderer 类型与状态单源同步**

`renderer/src/ipc/types.d.ts` TaskStatus 在 `| 'assigned'` 后插入 `| 'session_queued'`。

`renderer/src/lib/task-status.ts` 两个 Record 各加一行（插在 assigned 之后）：

```typescript
const STATUS_LABEL: Record<TaskStatusKey, string> = {
  // ...既有条目不动...
  assigned: '已分配',
  session_queued: '排队中',
  in_progress: '进行中',
  // ...
};

const STATUS_TONE: Record<TaskStatusKey, BadgeTone> = {
  // ...既有条目不动...
  assigned: 'accent',
  session_queued: 'neutral',
  in_progress: 'success',
  // ...
};
```

`renderer/src/components/task-board/task-filter.ts` 的 `ALL_STATUSES` 数组在 `'assigned'` 后插入 `'session_queued'`（缺此项时「全部状态」过滤会静默丢掉排队任务——P0 级）。

`renderer/src/components/task-board/TaskFilters.tsx` 状态 select 在「已分配」option 后插入：

```tsx
        <option value="session_queued">排队中</option>
```

- [ ] **Step 6: renderer 测试扩展**

`renderer/src/lib/task-status.test.ts` 追加：

```typescript
it('session_queued：文案「排队中」+ neutral tone（spec §3.3）', () => {
  const s = taskStatusStyle('session_queued');
  expect(s.label).toBe('排队中');
  expect(s.tone).toBe('neutral');
});
```

`renderer/src/components/task-board/task-filter.test.ts` 追加：

```typescript
it('all 过滤保留 session_queued 排队任务（v2.3 车道）', () => {
  const tasks = [makeTask({ status: 'session_queued' }), makeTask({ status: 'in_progress' })];
  const out = applyTaskFilters(tasks, { status: 'all', assignee: 'all', sort: 'created_at', text: '' });
  expect(out).toHaveLength(2);
});
```

（`makeTask` 为该测试文件既有的构造 helper；若名称不同则按文件内既有工厂函数对齐。）

- [ ] **Step 7: 双 workspace typecheck + 测试**

```bash
npx pnpm@9.0.0 typecheck
cd renderer && npx pnpm@9.0.0 vitest run src/lib/task-status.test.ts src/components/task-board/task-filter.test.ts
```
预期：typecheck 双 clean；两测试文件全绿。

- [ ] **Step 8: Commit**

```bash
git add electron/src/main/storage/tasks/state-machine.ts renderer/src/ipc/types.d.ts renderer/src/lib/task-status.ts renderer/src/components/task-board/task-filter.ts renderer/src/components/task-board/TaskFilters.tsx electron/tests/storage/state-machine-session-queued.test.ts renderer/src/lib/task-status.test.ts renderer/src/components/task-board/task-filter.test.ts
git commit -m "feat: 任务状态机新增 session_queued 排队态（主进程 + renderer 同步）"
```

---

### Task 2: 会话车道注册表（session-lane 模块）

**Files:**
- Create: `electron/src/main/agent/session-lane.ts`
- Test: `electron/tests/agent/session-lane.test.ts`（新建）

**Interfaces:**
- Consumes: `listTasks`（`../storage/tasks/repo`，既有签名 `listTasks(opts: { executionSessionId?: string; status?: TaskStatus | TaskStatus[]; limit?: number }): TaskRow[]`）；`abortStreamBySessionId(streamSessionId: string): boolean`（`./stream-relay`，既有）
- Produces（后续任务依赖的精确签名）:
  - `registerLane(sessionId: string, entry: LaneEntry, opts?: { kickoff?: boolean }): void`
  - `clearLaneIfMatch(sessionId: string, streamSessionId: string): void`
  - `getLane(sessionId: string): LaneEntry | null`
  - `isLaneOccupied(sessionId: string): boolean`
  - `abortTaskStreamByLane(taskId: string): boolean`
  - `interface LaneEntry { taskId: string | null; streamSessionId: string; assignmentId: string }`
  - `__clearLaneForTest(): void`

- [ ] **Step 1: 写失败测试**

新建 `electron/tests/agent/session-lane.test.ts`：

```typescript
// 会话车道注册表（v2.3 spec §4）：注册/清除/占道判定/精确中止
import { beforeEach, describe, expect, it, vi } from 'vitest';

// listTasks 打桩：isLaneOccupied 的 DB 兜底分支可控（保持真实签名形状）
const listTasksMock = vi.fn(() => []);
vi.mock('../../../src/main/storage/tasks/repo', () => ({
  listTasks: (opts: unknown) => listTasksMock(opts),
}));
// abortStreamBySessionId 打桩：精确中止断言载体（保持真实签名形状）
const abortMock = vi.fn(() => true);
vi.mock('../../../src/main/agent/stream-relay', () => ({
  abortStreamBySessionId: (id: string) => abortMock(id),
}));

import {
  registerLane, clearLaneIfMatch, getLane, isLaneOccupied,
  abortTaskStreamByLane, __clearLaneForTest,
} from '../../../src/main/agent/session-lane';

const ENTRY_A = { taskId: 'T-1', streamSessionId: 's-a', assignmentId: 'asg-1' };

beforeEach(() => {
  __clearLaneForTest();
  listTasksMock.mockClear().mockReturnValue([]);
  abortMock.mockClear().mockReturnValue(true);
});

describe('session-lane 注册与清除', () => {
  it('registerLane 后 getLane 返回条目；clearLaneIfMatch 匹配 streamSessionId 才清除', () => {
    registerLane('room-1', ENTRY_A);
    expect(getLane('room-1')).toEqual(ENTRY_A);

    // 迟到收尾（流 id 不匹配）不清新注册——abort 回退重派发场景（spec §4.1）
    clearLaneIfMatch('room-1', 's-other');
    expect(getLane('room-1')).toEqual(ENTRY_A);

    clearLaneIfMatch('room-1', 's-a');
    expect(getLane('room-1')).toBeNull();
  });

  it('kickoff 覆盖注册不抛错（车道被手输流占用的竞态窗口，spec §7）', () => {
    registerLane('room-1', ENTRY_A);
    expect(() =>
      registerLane('room-1', { taskId: 'T-2', streamSessionId: 's-b', assignmentId: 'asg-1' }, { kickoff: true }),
    ).not.toThrow();
    expect(getLane('room-1')?.streamSessionId).toBe('s-b');
  });
});

describe('session-lane 占道判定（内存 ∪ DB 兜底，spec §4.2）', () => {
  it('内存有活跃流即占道', () => {
    registerLane('room-1', ENTRY_A);
    expect(isLaneOccupied('room-1')).toBe(true);
  });

  it('内存为空但 DB 有 in_progress 任务行仍占道（重启恢复兜底）', () => {
    listTasksMock.mockImplementation((opts: { executionSessionId?: string; status?: string }) => {
      expect(opts.executionSessionId).toBe('room-1');
      expect(opts.status).toBe('in_progress');
      return [{ id: 'T-old' }];
    });
    expect(isLaneOccupied('room-1')).toBe(true);
  });

  it('两者皆空 → 不占道', () => {
    expect(isLaneOccupied('room-1')).toBe(false);
  });
});

describe('K7-3 精确中止（spec §6）', () => {
  it('按 taskId 反查车道流并 abort——只命中匹配流', () => {
    registerLane('room-1', ENTRY_A);
    registerLane('room-2', { taskId: 'T-9', streamSessionId: 's-c', assignmentId: 'asg-2' });
    const hit = abortTaskStreamByLane('T-1');
    expect(hit).toBe(true);
    expect(abortMock).toHaveBeenCalledTimes(1);
    expect(abortMock).toHaveBeenCalledWith('s-a');
  });

  it('dispatch 子流未注册车道 → 不受影响；无匹配返回 false', () => {
    registerLane('room-1', ENTRY_A);
    expect(abortTaskStreamByLane('T-dispatch-derived')).toBe(false);
    expect(abortMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/session-lane.test.ts
```
预期：FAIL——模块不存在。

- [ ] **Step 3: 实现 session-lane.ts**

新建 `electron/src/main/agent/session-lane.ts`：

```typescript
// electron/src/main/agent/session-lane.ts
//
// 会话执行车道（v2.3 spec §4）——同一会话同一时刻至多一条顶层活跃流。
//
// 设计要点：
//   - 内存态 Map<sessionId, LaneEntry>：routeUserChat 派发顶层流时注册，
//     AgentRunner 流收尾时清除（按 streamSessionId 匹配，防迟到收尾误清）
//   - 占道判定双层：内存活跃流 ∪ 该会话 in_progress 任务行（DB 兜底——
//     重启后内存为空，孤儿 in_progress 行继续占道防插队，spec §4.2）
//   - 精确中止（K7-3 修复）：按 taskId 反查流 id 走 abortStreamBySessionId，
//     不再按 executionSessionId 广播——同会话 dispatch 子流不被误杀
//   - 独立模块不 import runtime-registry / agent-runner（避免环）：
//     registry 与 runner 都 import 本模块
import { listTasks } from '../storage/tasks/repo';
import { abortStreamBySessionId } from './stream-relay';
import { logger } from '../logger';

/** 车道条目：会话 → 活跃顶层流 */
export interface LaneEntry {
  /** kickoff 来源任务 id；用户手输派发的流为 null */
  taskId: string | null;
  streamSessionId: string;
  assignmentId: string;
}

const lane = new Map<string, LaneEntry>();

/**
 * 注册（upsert）车道条目。
 * kickoff=true 时无条件覆盖——executor 已保证放行前车道空闲，覆盖仅发生在
 * 「手输流恰好先注册」的极窄竞态窗口，退化并行 + warn（spec §7）。
 */
export function registerLane(
  sessionId: string,
  entry: LaneEntry,
  opts?: { kickoff?: boolean },
): void {
  const prev = lane.get(sessionId);
  if (prev && opts?.kickoff && prev.streamSessionId !== entry.streamSessionId) {
    logger.warn('kickoff 到达时车道被占（手输流竞态窗口），覆盖注册退化为并行', {
      sessionId,
      prevStreamSessionId: prev.streamSessionId,
    });
  }
  lane.set(sessionId, entry);
}

/** 清除车道——仅当当前条目的 streamSessionId 匹配（防迟到收尾清掉新注册） */
export function clearLaneIfMatch(sessionId: string, streamSessionId: string): void {
  const cur = lane.get(sessionId);
  if (cur && cur.streamSessionId === streamSessionId) {
    lane.delete(sessionId);
  }
}

/** 查询车道条目（steer 分流目标判定用） */
export function getLane(sessionId: string): LaneEntry | null {
  return lane.get(sessionId) ?? null;
}

/** 占道判定：内存活跃流 ∪ DB in_progress 兜底（spec §4.2） */
export function isLaneOccupied(sessionId: string): boolean {
  if (lane.has(sessionId)) return true;
  return listTasks({ executionSessionId: sessionId, status: 'in_progress', limit: 1 }).length > 0;
}

/**
 * K7-3 精确中止（spec §6）：按 taskId 反查车道流并 abort。
 * 返回是否命中（未命中时调用方回退按 executionSessionId 广播）。
 * dispatch 子流不经 routeDispatch 注册车道——天然不受影响。
 */
export function abortTaskStreamByLane(taskId: string): boolean {
  for (const entry of lane.values()) {
    if (entry.taskId === taskId) {
      return abortStreamBySessionId(entry.streamSessionId);
    }
  }
  return false;
}

/** 测试用：清空车道 */
export function __clearLaneForTest(): void {
  lane.clear();
}
```

- [ ] **Step 4: 运行确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/session-lane.test.ts
```
预期：PASS（7 用例）。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/session-lane.ts electron/tests/agent/session-lane.test.ts
git commit -m "feat: 会话执行车道注册表（session-lane 模块）"
```

---

### Task 3: 车道接线 + executor 放行 gate

**Files:**
- Modify: `electron/src/main/task/starter.ts:76-87`（起点状态白名单）
- Modify: `electron/src/main/task/executor.ts`（peekNextAssigned :159-176 / launch :115-148 / ExecutorDeps :29-39）
- Modify: `electron/src/main/task/runtime-init.ts:34-48`（sendKickoff 包装）
- Modify: `electron/src/main/im/session-service.ts`（sendUserMessage 入参 :113-124 + SessionRouter :30-32 + 路由调用 :192）
- Modify: `electron/src/main/agent/router-service.ts`（RouteUserChatInput :50-59 + routeUserChat :84-112）
- Modify: `electron/src/main/agent/agent-runner.ts`（finalizeActiveTask :232-260 / ephemeral end 分支 :162-166 / handleChildExit :352-366 / destroy :445-455）
- Test: `electron/tests/task/executor-lane.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `session_queued` 状态；Task 2 的 `registerLane / clearLaneIfMatch / isLaneOccupied`
- Produces:
  - `ExecutorDeps.sendKickoff` 入参加 `taskId: string`（必填）
  - `sendUserMessage` 入参对象增加 `sourceTaskId?: string | null`
  - `RouteUserChatInput` 增加 `systemKickoff?: boolean; sourceTaskId?: string | null`（Task 4 的 steer 分流依赖这两个字段）
  - routeUserChat 每次顶层派发后注册车道（Task 4 依赖 lane 里有数据）

- [ ] **Step 1: 写 executor 车道 gate 失败测试**

新建 `electron/tests/task/executor-lane.test.ts`（harness 照抄 `executor.test.ts` 的内存 DB 模式）：

```typescript
// executor 会话车道 gate（v2.3 spec §4.3）：同会话第二任务转 session_queued
// 不占全局槽；车道空闲后按序放行；无目标会话任务不受车道影响。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask } from '../../src/main/storage/tasks/repo';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import { TaskExecutor } from '../../src/main/task/executor';
import type { ExecutorDeps } from '../../src/main/task/executor';
import { __clearLaneForTest } from '../../src/main/agent/session-lane';

const tmpRoot = path.join(os.tmpdir(), `ap-exec-lane-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/tmp', '@o')`)
    .run();
  __clearLaneForTest();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 与 executor.test.ts 同款 agent 成员 seed（DDL 对齐 v25 schema） */
function seedAgentMember(instanceId: string): void {
  getDb()
    .prepare(
      `INSERT INTO agent_definitions (id, slug, name, version, system_prompt, model_name) VALUES ('def1', 'c', 'C', '1', 'p', 'm')`,
    )
    .run();
  getDb()
    .prepare(
      `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id) VALUES (?, 'ws1', 'def1', ?)`,
    )
    .run(instanceId, `@${instanceId}:s`);
}

function mkExecutor(max: number, kickoff: ExecutorDeps['sendKickoff']): TaskExecutor {
  const ex = new TaskExecutor();
  ex.init({ sendKickoff: kickoff, getGlobalMax: () => max });
  return ex;
}

describe('TaskExecutor 会话车道 gate（v2.3）', () => {
  it('同会话双任务：第一个 in_progress，第二个转 session_queued 且不占全局槽', async () => {
    seedAgentMember('inst1');
    const session = insertSession({ workspaceId: 'ws1', title: '任务研发', kind: 'task_execution' });
    addSessionMember(session.id, 'inst1', true);
    // A 优先级高先放行；B 同会话低优先级
    insertTask({ workspaceId: 'ws1', title: 'A', creatorUserId: 'o', assigneeAgentId: 'inst1', targetSessionId: session.id, status: 'assigned', priority: 10 });
    insertTask({ workspaceId: 'ws1', title: 'B', creatorUserId: 'o', assigneeAgentId: 'inst1', targetSessionId: session.id, status: 'assigned', priority: 5 });

    const kickoff = vi.fn().mockResolvedValue(undefined);
    const ex = mkExecutor(3, kickoff);
    await ex.admitOnce();

    // T-001=A 高优先级放行；startTask 已写 in_progress DB 行（车道 DB 兜底占道）
    expect(getTask('T-001')!.status).toBe('in_progress');
    expect(getTask('T-002')!.status).toBe('session_queued');
    expect(kickoff).toHaveBeenCalledTimes(1);
    expect(kickoff.mock.calls[0]![0].taskId).toBe('T-001');
  });

  it('车道空闲（in_progress 行已终态化）后放行 session_queued 队首', async () => {
    seedAgentMember('inst1');
    const session = insertSession({ workspaceId: 'ws1', title: '任务研发', kind: 'task_execution' });
    addSessionMember(session.id, 'inst1', true);
    // A 已完成（DB 无 in_progress 行，lane 内存为空）→ B 从排队态放行
    insertTask({ workspaceId: 'ws1', title: 'A', creatorUserId: 'o', assigneeAgentId: 'inst1', targetSessionId: session.id, status: 'completed' });
    insertTask({ workspaceId: 'ws1', title: 'B', creatorUserId: 'o', assigneeAgentId: 'inst1', targetSessionId: session.id, status: 'session_queued' });

    const kickoff = vi.fn().mockResolvedValue(undefined);
    const ex = mkExecutor(3, kickoff);
    await ex.admitOnce();

    expect(getTask('T-002')!.status).toBe('in_progress');
    expect(kickoff).toHaveBeenCalledTimes(1);
    expect(kickoff.mock.calls[0]![0].taskId).toBe('T-002');
  });

  it('无目标会话任务（startTask 新建会话路径）不受车道影响', async () => {
    seedAgentMember('inst1');
    insertTask({ workspaceId: 'ws1', title: 'C', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'assigned' });

    const kickoff = vi.fn().mockResolvedValue(undefined);
    const ex = mkExecutor(3, kickoff);
    await ex.admitOnce();

    expect(getTask('T-001')!.status).toBe('in_progress');
    expect(kickoff).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/task/executor-lane.test.ts
```
预期：FAIL——B 转成 `in_progress`（车道 gate 未实现，状态断言不符）。

- [ ] **Step 3: starter.ts 接受 session_queued 起点**

`startTask` 的起点白名单（:81）替换为：

```typescript
  // v2.3：session_queued 与 assigned/pending 同为可启动起点——车道放行时
  // 从排队态直接进 in_progress（spec §3.1）
  if (
    task.status !== 'assigned' &&
    task.status !== 'pending' &&
    task.status !== 'session_queued' &&
    !draftEligible
  ) {
    throw new Error(
      task.status === 'draft'
        ? `task ${taskId} 未指派委派目标，不能启动（请先编辑指派 agent / 团队 / 会话）`
        : `task ${taskId} status=${task.status}，不能启动（必须为 assigned / pending / session_queued）`,
    );
  }
```

- [ ] **Step 4: executor.ts 车道 gate + 双状态队列 + taskId 透传**

4a. `ExecutorDeps.sendKickoff` 签名（:31）加必填 `taskId`：

```typescript
export interface ExecutorDeps {
  sendKickoff(input: {
    sessionId: string;
    /** kickoff 来源任务 id——车道注册依据（v2.3 spec §4.4 透传链） */
    taskId: string;
    body: string;
    mentionedInstanceIds?: string[];
  }): Promise<void>;
  // ...其余字段不变...
}
```

4b. import 区加 `import { isLaneOccupied } from '../agent/session-lane';`

4c. `launch()` 在 `validateTarget` 之后、`startTask` 之前插入车道检查：

```typescript
    // v2.3 会话车道（spec §4.3）：目标会话已有顶层活跃流（内存 ∪ DB 兜底）→
    // 任务转 session_queued 排队，return false 不占全局槽。无目标会话的任务
    // startTask 新建会话，车道必空不检查
    if (task.targetSessionId && isLaneOccupied(task.targetSessionId)) {
      try {
        transitionTaskStatus(task.id, 'session_queued');
      } catch (err) {
        // 并发改态（用户同时取消等）——留给兜底扫描重评估
        logger.warn('车道排队转换失败（并发改态）', {
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return false;
    }
```

4d. `sendKickoff` 调用处（:137-141）加 `taskId: task.id`：

```typescript
      await this.deps!.sendKickoff({
        sessionId: executionSessionId,
        taskId: task.id,
        body: buildKickoffBody(task),
        mentionedInstanceIds: task.assigneeAgentId ? [task.assigneeAgentId] : undefined,
      });
```

4e. `peekNextAssigned`（:159-176）两处状态扩展：

```typescript
  const rows = getDb()
    .prepare(
      `SELECT id FROM tasks WHERE status IN ('assigned', 'session_queued') ${excludeClause}
       ORDER BY priority DESC, COALESCE(scheduled_at, created_at) ASC, created_at ASC
       LIMIT ?`,
    )
    .all(...skipIds, Math.max(slots, 1)) as Array<{ id: string }>;
  for (const r of rows) {
    const t = getTask(r.id);
    if (t && (t.status === 'assigned' || t.status === 'session_queued')) return t;
  }
```

注释「队列首候选：assigned 按放行序」改为「队列首候选：assigned / session_queued 按放行序（v2.3 车道队列并入）」。

- [ ] **Step 5: runtime-init.ts / session-service.ts / router-service.ts 透传与注册**

5a. `runtime-init.ts` sendKickoff 包装（:35-44）加透传：

```typescript
    sendKickoff: opts?.kickoff ?? (async (input) => {
      await sendUserMessage({
        sessionId: input.sessionId,
        body: input.body,
        mentionedInstanceIds: input.mentionedInstanceIds,
        // v2.3 车道透传链（spec §4.4）：taskId → sourceTaskId → 路由层注册车道
        sourceTaskId: input.taskId,
        // kickoff 是系统消息：跳过冲突检测与 #T 激活（正文天然含 #T id，
        // 不跳过会误报冲突弹窗 + 误激活描述里提及的任务）
        systemKickoff: true,
      });
    }),
```

5b. `session-service.ts` 三处：

`SessionRouter` 接口（:30-32）扩展：

```typescript
interface SessionRouter {
  routeUserChat(input: {
    sessionId: string;
    assignmentId: string;
    body: string;
    streamSessionId?: string;
    /** v2.3：系统 kickoff 消息（车道无条件派发 + 注册覆盖语义） */
    systemKickoff?: boolean;
    /** v2.3：kickoff 来源任务 id（车道注册；手输消息为 null） */
    sourceTaskId?: string | null;
  }): Promise<void>;
}
```

`sendUserMessage` 入参（:113-124 的 input 类型）追加两个可选字段（带中文注释）：

```typescript
  /**
   * v2.3 会话车道：系统 kickoff 消息携带来源任务 id，经路由层注册车道；
   * 用户手输消息不传（注册时 taskId 记 null）。
   */
  sourceTaskId?: string | null;
```

（`systemKickoff?: boolean` 已存在，无需新增。）

路由调用（:192）透传：

```typescript
      await router.routeUserChat({
        sessionId: input.sessionId,
        assignmentId: target,
        body: input.body,
        systemKickoff: input.systemKickoff === true,
        sourceTaskId: input.sourceTaskId ?? null,
      });
```

5c. `router-service.ts`：

`RouteUserChatInput`（:50-59）追加：

```typescript
  /** v2.3：系统 kickoff 消息（车道无条件派发；steer 分流跳过） */
  systemKickoff?: boolean;
  /** v2.3：kickoff 来源任务 id（车道注册；手输为 null） */
  sourceTaskId?: string | null;
```

import 区加 `import { registerLane } from './session-lane';`

`routeUserChat` 末尾（`await runner.executeTask(task);` 之后）注册车道：

```typescript
    await runner.executeTask(task);
    // v2.3 会话车道注册（spec §4.1）：顶层流派发即占道；dispatch 子流走
    // routeDispatch 不经此路径，天然不注册（并行委派能力保留）
    registerLane(
      input.sessionId,
      {
        taskId: input.sourceTaskId ?? null,
        streamSessionId: task.streamSessionId,
        assignmentId: input.assignmentId,
      },
      { kickoff: input.systemKickoff === true },
    );
```

- [ ] **Step 6: agent-runner.ts 流收尾清车道 + 放行触发**

import 区加 `import { clearLaneIfMatch } from './session-lane';`

6a. ephemeral end 即回收分支（:162-166）扩展：

```typescript
        if (task.taskId === null) {
          // ephemeral chat：无后续 IPC 依赖，保持旧语义——end 即回收
          child.off('message', messageHandler);
          this.opts.warmPool.release(runtime);
          this.activeTasks.delete(task.streamSessionId);
          // v2.3 车道：顶层流收尾让道 + 触发排队放行
          clearLaneIfMatch(task.executionSessionId, task.streamSessionId);
          notifyExecutor();
        } else if (active) {
```

6b. `finalizeActiveTask`（:232-260）在 `this.activeTasks.delete(streamSessionId);` 之后插入：

```typescript
    // v2.3 车道：流收尾让道（迟到收尾按 streamSessionId 匹配天然 no-op）
    clearLaneIfMatch(active.executionSessionId, active.streamSessionId);
    notifyExecutor();
```

（`transitionTaskTerminal` 内原有的 `notifyExecutor()` 保留——100ms 去抖合并，幂等。）

6c. `handleChildExit`（:352-366）循环内 `this.activeTasks.delete(active.streamSessionId);` 之后插入：

```typescript
      clearLaneIfMatch(active.executionSessionId, active.streamSessionId);
```

并在方法末尾（for 循环后）加 `notifyExecutor();`

6d. `destroy()`（:445-455）循环内加：

```typescript
      clearLaneIfMatch(active.executionSessionId, active.streamSessionId);
```

- [ ] **Step 7: 运行测试**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/task/executor-lane.test.ts tests/task tests/agent/router-service.test.ts tests/agent/agent-runner.test.ts
```
预期：新用例 PASS；既有 executor / router-service / agent-runner 套件无回归。

- [ ] **Step 8: typecheck**

```bash
npx pnpm@9.0.0 typecheck
```
预期：双 clean。

- [ ] **Step 9: Commit**

```bash
git add electron/src/main/task/starter.ts electron/src/main/task/executor.ts electron/src/main/task/runtime-init.ts electron/src/main/im/session-service.ts electron/src/main/agent/router-service.ts electron/src/main/agent/agent-runner.ts electron/tests/task/executor-lane.test.ts
git commit -m "feat: executor 会话车道放行 gate 与 kickoff taskId 透传链"
```

---

### Task 4: steer 注入链路

**Files:**
- Modify: `electron/src/main/agent/router-service.ts`（routeUserChat 分流，Task 3 改动区之前）
- Modify: `electron/src/main/agent/agent-runner.ts`（新增 steer 方法）
- Modify: `electron/src/main/agent/runtime-entry.ts`（abortListener :329-335 扩展 + for round 循环顶部 :430 后 drain）
- Test: `electron/tests/agent/router-steer.test.ts`（新建）
- Test: `electron/tests/agent/runtime-entry-steer.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 的 `getLane`（lane 数据已注册）、`RouteUserChatInput.systemKickoff / sourceTaskId`
- Produces:
  - `AgentRunner.steer(streamSessionId: string, body: string): boolean`（发送成功 true；通道关闭/无活跃 false）
  - 子进程线协议新增消息 `{ type: 'steer'; streamSessionId: string; body: string }`（主进程 → 子进程，与 abort 同模式）
  - chat loop 注入格式：`{ role: 'user', content: '[用户中途补充] ' + body }`

- [ ] **Step 1: 写 routeUserChat 分流失败测试**

先读 `electron/tests/agent/router-service.test.ts` 的 runners Map mock 模式。新建 `electron/tests/agent/router-steer.test.ts`：

```typescript
// routeUserChat steer 分流（v2.3 spec §5.1）：活跃期手输注入，空闲正常派发
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RouterService } from '../../../src/main/agent/router-service';
import { registerLane, __clearLaneForTest } from '../../../src/main/agent/session-lane';

/** 最小 runner 桩：steer / executeTask 可分别断言 */
function mkRunner() {
  return {
    steer: vi.fn(() => true),
    executeTask: vi.fn(async () => ({ streamSessionId: 's-new' })),
    abortTasksBySession: vi.fn(() => false),
  };
}

const runners = new Map<string, ReturnType<typeof mkRunner>>();

/** RouterService 构造（与 router-service.test.ts 既有用法对齐：runners + dispatcher） */
function mkService(): RouterService {
  return new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });
}

beforeEach(() => {
  runners.clear();
  __clearLaneForTest();
});

describe('routeUserChat steer 分流', () => {
  it('车道占用且目标 runner 匹配 → steer 注入，不派发新流', async () => {
    const runner = mkRunner();
    runners.set('asg-1', runner);
    registerLane('room-1', { taskId: 'T-1', streamSessionId: 's-a', assignmentId: 'asg-1' });

    await mkService().routeUserChat({ sessionId: 'room-1', assignmentId: 'asg-1', body: '补充：用 pnpm' });

    expect(runner.steer).toHaveBeenCalledWith('s-a', '补充：用 pnpm');
    expect(runner.executeTask).not.toHaveBeenCalled();
  });

  it('车道空闲 → 正常派发（现有行为不变）', async () => {
    const runner = mkRunner();
    runners.set('asg-1', runner);

    await mkService().routeUserChat({ sessionId: 'room-1', assignmentId: 'asg-1', body: '新问题' });

    expect(runner.executeTask).toHaveBeenCalledTimes(1);
    expect(runner.steer).not.toHaveBeenCalled();
  });

  it('车道被占但目标是另一 runner（@ 其他成员）→ 正常派发', async () => {
    const leader = mkRunner();
    const other = mkRunner();
    runners.set('asg-leader', leader);
    runners.set('asg-other', other);
    registerLane('room-1', { taskId: 'T-1', streamSessionId: 's-a', assignmentId: 'asg-leader' });

    await mkService().routeUserChat({ sessionId: 'room-1', assignmentId: 'asg-other', body: '问你一下' });

    expect(other.executeTask).toHaveBeenCalledTimes(1);
    expect(leader.steer).not.toHaveBeenCalled();
  });

  it('systemKickoff 消息不做 steer（车道注册覆盖语义归 Task 3）', async () => {
    const runner = mkRunner();
    runners.set('asg-1', runner);
    registerLane('room-1', { taskId: 'T-manual', streamSessionId: 's-a', assignmentId: 'asg-1' });

    await mkService().routeUserChat({
      sessionId: 'room-1', assignmentId: 'asg-1', body: '【任务启动】#T-2',
      systemKickoff: true, sourceTaskId: 'T-2',
    });

    expect(runner.steer).not.toHaveBeenCalled();
    expect(runner.executeTask).toHaveBeenCalledTimes(1);
  });

  it('steer 发送失败（死通道）→ 回退正常派发（spec §5.4）', async () => {
    const runner = mkRunner();
    runner.steer = vi.fn(() => false);
    runners.set('asg-1', runner);
    registerLane('room-1', { taskId: 'T-1', streamSessionId: 's-a', assignmentId: 'asg-1' });

    await mkService().routeUserChat({ sessionId: 'room-1', assignmentId: 'asg-1', body: '流刚结束' });

    expect(runner.steer).toHaveBeenCalledTimes(1);
    expect(runner.executeTask).toHaveBeenCalledTimes(1);
  });
});
```

（`RouterService` / `registerLane` / `__clearLaneForTest` 的 import 语句放在文件头部：`import { RouterService } from '../../../src/main/agent/router-service';` 与 `import { registerLane, __clearLaneForTest } from '../../../src/main/agent/session-lane';`。runner 桩经 `runners` Map 直接传入——RouterServiceOpts 对 runner 类型是结构子集，与 router-service.test.ts 的 mock 模式一致。）

- [ ] **Step 2: 运行确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/router-steer.test.ts
```
预期：FAIL——`steer` 未定义 / 分流未实现（第一用例 executeTask 被调用）。

- [ ] **Step 3: AgentRunner.steer 方法**

`agent-runner.ts` 在 `abortStream` 方法（:394-398）之后新增：

```typescript
  /**
   * v2.3 steer（spec §5.2）：向活跃流的子进程注入用户中途补充。
   * 与 abort 同线协议模式——child.send({ type:'steer', streamSessionId, body })，
   * runtime-entry 的消息监听器 push 进 pendingSteers，chat loop 下一轮构建
   * LLM 请求前消费。不触发 AbortController（与停止按钮语义正交）。
   * 返回 false = 无活跃流或通道已关（调用方回退正常派发）。
   */
  steer(streamSessionId: string, body: string): boolean {
    const active = this.activeTasks.get(streamSessionId);
    if (!active) return false;
    try {
      active.runtime.child.send({ type: 'steer', streamSessionId, body });
      return true;
    } catch {
      // 通道已关闭（流恰好结束）——回退由调用方处理
      return false;
    }
  }
```

- [ ] **Step 4: routeUserChat steer 分流**

`router-service.ts` import 区补 `getLane`（Task 3 已 import registerLane，同一 import 语句合并）。

`routeUserChat` 在「`const task: TaskConfig = ...`」之前插入分流：

```typescript
    // v2.3 steer 分流（spec §5.1）：活跃流期间用户手输 → 注入当前流而非新流。
    // 分流键 = (sessionId, assignmentId)：@ 其他成员不 steer（目标 runner 不同）
    if (!input.systemKickoff) {
      const laneEntry = getLane(input.sessionId);
      if (laneEntry && laneEntry.assignmentId === input.assignmentId) {
        const steered = runner.steer(laneEntry.streamSessionId, input.body);
        if (steered) return;
        // 死通道回退（spec §5.4）：流恰好结束——继续走正常派发，消息不丢
        logger.info('steer 通道已关，回退正常派发', {
          sessionId: input.sessionId,
          streamSessionId: laneEntry.streamSessionId,
        });
      }
    }
```

- [ ] **Step 5: 运行分流测试**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/router-steer.test.ts
```
预期：PASS（5 用例）。

- [ ] **Step 6: 写 runtime-entry steer 注入失败测试**

新建 `electron/tests/agent/runtime-entry-steer.test.ts`。文件头部的夹具（`vi.mock llm-provider`、`mockProviderMultiRound` 不可用——本测试需要自定义 generator，改为内联 mock、`makeConfig`、`makeContext`、`mockClient`、memory provider 测试注入）**逐字复制 `runtime-segment.test.ts` 的对应 helper**，然后写用例体：

```typescript
// chat loop steer 注入（v2.3 spec §5.2）：每轮构建 LLM 请求前 drain pendingSteers。
// 两轮结构用 compact 内联工具衔接（不依赖 toolModules）：第一轮 LLM 返回
// compact 工具调用（内联处理继续循环），轮内 emit steer 消息；第二轮捕获
// messages 断言补充已注入。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LLMMessage, StreamDelta } from '../../src/main/agent/llm-provider';
// ……夹具 import 与 vi.mock 段照抄 runtime-segment.test.ts（createLLMProvider mock、
//    __setMemoryProviderForTest、makeConfig、makeContext、mockClient、sentChunks）……

describe('runChatLoop steer 注入', () => {
  it('流式期间 steer 消息在下一轮 LLM 请求以 [用户中途补充] user message 注入', async () => {
    let callIndex = 0;
    let round2Messages: LLMMessage[] = [];
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
        callIndex++;
        if (callIndex === 1) {
          yield { type: 'text', content: '先总结' };
          yield {
            type: 'tool_use',
            toolCall: { id: 'c1', name: 'compact', arguments: { summary: 'S'.repeat(60) } },
          };
          yield { type: 'done', finishReason: 'tool_use' };
          // compact 内联处理在 generator 结束后、下一轮 drain 前执行——此刻注入 steer
          process.emit('message', { type: 'steer', streamSessionId: 's-steer', body: '补充说明 X' });
          return;
        }
        round2Messages = [...messages];
        yield { type: 'text', content: '收到补充' };
        yield { type: 'done', finishReason: 'stop' };
      }) as never,
    });

    const stats = { toolCallsUsed: 0 };
    await runChatLoop('!room:t', '初始问题', makeConfig(), makeContext(), stats, undefined, undefined, 's-steer');

    const supplement = round2Messages.find(
      (m) => m.role === 'user' && m.content.includes('[用户中途补充] 补充说明 X'),
    );
    expect(supplement).toBeDefined();
  });

  it('多条 steer FIFO 依次注入为独立 user messages', async () => {
    // 同上结构；第一轮 generator 结束前连续 emit 两条 steer（body1 / body2），
    // 断言 round2Messages 中两条 [用户中途补充] 消息按 emit 顺序出现
    // （filter 后 index0.content 以 body1 结尾、index1 以 body2 结尾）
  });

  it('streamSessionId 不匹配的 steer 消息被忽略', async () => {
    // 同上结构；emit streamSessionId:'s-other' 的 steer，
    // 断言 round2Messages 无任何 [用户中途补充] 消息
  });

  it('abort 语义与 steer 正交：abort 消息仍触发 interrupted 收尾', async () => {
    // 第一轮 emit steer + 第二轮 generator 开头 emit abort 后抛
    // Object.assign(new Error('中断'), { name: 'AbortError' })
    // 断言：stats.aborted === true、返回值为已累积文本、
    //       round2 messages 中补充已注入（steer 不阻塞不改变 abort 路径）
  });
});
```

（第一用例为完整可运行代码；后三用例按注释内断言补全，结构与之完全一致。`process.emit('message', ...)` 是 vitest 进程内触发 `process.on('message')` 监听器的既有手法，与 abort 测试同模式。）

- [ ] **Step 7: 运行确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-entry-steer.test.ts
```
预期：FAIL——steer 消息无监听分支，补充不出现。

- [ ] **Step 8: runtime-entry 实现**

8a. `abortListener`（:329-335）扩展为双分支（保持函数名不变——所有 `process.off('message', abortListener)` 清理点自动覆盖 steer 监听）：

```typescript
  // v2.3 steer：与 abort 同监听器（共享全部 process.off 清理点）——
  // push 进闭包队列，chat loop 每轮构建 LLM 请求前 drain（spec §5.2）
  const pendingSteers: string[] = [];
  const abortListener = (msg: unknown): void => {
    const m = msg as { type?: string; streamSessionId?: string; body?: unknown };
    if (m.streamSessionId !== streamSessionId) return;
    if (m.type === 'abort') {
      abortController.abort();
      return;
    }
    if (m.type === 'steer' && typeof m.body === 'string') {
      pendingSteers.push(m.body);
    }
  };
  process.on('message', abortListener);
```

8b. `for (let round = 0; ; round++) {`（:430）循环体顶部、compact 提示注入之前插入 drain：

```typescript
  for (let round = 0; ; round++) {
    // v2.3 steer 注入（spec §5.2）：每轮构建 LLM 请求前 drain——上一轮工具
    // 执行期间到达的用户补充在此进入上下文；最后一轮自然结束后未消费的
    // 补充保留在会话历史（消息已落库），下轮对话可见，不重派发
    while (pendingSteers.length > 0) {
      messages.push({ role: 'user', content: `[用户中途补充] ${pendingSteers.shift()!}` });
    }

    // v1.5.6: 上下文过长时注入 compact 提示（不强制，只提醒 LLM 主动调）
    ...
```

- [ ] **Step 9: 运行全部新测试**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-entry-steer.test.ts tests/agent/runtime-segment.test.ts tests/agent/dispatch-parallel.test.ts
```
预期：新用例 PASS；既有 runtime-entry 相关套件无回归。

- [ ] **Step 10: typecheck + Commit**

```bash
npx pnpm@9.0.0 typecheck
git add electron/src/main/agent/router-service.ts electron/src/main/agent/agent-runner.ts electron/src/main/agent/runtime-entry.ts electron/tests/agent/router-steer.test.ts electron/tests/agent/runtime-entry-steer.test.ts
git commit -m "feat: 活跃流 steer 注入——工具边界用户补充与死通道回退"
```

---

### Task 5: 任务暂停/取消精确中止（K7-3 修复）

**Files:**
- Modify: `electron/src/main/task/ipc.handlers.ts:77-81`（abortTaskExecutionIfAny）
- Test: `electron/tests/agent/session-lane.test.ts`（扩展——精确中止回归锁已含于 Task 2，此处补兜底广播分支的接线说明）

**Interfaces:**
- Consumes: Task 2 的 `abortTaskStreamByLane`
- Produces: 暂停/取消只中止该任务车道流；lane 无记录时回退按会话广播（行为兜底不变）

- [ ] **Step 1: 扩展 session-lane 回归锁**

`electron/tests/agent/session-lane.test.ts` 的「K7-3 精确中止」describe 追加：

```typescript
  it('同会话另一任务的车道流不被误中止（双车道场景）', () => {
    registerLane('room-1', { taskId: 'T-1', streamSessionId: 's-a', assignmentId: 'asg-1' });
    registerLane('room-2', { taskId: 'T-2', streamSessionId: 's-b', assignmentId: 'asg-2' });
    abortTaskStreamByLane('T-2');
    expect(abortMock).toHaveBeenCalledTimes(1);
    expect(abortMock).toHaveBeenCalledWith('s-b'); // 只命中 T-2 的流，s-a 不动
  });
```

- [ ] **Step 2: 改 ipc.handlers.ts**

import 区补 `import { abortTaskStreamByLane } from '../agent/session-lane';`

`abortTaskExecutionIfAny`（:77-81）替换为：

```typescript
/**
 * K7-4 + v2.3 精确中止（spec §6）：任务转 paused / cancelled 时联动中断 agent 执行。
 * 优先按 taskId 反查车道流精确 abort——同会话 dispatch 子流（未注册车道）
 * 与其他任务的流不受影响；车道无记录（流未注册的窗口 / 旧数据）回退按
 * executionSessionId 广播（原 K7-4 语义兜底）。
 */
function abortTaskExecutionIfAny(taskId: string): void {
  if (abortTaskStreamByLane(taskId)) return;
  const row = getTask(taskId);
  if (!row?.executionSessionId) return;
  abortTasksBySessionEverywhere(row.executionSessionId);
}
```

- [ ] **Step 3: 运行测试 + 回归**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/session-lane.test.ts tests/task
```
预期：session-lane 全绿（含新用例）；task 域既有套件无回归。

- [ ] **Step 4: typecheck + Commit**

```bash
npx pnpm@9.0.0 typecheck
git add electron/src/main/task/ipc.handlers.ts electron/tests/agent/session-lane.test.ts
git commit -m "fix: 任务暂停/取消按 taskId 精确中止执行流（K7-3 不再误杀 dispatch 子流）"
```

---

### Task 6: 全量验收门禁

**Files:**
- 无代码改动（验证任务）

**Interfaces:**
- Consumes: Task 1-5 全部产出
- Produces: 验收结论 + spec §9 对照记录

- [ ] **Step 1: 双 workspace typecheck**

```bash
nvm use 20 && npx pnpm@9.0.0 typecheck
```
预期：electron + renderer 双 clean。

- [ ] **Step 2: 全量测试**

```bash
npx pnpm@9.0.0 test
```
预期：electron 187+ 文件 / renderer 107+ 文件全绿（新增 ~16 用例）。若 electron 全量遇容器 SIGSEGV（better-sqlite3 + 并行 worker 预存偶发），重跑一次或按目录分跑 `tests/agent tests/task tests/storage`。

- [ ] **Step 3: spec §9 验收对照（代码级可验项）**

| # | 验收标准 | 验证方式 |
|---|---|---|
| 1 | 双任务同会话：第二个 session_queued，第一个完成后自动放行 | executor-lane.test.ts 两用例 |
| 2 | 执行中手输 → steer 注入不产生新流 | router-steer + runtime-entry-steer 测试 |
| 3 | 暂停只中止该任务流，dispatch 子流不受影响 | session-lane K7-3 回归锁 |
| 4 | 不同会话并行不受影响 | executor-lane「无目标会话」+ 既有 executor.test.ts |
| 5 | 空闲手输 / dispatch 并行 / abort 按钮回归 | router-steer「车道空闲」+ dispatch-parallel + 既有 agent-runner 套件 |

GUI 冒烟（双任务排队、steer 注入后 agent 回复体现补充、暂停精确中止）留 macOS 主机，记录到 ledger。

- [ ] **Step 4: 更新 SDD ledger**

`.superpowers/sdd/progress.md` 追加执行记录（任务完成态 + 验收证据）。

---

## 任务依赖

- T1（状态机）、T2（车道模块）相互独立，可并行
- T3 依赖 T1 + T2
- T4 依赖 T2（lane 数据）与 T3 的 RouteUserChatInput 扩展字段
- T5 依赖 T2
- T6 收尾依赖全部
