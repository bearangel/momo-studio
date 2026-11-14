// electron/tests/hub/origin-answer-routing.test.ts
//
// 任务生命周期 v2 P2 S6 回归锁（spec 2026-11-13 §8.6 发起方侧跨节点路由）：
//   A. human:answer 镜像行路由（answerHumanRouted 单点直调）：
//     1) 镜像行 → hub task.answer 载荷 { taskId: delegation_id, interventionId:
//        remote_id, answer }（message 附言并入 text）→ disposition 透传 + 本地
//        镜像行落 answered
//     2) hub stale → { disposition:'stale' }，行保持 pending
//     3) 对端离线/错误 → 人话「代答发送失败：…」，行保持 pending 可重试
//     4) peer 镜像行（外派行 origin='peer_draft'）→ 人话拒（双层防线主进程层）
//     5) 本地行 → answerHuman 直达（零转发）
//     6) 镜像 acceptance 行 → answerHuman 通道守卫（验收走 task:accept/reject）
//     7) 转发器未装配 → 人话（hub 未接入）
//   B. task:accept / task:reject 远端通知（acceptTaskRouted / rejectTaskRouted）：
//     8) 先本地后远端：forwarder 调用时本地已 completed（顺序锁）+ 载荷
//        { delegationId, outcome:'accepted' }
//     9) 打回：reason 透传 + 任务回 assigned + outcome:'rejected'
//     10) 远端通知失败 → 本地不回滚（completed 保持）+ remoteWarning 人话随行返回
//     11) 本地 acceptance（非镜像）→ 零转发
//
// mock 边界（momo-test-rules #5）：网络面（hub 转发器）注入 fake；DB 真实
// （origin-submitted-mirror.test.ts 同款 AP_USER_DATA_DIR 临时库）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, updateTask, type TaskRow } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { insertRun } from '../../src/main/storage/tasks/runs-repo';
import {
  insertHumanRequest,
  getHumanRequest,
  listByTask,
} from '../../src/main/storage/tasks/human-requests-repo';
import {
  answerHumanRouted,
  setMirrorAnswerForwarder,
  type MirrorAnswerForwardInput,
} from '../../src/main/task/human.ipc.handlers';
import {
  acceptTaskRouted,
  rejectTaskRouted,
  setRemoteTerminalForwarder,
  type RemoteTerminalForwardInput,
} from '../../src/main/task/ipc.handlers';

const WORKER_NODE = 'node-worker';
const DELEGATION_ID = 'dl-s6-2';
const tmpRoot = path.join(
  os.tmpdir(),
  `ap-origin-answer-routing-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

let sessionId = '';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  sessionId = insertSession({ workspaceId: 'ws1', title: '跟踪', kind: 'task_execution' }).id;
});

afterEach(() => {
  setMirrorAnswerForwarder(null);
  setRemoteTerminalForwarder(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 种外派行（out + node 路由；origin 可覆写 peer_draft 判 peer） */
function seedTask(opts?: {
  role?: 'out' | null;
  origin?: TaskRow['origin'];
  status?: TaskRow['status'];
}): TaskRow {
  const t = insertTask({
    workspaceId: 'ws1',
    title: '外派任务',
    creatorUserId: '@owner:home',
    status: opts?.status ?? 'pending',
    executionSessionId: sessionId,
    delegationId: DELEGATION_ID,
    ...(opts?.origin !== undefined ? { origin: opts.origin } : {}),
    routing: { mode: 'node', groupId: 'g-1', targetNodeId: WORKER_NODE },
  });
  const role = opts?.role === undefined ? 'out' : opts.role;
  if (role !== null) updateTask(t.id, { delegationRole: role });
  return getTask(t.id)!;
}

/** 种镜像干预行（question 缺省） */
function seedMirrorRequest(taskId: string, remoteId = 'iv-1', kind: 'question' | 'acceptance' = 'question') {
  return insertHumanRequest({
    sessionId,
    taskId,
    runId: null,
    kind,
    title: '确认方案',
    prompt: 'A 还是 B？',
    delegationId: DELEGATION_ID,
    originNodeId: WORKER_NODE,
    remoteId,
  });
}

/** 种「已提交待验收」形态：out 行 submitted + 活动 run submitted + pending acceptance 行 */
function seedSubmitted(taskId: string, opts?: { mirrorAcceptance?: boolean; runNo?: number }) {
  const runNo = opts?.runNo ?? 1;
  const run = insertRun({
    taskId,
    runNo,
    status: 'submitted',
    trigger: 'initial',
    executionSessionId: sessionId,
  });
  updateTask(taskId, { status: 'submitted', submittedAt: Date.now(), currentRunId: run.id });
  return insertHumanRequest({
    sessionId,
    taskId,
    runId: run.id,
    kind: 'acceptance',
    title: `${taskId} 提交验收（run #${runNo}）`,
    payloadJson: JSON.stringify({ acceptance: { runNo, summary: '完成', files: [], artifacts: [] } }),
    delegationId: DELEGATION_ID,
    ...(opts?.mirrorAcceptance === false
      ? {}
      : { originNodeId: WORKER_NODE, remoteId: `${DELEGATION_ID}#${runNo}` }),
  });
}

