// electron/tests/task/lifecycle-runs-submit.test.ts
//
// lifecycle-runs 两段式完成语义契约锁（submitRun / acceptTask / rejectTask，
// 任务生命周期 v2 spec §6.5 + brief Task 10 八用例，真实 DB 无 mock）：
//   1) 提交全链：startRun → submitRun → run submitted + 任务 submitted +
//      acceptance 请求 pending（kind/timeoutPolicy/deadlineAt/title/payload 全字段）+ submitted_at
//   2) 未决非验收请求时提交被拒（spec 不变量 2，人话含「先处理未决请求」，零副作用）
//   3) accept：任务 completed + accepted_at + acceptance answered；再 accept → 人话拒
//   4) reject 带理由：任务 assigned + run rejected + 理由落库 + acceptance 答复；
//      空白理由拒（与 move 校验双保险）
//   5) reject 后再 startRun：run#2 trigger='rework'
//   6) auto_accept=1（origin='dispatch' 回填行）：submit 即 completed，
//      answer answeredByNodeId='system:auto'，无 pending acceptance 残留
//   7) 返工上限：reject 到第 10 个 run 后再 reject → 人话拒（建议取消）
//   8) 无 run 任务 submit/accept/reject → 人话拒；任务已取消（验收请求仍
//      pending）时 accept/reject → 人话边界锁（transition 不许终态转出）
// 隔离：沿 lifecycle-runs-core.test.ts 形态——每 case 独立 tmp 目录 + closeDb。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, updateTask, transitionTaskStatus } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { getActiveRun, listRuns } from '../../src/main/storage/tasks/runs-repo';
import {
  insertHumanRequest,
  listByTask,
} from '../../src/main/storage/tasks/human-requests-repo';
import {
  MAX_RUNS_PER_TASK,
  startRun,
  cancelActiveRun,
  submitRun,
  acceptTask,
  rejectTask,
} from '../../src/main/task/lifecycle-runs';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-lifecycle-runs-submit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

/** 验收请求挂任务的执行会话（human_requests.session_id FK → sessions） */
let execSessionId = '';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  execSessionId = insertSession({ workspaceId: 'ws1', title: '执行', kind: 'chat' }).id;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 种一个 assigned 任务（生产合法起点；执行会话先行，submitRun 验收请求挂它） */
function seedAssignedTask(extra: Record<string, unknown> = {}): string {
  const t = insertTask({
    workspaceId: 'ws1',
    title: 'T',
    creatorUserId: '@owner:home',
    assigneeAgentId: 'inst-1',
    status: 'assigned',
    executionSessionId: execSessionId,
    ...extra,
  });
  return t.id;
}

/** run 下未决非验收请求（question）——提交闸的对象 */
function seedPendingQuestion(taskId: string, runId: string): string {
  return insertHumanRequest({
    sessionId: execSessionId,
    kind: 'question',
    title: '需要人工输入',
    taskId,
    runId,
  }).id;
}

/** 任务下未决验收请求（唯一）——submitRun 的产物 */
function pendingAcceptance(taskId: string) {
  return listByTask(taskId).find(
    (r) => r.kind === 'acceptance' && r.status === 'pending',
  );
}

/** 生产合法链：startRun → submitRun（run running → submitted、任务 → submitted） */
async function seedSubmitted(taskId: string, summary = '交付完成'): Promise<void> {
  startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
  await submitRun(taskId, { summary });
}

