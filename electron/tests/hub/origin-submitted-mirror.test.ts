// electron/tests/hub/origin-submitted-mirror.test.ts
//
// 任务生命周期 v2 P2 S5 回归锁（spec 2026-11-13 §8.3/§8.6 发起方镜像消费）：
// hub 定向 task.intervention { taskId, intervention } / task.submitted
// { taskId, runNo, deliverable? } → remote-intervene-bridge 发起方消费：
//   1) intervention 镜像行字段完整性（origin/remote 幂等键 + payload/options/
//      deadline 逐字段复制；session 挂 execution_session_id；任务态不动）
//   2) UNIQUE 幂等：同 interventionId 二次事件零重复行 + 零重复里程碑
//   3) submitted：run 懒建（首个即 submitted + trigger initial + current_run_id）
//      + 任务态直写 submitted/submitted_at（§5.1 白名单豁免惯例）
//   4) acceptance 镜像行 + deliverable 逐字段映射（缺席降级空 summary/files/
//      artifacts；remote_id=`${delegationId}#${runNo}` 合成幂等键）
//   5) 终态静默（双通道并存期：旧 done 拍直写先收口 → 幂等丢弃）
//   6) 非 'out' 行静默（本机承接行/普通本地行不消费发起方事件）
//   7) 有会话时里程碑两条（remote_intervention/remote_submitted，meta 含
//      runNo/interventionId/delegationId）+ 行已存在跳过里程碑（判重取舍）
//   8) origin_node_id 取值路径裁定锁：外派行 routing 缺目标节点 → 镜像跳过
//      （双 NULL 不幂等，宁缺镜像）；submitted 状态仍收口
//
// mock 边界（momo-test-rules #5）：事件入口直调（hub/index onEvent 仅薄转发）；
// DB 真实（worker-answer-consume.test.ts 同款 AP_USER_DATA_DIR 临时库）；
// pushSessionMessage 无 BrowserWindow 环境静默跳过（stream-relay 自带降级）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, updateTask, type TaskRow } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { getActiveRun, listRuns } from '../../src/main/storage/tasks/runs-repo';
import { listRequests } from '../../src/main/storage/tasks/human-requests-repo';
import {
  handleTaskInterventionMirror,
  handleTaskSubmittedMirror,
} from '../../src/main/hub/remote-intervene-bridge';