// ── A. human:answer 镜像行路由 ──────────────────────────────────────────────

describe('A1) 镜像行 → hub task.answer 载荷与 disposition 透传', () => {
  it('载荷 { delegationId, remoteId, answer(附言并入 text) }；answered 后本地行落 answered', async () => {
    const task = seedTask();
    const row = seedMirrorRequest(task.id);
    const seen: MirrorAnswerForwardInput[] = [];
    setMirrorAnswerForwarder(async (input) => {
      seen.push(input);
      return 'answered';
    });

    const res = await answerHumanRouted(row.id, { selected: ['a'], text: '选 A' }, '补充说明');

    expect(seen).toEqual([
      {
        delegationId: DELEGATION_ID,
        remoteId: 'iv-1',
        answer: { selected: ['a'], text: '选 A\n补充说明' },
      },
    ]);
    expect(res).toEqual({ disposition: 'answered' });
    const after = getHumanRequest(row.id)!;
    expect(after.status).toBe('answered');
    expect(JSON.parse(after.answerJson!)).toEqual({ selected: ['a'], text: '选 A\n补充说明' });
  });

  it('hub granted/denied（旧兼容 disposition）同样收口本地行 → answered', async () => {
    const task = seedTask();
    const row = seedMirrorRequest(task.id);
    setMirrorAnswerForwarder(async () => 'denied');

    expect(await answerHumanRouted(row.id, { decision: 'deny' })).toEqual({ disposition: 'answered' });
    expect(getHumanRequest(row.id)!.status).toBe('answered');
  });
});

describe('A2) hub stale → stale 透传，行保持 pending', () => {
  it('对端已答（first-wins 收敛）', async () => {
    const task = seedTask();
    const row = seedMirrorRequest(task.id);
    setMirrorAnswerForwarder(async () => 'stale');

    expect(await answerHumanRouted(row.id, { text: '晚到的答复' })).toEqual({ disposition: 'stale' });
    expect(getHumanRequest(row.id)!.status).toBe('pending');
  });
});

describe('A3) 对端离线/错误 → 人话错误，行保持 pending', () => {
  it('「代答发送失败：」前缀 + hub 原文', async () => {
    const task = seedTask();
    const row = seedMirrorRequest(task.id);
    setMirrorAnswerForwarder(async () => {
      throw new Error('hub 未连接，请先在设置中接入 momo-hub');
    });

    await expect(answerHumanRouted(row.id, { text: 'x' })).rejects.toThrow(
      '代答发送失败：hub 未连接，请先在设置中接入 momo-hub',
    );
    expect(getHumanRequest(row.id)!.status).toBe('pending');
  });
});

describe('A4) peer 镜像行 → 人话拒（双层防线主进程层）', () => {
  it('外派行 origin=peer_draft → 拒绝且零转发', async () => {
    const task = seedTask({ origin: 'peer_draft' });
    const row = seedMirrorRequest(task.id);
    const forward = vi.fn(async () => 'answered' as const);
    setMirrorAnswerForwarder(forward);

    await expect(answerHumanRouted(row.id, { text: 'x' })).rejects.toThrow(
      '平行组不转发人工请求，请在执行节点处理',
    );
    expect(forward).not.toHaveBeenCalled();
    expect(getHumanRequest(row.id)!.status).toBe('pending');
  });
});

describe('A5) 本地行 → answerHuman 直达（零转发）', () => {
  it('origin_node_id 空：既有通道，行 answered', async () => {
    const task = seedTask({ role: null });
    getDb().prepare(`UPDATE tasks SET delegation_id = NULL WHERE id = ?`).run(task.id);
    const row = insertHumanRequest({
      sessionId,
      taskId: task.id,
      runId: null,
      kind: 'question',
      title: '本地提问',
      prompt: '继续吗？',
    });
    const forward = vi.fn(async () => 'answered' as const);
    setMirrorAnswerForwarder(forward);

    expect(await answerHumanRouted(row.id, { text: '继续' })).toEqual({ disposition: 'answered' });
    expect(forward).not.toHaveBeenCalled();
    expect(getHumanRequest(row.id)!.status).toBe('answered');
  });
});