describe('1) submitRun 提交全链', () => {
  it('run → submitted(deliverable_json) + 任务 → submitted(submitted_at) + acceptance 请求全字段落库', async () => {
    const taskId = seedAssignedTask();
    startRun(taskId, { trigger: 'initial', executionSessionId: execSessionId });
    const before = Date.now();
    await submitRun(taskId, {
      summary: '功能完成，附测试',
      files: ['src/a.ts', 'src/b.ts'],
      artifacts: [{ label: '测试', value: '通过 12 例' }],
    });

    // run：submitted + 交付载荷；提交非终结，endedAt 保持 null
    const run = getActiveRun(taskId)!;
    expect(run.status).toBe('submitted');
    expect(run.endedAt).toBeNull();
    expect(JSON.parse(run.deliverableJson!)).toEqual({
      summary: '功能完成，附测试',
      files: ['src/a.ts', 'src/b.ts'],
      artifacts: [{ label: '测试', value: '通过 12 例' }],
    });

    // 任务：submitted + submitted_at
    const task = getTask(taskId)!;
    expect(task.status).toBe('submitted');
    expect(task.submittedAt).not.toBeNull();
    expect(task.submittedAt!).toBeGreaterThanOrEqual(before);

    // acceptance 请求：kind/超时策略/期限/标题/载荷/关联字段（spec §5.3/§6.5/§6.7）
    const req = pendingAcceptance(taskId)!;
    expect(req).toBeDefined();
    expect(req.kind).toBe('acceptance');
    expect(req.status).toBe('pending');
    expect(req.timeoutPolicy).toBe('keep_waiting');
    expect(req.deadlineAt!).toBeGreaterThan(before + 23 * 3600_000);
    expect(req.deadlineAt!).toBeLessThan(before + 25 * 3600_000);
    expect(req.title).toContain(taskId); // 标题含任务号
    expect(req.taskId).toBe(taskId);
    expect(req.runId).toBe(run.id);
    expect(req.sessionId).toBe(execSessionId);
    expect(JSON.parse(req.payloadJson!)).toEqual({
      acceptance: {
        runNo: run.runNo,
        summary: '功能完成，附测试',
        files: ['src/a.ts', 'src/b.ts'],
        artifacts: [{ label: '测试', value: '通过 12 例' }],
      },
    });
  });

  it('任务无执行会话但有 source_session_id → 验收请求挂来源会话；两者皆无 → 人话拒', async () => {
    const sourceSessionId = insertSession({ workspaceId: 'ws1', title: '来源', kind: 'chat' }).id;
    const fallback = insertTask({
      workspaceId: 'ws1',
      title: 'T2',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-1',
      status: 'assigned',
      sourceSessionId,
    });
    startRun(fallback.id, { trigger: 'initial' });
    await submitRun(fallback.id, { summary: '交付' });
    expect(pendingAcceptance(fallback.id)!.sessionId).toBe(sourceSessionId);

    const orphan = insertTask({
      workspaceId: 'ws1',
      title: 'T3',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-1',
      status: 'assigned',
    });
    startRun(orphan.id, { trigger: 'initial' });
    await expect(submitRun(orphan.id, { summary: '交付' })).rejects.toThrow('无关联会话');
    expect(getActiveRun(orphan.id)!.status).toBe('running'); // 拒绝零副作用
    expect(pendingAcceptance(orphan.id)).toBeUndefined();
  });
});

describe('2) 提交闸：未决非验收请求', () => {
  it('有未决 question → 人话拒（含「先处理未决请求」），run/任务/请求零副作用', async () => {
    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial' });
    seedPendingQuestion(taskId, run.id);

    await expect(submitRun(taskId, { summary: '交付' })).rejects.toThrow('先处理未决请求');

    expect(getActiveRun(taskId)!.status).toBe('running');
    expect(getActiveRun(taskId)!.deliverableJson).toBeNull();
    expect(getTask(taskId)!.status).toBe('in_progress');
    expect(getTask(taskId)!.submittedAt).toBeNull();
    expect(pendingAcceptance(taskId)).toBeUndefined();
  });
});