const WORKER_NODE = 'node-worker';
const DELEGATION_ID = 'dl-s5-1';
const tmpRoot = path.join(
  os.tmpdir(),
  `ap-origin-submitted-mirror-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

let execSessionId = '';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  execSessionId = insertSession({ workspaceId: 'ws1', title: '跟踪', kind: 'chat' }).id;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 种外派行（delegation_role='out' 缺省戳；routing 缺省 node→WORKER_NODE） */
function seedOutTask(opts?: {
  sessionId?: string | null;
  routing?: TaskRow['routing'];
  role?: 'out' | null;
  status?: TaskRow['status'];
}): TaskRow {
  const t = insertTask({
    workspaceId: 'ws1',
    title: '外派任务',
    creatorUserId: '@owner:home',
    status: opts?.status ?? 'pending',
    executionSessionId: opts?.sessionId === undefined ? execSessionId : opts.sessionId,
    delegationId: DELEGATION_ID,
    routing: opts?.routing ?? { mode: 'node', groupId: 'g-1', targetNodeId: WORKER_NODE },
  });
  const role = opts?.role === undefined ? 'out' : opts.role;
  if (role !== null) updateTask(t.id, { delegationRole: role });
  return getTask(t.id)!;
}

/** 协议 TaskInterventionEvent 形状（intervention 逐字段全量） */
function interventionEvent(): unknown {
  return {
    taskId: DELEGATION_ID,
    intervention: {
      interventionId: 'iv-1',
      runNo: 1,
      kind: 'question',
      title: '确认方案',
      prompt: 'A 还是 B？',
      payload: { tool: 'bash', target: '/tmp/x' },
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B', description: 'B 方案' },
      ],
      deadlineAt: 1893456000000,
    },
  };
}

/** 协议 TaskSubmittedEvent 形状 */
function submittedEvent(input?: { runNo?: number; deliverable?: Record<string, unknown> }): unknown {
  return {
    taskId: DELEGATION_ID,
    runNo: input?.runNo ?? 1,
    ...(input?.deliverable !== undefined ? { deliverable: input.deliverable } : {}),
  };
}

/** delegation_milestone 行（context_json 为 meta 载体列） */
function milestoneRows(): Array<{ body: string; meta: Record<string, unknown> }> {
  const rows = getDb()
    .prepare(`SELECT body, context_json FROM messages WHERE event_type = 'delegation_milestone'`)
    .all() as Array<{ body: string; context_json: string | null }>;
  return rows.map((r) => ({
    body: r.body,
    meta: r.context_json === null ? {} : (JSON.parse(r.context_json) as Record<string, unknown>),
  }));
}

// ── 1) intervention 镜像行字段完整性 ────────────────────────────────────────

describe('1) intervention → 镜像行逐字段', () => {
  it('UNIQUE 键 + kind/title/prompt/payload/options/deadline 逐字段复制；任务态不动', () => {
    const task = seedOutTask();
    handleTaskInterventionMirror(interventionEvent());

    const rows = listRequests({ status: 'all' });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.taskId).toBe(task.id);
    expect(row.runId).toBeNull(); // run 懒建只在 submitted 事件（spec §8.4）
    expect(row.sessionId).toBe(execSessionId);
    expect(row.delegationId).toBe(DELEGATION_ID);
    expect(row.originNodeId).toBe(WORKER_NODE); // 外派行 routing 回写的执行节点
    expect(row.remoteId).toBe('iv-1');
    expect(row.kind).toBe('question');
    expect(row.status).toBe('pending');
    expect(row.title).toBe('确认方案');
    expect(row.prompt).toBe('A 还是 B？');
    expect(JSON.parse(row.payloadJson!)).toEqual({ tool: 'bash', target: '/tmp/x' });
    expect(JSON.parse(row.optionsJson!)).toEqual([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B', description: 'B 方案' },
    ]);
    expect(row.deadlineAt).toBe(1893456000000);
    expect(row.timeoutPolicy).toBe('keep_waiting');
    // 任务态不动（waiting_human 由镜像行 + 既有徽标派生，本 task 不改）
    expect(getTask(task.id)!.status).toBe('pending');
    expect(listRuns(task.id)).toHaveLength(0);
  });
});

// ── 2) UNIQUE 幂等 ───────────────────────────────────────────────────────────

describe('2) 同 interventionId 二次事件 → 零重复行零重复里程碑', () => {
  it('重放后行数/里程碑数不变', () => {
    seedOutTask();
    handleTaskInterventionMirror(interventionEvent());
    handleTaskInterventionMirror(interventionEvent());

    expect(listRequests({ status: 'all' })).toHaveLength(1);
    expect(milestoneRows()).toHaveLength(1); // 行已存在 → 跳过里程碑（判重取舍）
  });
});

// ── 3) run 懒建 + 任务态 ─────────────────────────────────────────────────────

describe('3) submitted → run 懒建（首达即 submitted）+ 任务态直写', () => {
  it('无活动 run 时 insertRun(runNo=事件值, submitted, initial) + current_run_id 指针', () => {
    const task = seedOutTask();
    handleTaskSubmittedMirror(
      submittedEvent({ deliverable: { summary: '交付完成' } }),
    );

    const run = getActiveRun(task.id);
    expect(run).not.toBeNull();
    expect(run!.runNo).toBe(1); // 事件 runNo，不重排
    expect(run!.status).toBe('submitted'); // 首个到达的就是 submitted，不伪造 running
    expect(run!.trigger).toBe('initial');
    expect(run!.executionSessionId).toBe(execSessionId);

    const after = getTask(task.id)!;
    expect(after.status).toBe('submitted'); // pending → submitted 直写（豁免惯例）
    expect(after.submittedAt).not.toBeNull();
    expect(after.currentRunId).toBe(run!.id);
  });

  it('重复 submitted（同 runNo）→ 幂等跳过（一行 acceptance 一个 run）', () => {
    const task = seedOutTask();
    handleTaskSubmittedMirror(submittedEvent({ deliverable: { summary: 's' } }));
    handleTaskSubmittedMirror(submittedEvent({ deliverable: { summary: 's' } }));

    expect(listRuns(task.id)).toHaveLength(1);
    expect(listRequests({ status: 'all' })).toHaveLength(1);
    expect(milestoneRows()).toHaveLength(1);
  });
});

// ── 4) acceptance 镜像行 + deliverable 映射 ──────────────────────────────────

describe('4) acceptance 行生成 + deliverable 逐字段映射', () => {
  it('summary/files/artifacts 透传；runId/taskId 关联；合成 remote_id', () => {
    const task = seedOutTask();
    handleTaskSubmittedMirror(
      submittedEvent({
        runNo: 2,
        deliverable: {
          summary: '完成报告',
          files: ['/tmp/a.md', '/tmp/b.md'],
          artifacts: [{ label: '报告', value: '见附件' }],
        },
      }),
    );

    const rows = listRequests({ status: 'all' });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe('acceptance');
    expect(row.taskId).toBe(task.id);
    expect(row.runId).toBe(getActiveRun(task.id)!.id);
    expect(row.sessionId).toBe(execSessionId);
    expect(row.originNodeId).toBe(WORKER_NODE);
    expect(row.remoteId).toBe(`${DELEGATION_ID}#2`);
    expect(JSON.parse(row.payloadJson!)).toEqual({
      acceptance: {
        runNo: 2,
        summary: '完成报告',
        files: ['/tmp/a.md', '/tmp/b.md'],
        artifacts: [{ label: '报告', value: '见附件' }],
      },
    });
    expect(row.deadlineAt).not.toBeNull(); // 24h 提醒期限（与本地 acceptance 同刻度）
  });

  it('deliverable 缺席 → 空 summary / files / artifacts 降级', () => {
    seedOutTask();
    handleTaskSubmittedMirror(submittedEvent());

    const row = listRequests({ status: 'all' })[0]!;
    expect(JSON.parse(row.payloadJson!)).toEqual({
      acceptance: { runNo: 1, summary: '', files: [], artifacts: [] },
    });
  });
});