describe('A6) 镜像 acceptance 行 → answerHuman 通道守卫', () => {
  it('acceptance 不走 human.answer（验收走 task:accept / task:reject），零转发', async () => {
    const task = seedTask();
    const row = seedMirrorRequest(task.id, 'dl-acc', 'acceptance');
    const forward = vi.fn(async () => 'answered' as const);
    setMirrorAnswerForwarder(forward);

    await expect(answerHumanRouted(row.id, { decision: 'accept' })).rejects.toThrow(
      'acceptance 请求不走 answerHuman 通道——验收请走 acceptTask / rejectTask',
    );
    expect(forward).not.toHaveBeenCalled();
  });
});

describe('A7) 转发器未装配 → 人话', () => {
  it('hub 域未接线（单机/测试形态）', async () => {
    const task = seedTask();
    const row = seedMirrorRequest(task.id);
    setMirrorAnswerForwarder(null);

    await expect(answerHumanRouted(row.id, { text: 'x' })).rejects.toThrow(
      'hub 未接入，无法代答远端请求——请在执行节点处理或重新接入 momo-hub',
    );
  });
});

// ── B. task:accept / task:reject 远端通知（先本地后远端）────────────────────

describe('B8) accept：先本地后远端 + 载荷', () => {
  it('forwarder 调用时任务已 completed（顺序锁）；载荷 { delegationId, outcome }', async () => {
    const task = seedTask();
    seedSubmitted(task.id);
    const seen: Array<RemoteTerminalForwardInput & { taskStatusAtCall: string }> = [];
    setRemoteTerminalForwarder(async (input) => {
      seen.push({ ...input, taskStatusAtCall: getTask(task.id)!.status });
    });

    const res = await acceptTaskRouted(task.id);

    expect(getTask(task.id)!.status).toBe('completed');
    expect(res.status).toBe('completed');
    expect(res.remoteWarning).toBeUndefined();
    expect(seen).toEqual([
      { delegationId: DELEGATION_ID, outcome: 'accepted', taskStatusAtCall: 'completed' },
    ]);
  });
});

describe('B9) reject：reason 透传 + 任务回 assigned', () => {
  it('载荷 { delegationId, outcome:"rejected", reason }；打回后 assigned 排队返工', async () => {
    const task = seedTask();
    seedSubmitted(task.id);
    const seen: RemoteTerminalForwardInput[] = [];
    setRemoteTerminalForwarder(async (input) => {
      seen.push(input);
    });

    const res = await rejectTaskRouted(task.id, '缺少回归测试');

    expect(getTask(task.id)!.status).toBe('assigned');
    expect(res.status).toBe('assigned');
    expect(seen).toEqual([{ delegationId: DELEGATION_ID, outcome: 'rejected', reason: '缺少回归测试' }]);
    // 打回后 acceptance 行已 answered（reject 决策留痕）
    const acc = listByTask(task.id).find((r) => r.kind === 'acceptance')!;
    expect(acc.status).toBe('answered');
  });
});

describe('B10) 远端通知失败 → 本地不回滚 + remoteWarning 人话', () => {
  it('accept 通知失败：completed 保持，remoteWarning 携带 hub 原文', async () => {
    const task = seedTask();
    seedSubmitted(task.id);
    setRemoteTerminalForwarder(async () => {
      throw new Error('连接已重置');
    });

    const res = await acceptTaskRouted(task.id);

    expect(getTask(task.id)!.status).toBe('completed');
    expect(res.status).toBe('completed');
    expect(res.remoteWarning).toContain('远端验收通知失败：连接已重置');
    expect(res.remoteWarning).toContain('执行节点将在重连后对账');
  });

  it('reject 通知失败：assigned 保持，remoteWarning 携带 hub 原文', async () => {
    const task = seedTask();
    seedSubmitted(task.id);
    setRemoteTerminalForwarder(async () => {
      throw new Error('超时');
    });

    const res = await rejectTaskRouted(task.id, '样式偏差');

    expect(getTask(task.id)!.status).toBe('assigned');
    expect(res.remoteWarning).toContain('远端打回通知失败：超时');
  });
});

describe('B11) 本地 acceptance（非镜像提交）→ 零转发', () => {
  it('pending acceptance 无 origin_node_id → 本地收口不通知 hub', async () => {
    const task = seedTask();
    seedSubmitted(task.id, { mirrorAcceptance: false });
    const forward = vi.fn(async () => undefined);
    setRemoteTerminalForwarder(forward);

    await acceptTaskRouted(task.id);

    expect(getTask(task.id)!.status).toBe('completed');
    expect(forward).not.toHaveBeenCalled();
  });
});