describe('3) acceptTask 验收通过', () => {
  it('任务 completed(accepted_at+completed_at) + run accepted(endedAt) + acceptance answered', async () => {
    const taskId = seedAssignedTask();
    await seedSubmitted(taskId);
    const runId = getActiveRun(taskId)!.id;

    await acceptTask(taskId);

    expect(getTask(taskId)!.status).toBe('completed');
    expect(getTask(taskId)!.acceptedAt).not.toBeNull();
    expect(getTask(taskId)!.completedAt).not.toBeNull();
    expect(getActiveRun(taskId)).toBeNull(); // accepted 是终态
    const run = listRuns(taskId)[0]!;
    expect(run.status).toBe('accepted');
    expect(run.endedAt).not.toBeNull();
    const req = listByTask(taskId).find((r) => r.kind === 'acceptance')!;
    expect(req.status).toBe('answered');
    expect(JSON.parse(req.answerJson!)).toEqual({ decision: 'accept' });
    expect(req.answeredAt).not.toBeNull();

    // 再 accept → 人话拒（run 已终态，无活动 run；Review Focus #4）
    await expect(acceptTask(taskId)).rejects.toThrow('无活动 run');
  });

  it('run 非 submitted（running 中直接验收）→ 人话拒，零副作用', async () => {
    const taskId = seedAssignedTask();
    startRun(taskId, { trigger: 'initial' });

    await expect(acceptTask(taskId)).rejects.toThrow('submitted');

    expect(getActiveRun(taskId)!.status).toBe('running');
    expect(getTask(taskId)!.status).toBe('in_progress');
  });
});

describe('4) rejectTask 打回', () => {
  it('任务 assigned + run rejected(理由落库) + acceptance 答复 reject(reason)', async () => {
    const taskId = seedAssignedTask();
    await seedSubmitted(taskId);
    const runId = getActiveRun(taskId)!.id;

    await rejectTask(taskId, '覆盖不足，补充边界用例');

    expect(getTask(taskId)!.status).toBe('assigned');
    expect(getActiveRun(taskId)).toBeNull();
    const run = listRuns(taskId)[0]!;
    expect(run.status).toBe('rejected');
    expect(run.rejectReason).toBe('覆盖不足，补充边界用例');
    expect(run.endedAt).not.toBeNull();
    const req = listByTask(taskId).find((r) => r.kind === 'acceptance')!;
    expect(req.status).toBe('answered');
    expect(JSON.parse(req.answerJson!)).toEqual({
      decision: 'reject',
      reason: '覆盖不足，补充边界用例',
    });
  });

  it('空白理由 → 人话拒（与 move 校验双保险），零副作用', async () => {
    const taskId = seedAssignedTask();
    await seedSubmitted(taskId);

    await expect(rejectTask(taskId, '   ')).rejects.toThrow('打回必须填写理由');

    expect(getTask(taskId)!.status).toBe('submitted');
    expect(getActiveRun(taskId)!.status).toBe('submitted');
    expect(pendingAcceptance(taskId)).toBeDefined(); // 验收单不被误答
  });
});

describe('5) 打回后重跑', () => {
  it('reject 后 startRun(trigger=rework) → run#2(rework/running) + 任务 in_progress', async () => {
    const taskId = seedAssignedTask();
    await seedSubmitted(taskId);
    await rejectTask(taskId, '第一轮不合格');

    const run2 = startRun(taskId, { trigger: 'rework' });

    expect(run2.runNo).toBe(2);
    expect(run2.trigger).toBe('rework');
    expect(run2.status).toBe('running');
    expect(getTask(taskId)!.status).toBe('in_progress');
    expect(getTask(taskId)!.currentRunId).toBe(run2.id);
  });
});