// ── 5) 终态静默（双通道并存期） ──────────────────────────────────────────────

describe('5) 任务已终态 → 静默幂等', () => {
  it('completed（旧 done 拍直写先收口）后 submitted/intervention 到达零副作用', () => {
    const task = seedOutTask({ status: 'completed' });
    handleTaskSubmittedMirror(submittedEvent());
    handleTaskInterventionMirror(interventionEvent());

    expect(listRuns(task.id)).toHaveLength(0);
    expect(listRequests({ status: 'all' })).toHaveLength(0);
    expect(milestoneRows()).toHaveLength(0);
    expect(getTask(task.id)!.status).toBe('completed');
  });
});

// ── 6) 非 'out' 行静默 ───────────────────────────────────────────────────────

describe('6) 非 out 行（承接行/普通本地行）→ 静默', () => {
  it('delegation_role 为 null 的委派行不消费发起方事件', () => {
    const task = seedOutTask({ role: null });
    handleTaskSubmittedMirror(submittedEvent());
    handleTaskInterventionMirror(interventionEvent());

    expect(listRuns(task.id)).toHaveLength(0);
    expect(listRequests({ status: 'all' })).toHaveLength(0);
    expect(getTask(task.id)!.status).toBe('pending');
  });
});

// ── 7) 里程碑两条 + 判重 ─────────────────────────────────────────────────────