describe('6) auto_accept 自动验收', () => {
  it('origin=dispatch 回填行 submit 即 completed，system:auto 答复，无 pending 残留', async () => {
    const taskId = seedAssignedTask({ origin: 'dispatch' });
    // insertTask 不写 v2 生命周期列（auto_accept 由迁移 082 / dispatch 回填落库）——
    // 测试沿生产等价路径 updateTask 回填
    updateTask(taskId, { autoAccept: true });

    await seedSubmitted(taskId, '编排产物回填');

    const task = getTask(taskId)!;
    expect(task.status).toBe('completed');
    expect(task.acceptedAt).not.toBeNull();
    expect(task.completedAt).not.toBeNull();
    expect(listRuns(taskId)[0]!.status).toBe('accepted');
    const req = listByTask(taskId).find((r) => r.kind === 'acceptance')!;
    expect(req.status).toBe('answered');
    expect(req.answeredByNodeId).toBe('system:auto');
    expect(pendingAcceptance(taskId)).toBeUndefined(); // 无 pending 残留
  });
});

describe('7) 返工上限', () => {
  it(`reject 到第 ${MAX_RUNS_PER_TASK} 个 run 后再 reject → 人话拒并建议取消，零副作用`, async () => {
    const taskId = seedAssignedTask();
    for (let cycle = 1; cycle < MAX_RUNS_PER_TASK; cycle++) {
      startRun(taskId, { trigger: cycle === 1 ? 'initial' : 'rework' });
      await submitRun(taskId, { summary: `第 ${cycle} 轮交付` });
      await rejectTask(taskId, `第 ${cycle} 轮打回`);
    }
    // 第 10 轮：启动+提交仍可（打回尚未发生，上限只拦「打回重建」）
    startRun(taskId, { trigger: 'rework' });
    await submitRun(taskId, { summary: '最后一轮' });
    expect(listRuns(taskId)).toHaveLength(MAX_RUNS_PER_TASK);

    await expect(rejectTask(taskId, '还要打回')).rejects.toThrow('上限');
    await expect(rejectTask(taskId, '还要打回')).rejects.toThrow('取消');

    // 拒绝零副作用：任务仍在 submitted 等 accept 通道，run/验收单不动
    expect(getTask(taskId)!.status).toBe('submitted');
    expect(getActiveRun(taskId)!.status).toBe('submitted');
    expect(pendingAcceptance(taskId)).toBeDefined();
  });
});

describe('8) 无 run / 已取消边界', () => {
  it('无 run 任务 submit/accept/reject → 人话拒，零副作用', async () => {
    const taskId = seedAssignedTask();

    await expect(submitRun(taskId, { summary: '交付' })).rejects.toThrow('无活动 run');
    await expect(acceptTask(taskId)).rejects.toThrow('无活动 run');
    await expect(rejectTask(taskId, '理由')).rejects.toThrow('无活动 run');

    expect(getTask(taskId)!.status).toBe('assigned');
    expect(listRuns(taskId)).toHaveLength(0);
  });

  it('任务已取消（验收单仍 pending）→ accept/reject 人话拒，验收单不被动答', async () => {
    const taskId = seedAssignedTask();
    await seedSubmitted(taskId);
    // 并发取消：run/任务终结（cancelActiveRun 同链），acceptance 不在 supersede 范围
    cancelActiveRun(taskId, '并发取消');
    expect(getTask(taskId)!.status).toBe('cancelled');
    const reqBefore = listByTask(taskId).find((r) => r.kind === 'acceptance')!;

    await expect(acceptTask(taskId)).rejects.toThrow();
    await expect(rejectTask(taskId, '事后打回')).rejects.toThrow();

    // 验收单保持 pending（未被并发路径误答），任务终态不被复活
    expect(getTask(taskId)!.status).toBe('cancelled');
    const reqAfter = listByTask(taskId).find((r) => r.kind === 'acceptance')!;
    expect(reqAfter.status).toBe('pending');
    expect(reqAfter.answerJson).toBeNull();
  });

  it('终态任务（cancelled 无 run）submit → 人话拒', async () => {
    const taskId = seedAssignedTask();
    transitionTaskStatus(taskId, 'cancelled');

    await expect(submitRun(taskId, { summary: '交付' })).rejects.toThrow('无活动 run');
    expect(getTask(taskId)!.status).toBe('cancelled');
  });
});