describe('7) 有会话时里程碑 remote_intervention/remote_submitted 各一条', () => {
  it('meta 含 runNo/interventionId/delegationId；行已存在跳过里程碑', () => {
    const task = seedOutTask();
    handleTaskInterventionMirror(interventionEvent());
    handleTaskSubmittedMirror(submittedEvent({ deliverable: { summary: 's' } }));

    const rows = getDb()
      .prepare(
        `SELECT session_id, sender, task_id, event_type, context_json FROM messages
         WHERE event_type = 'delegation_milestone' ORDER BY created_at ASC`,
      )
      .all() as Array<{
      session_id: string;
      sender: string;
      task_id: string | null;
      context_json: string | null;
    }>;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.session_id).toBe(execSessionId);
      expect(r.sender).toBe('system');
      expect(r.task_id).toBe(task.id);
    }
    const metas = rows.map((r) => JSON.parse(r.context_json!) as Record<string, unknown>);
    expect(metas[0]).toEqual({
      kind: 'remote_intervention',
      interventionId: 'iv-1',
      runNo: 1,
      delegationId: DELEGATION_ID,
    });
    expect(metas[1]).toEqual({
      kind: 'remote_submitted',
      runNo: 1,
      delegationId: DELEGATION_ID,
    });

    // 重放 intervention（镜像行已存在）→ 里程碑不增
    handleTaskInterventionMirror(interventionEvent());
    expect(milestoneRows()).toHaveLength(2);
  });
});

// ── 8) origin_node_id 取值路径裁定锁 ─────────────────────────────────────────

describe('8) 外派行路由缺目标节点 → 镜像跳过（双 NULL 不幂等）', () => {
  it('intervention：零行零里程碑不抛；submitted：状态收口但无 acceptance 行', () => {
    const task = seedOutTask({ routing: { mode: 'local' } });
    expect(() => handleTaskInterventionMirror(interventionEvent())).not.toThrow();
    handleTaskSubmittedMirror(submittedEvent());

    // intervention 全跳过；submitted 状态与 run 照收口（hub 账本权威）
    expect(getTask(task.id)!.status).toBe('submitted');
    expect(getActiveRun(task.id)).not.toBeNull();
    expect(listRequests({ status: 'all' })).toHaveLength(0); // 镜像行零落库
    expect(milestoneRows()).toHaveLength(0);
  });
});

// ── 9) S5 review Minor #1/#2 补锁（P2 S6 顺手）──────────────────────────────

describe('9) rework-runNo 分支：活动 run 号与事件不符 → 沿用活动行不建新 run', () => {
  it('run#1 已存在时 submitted(runNo=2) 到达 → run 不增、acceptance 锚定既有 run', () => {
    const task = seedOutTask();
    handleTaskSubmittedMirror(submittedEvent({ deliverable: { summary: '首次提交' } }));
    const firstRun = getActiveRun(task.id)!;

    // 返工重提形态：同任务新 runNo 的 submitted 事件（任务仍非终态）
    handleTaskSubmittedMirror(
      submittedEvent({ runNo: 2, deliverable: { summary: '返工再提' } }),
    );

    expect(listRuns(task.id)).toHaveLength(1); // 不伪造 rejected 换号（S7 对账兜底）
    const rows = listRequests({ status: 'all' });
    expect(rows).toHaveLength(2);
    const second = rows[1]!;
    expect(second.remoteId).toBe(`${DELEGATION_ID}#2`);
    expect(second.runId).toBe(firstRun.id); // 弱化锚定：沿用活动 run 行
    expect(getTask(task.id)!.status).toBe('submitted');
    // 里程碑照记（remote_submitted runNo=2）
    const metas = milestoneRows().map((m) => m.meta);
    expect(metas).toContainEqual({
      kind: 'remote_submitted',
      runNo: 2,
      delegationId: DELEGATION_ID,
    });
  });
});

describe('10) session-空变体：execution_session_id 缺失 → 状态收口但镜像/里程碑跳过', () => {
  it('run 懒建照常；acceptance 行与里程碑零落库不抛', () => {
    const task = seedOutTask({ sessionId: null });
    expect(() => handleTaskSubmittedMirror(submittedEvent())).not.toThrow();

    expect(getTask(task.id)!.status).toBe('submitted'); // hub 账本权威，状态先收口
    const run = getActiveRun(task.id);
    expect(run).not.toBeNull();
    expect(run!.executionSessionId).toBeNull();
    expect(listRequests({ status: 'all' })).toHaveLength(0);
    expect(milestoneRows()).toHaveLength(0);
  });
});
