// electron/tests/task/lifecycle-runs-human.test.ts
//
// requestHuman / answerHuman + 【人工答复】系统注入契约锁（任务生命周期 v2 Task 11，spec §6 HITL）。
// 覆盖（brief Step 1 六用例 + Review Focus #1 两条 stale/终态窗口，共 8 组）：
//   1) requestHuman(question)：请求 pending + 任务 waiting_human + run waiting_human
//      （附 manual_action 缺省 escalate + deadlineMinutes → deadline_at）
//   2) answerHuman：请求 answered + 任务 in_progress + system 消息 1 条
//      （sender='system'、event_type='human_answer'、body 前缀【人工答复】）
//      + routeUserChat 调用 1 次（systemKickoff=true，leader 接待目标）
//   3) 任务取消后答复（Review Focus #1）：cancelActiveRun 后 answerHuman →
//      {disposition:'stale'} + 零消息 + 零 routeUserChat
//   4) manual_action completed=false + text：同样注入（正文含说明文本与未完成）
//   5) acceptance kind 走 answerHuman → throw 契约错
//   6) 双答幂等：第二次 answerHuman → stale（零增量注入）
//   7) 终态窗口（Review Focus #1 后半）：请求仍 pending 但任务已终态 →
//      答复落库 answered 但零注入零唤醒
//   8) tool_gate 分派：无注册回调 → answered 落库不抛；注册后回调收到 (requestId, answer)
// 隔离：沿 lifecycle-runs-core.test.ts 形态——每 case 独立 tmp 目录 + closeDb；
// mock 收窄到 router / push 边界（getRouterService、pushSessionMessage），DB 真实。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// router 边界打桩：human-answer-inject 经 getRouterService 取 RouterService 单例，
// 测试恒有 router（断言唤醒调用形状）；routeUserChat 仿真真实签名（返回 Promise）
const { routeUserChatMock, pushSessionMessageMock } = vi.hoisted(() => ({
  routeUserChatMock: vi.fn<(input: unknown) => Promise<void>>(),
  pushSessionMessageMock: vi.fn<(msg: unknown) => void>(),
}));
vi.mock('../../src/main/agent/router-bootstrap', () => ({
  getRouterService: () => ({ routeUserChat: routeUserChatMock }),
}));
// push 边界打桩：保真 spread 真实模块（其余导出原样），只替换推送函数供断言
vi.mock('../../src/main/agent/stream-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/agent/stream-relay')>()),
  pushSessionMessage: (msg: unknown) => pushSessionMessageMock(msg),
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, updateTask } from '../../src/main/storage/tasks/repo';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import { getActiveRun } from '../../src/main/storage/tasks/runs-repo';
import {
  insertHumanRequest,
  getHumanRequest,
} from '../../src/main/storage/tasks/human-requests-repo';
import {
  startRun,
  cancelActiveRun,
  submitRun,
  acceptTask,
  requestHuman,
  answerHuman,
  setToolGateHandler,
  setHumanAnswerKickoff,
} from '../../src/main/task/lifecycle-runs';
// 注入装配（Task 14 循环依赖修复后 lifecycle-runs 不再静态引 inject——生产由
// registerSandboxIpc 注册，测试在此同款装配锁「注册→注入生效」契约）
import { sendSystemKickoffMessage } from '../../src/main/task/human-answer-inject';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-lifecycle-runs-human-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

// human_requests.session_id 有 FK → sessions；HITL 请求种子的会话父行
let hitlSessionId = '';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  hitlSessionId = insertSession({ workspaceId: 'ws1', title: 'HITL', kind: 'chat' }).id;
  setHumanAnswerKickoff(sendSystemKickoffMessage);
  routeUserChatMock.mockReset().mockResolvedValue(undefined);
  pushSessionMessageMock.mockClear();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 种一个 assigned 任务（生产合法起点：assigned → in_progress 由 startRun 投影） */
function seedAssignedTask(): string {
  const t = insertTask({
    workspaceId: 'ws1',
    title: 'T',
    creatorUserId: '@owner:home',
    assigneeAgentId: 'inst-leader',
    status: 'assigned',
  });
  return t.id;
}

/** 会话种一个 leader 成员（执行会话同构：assignee 即 leader，starter 建会时标 is_leader=1） */
function seedSessionLeader(sessionId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name, icon_emoji)
     VALUES ('def-1', 'Worker', 'worker', '1', 'p', 'm', '🤖')`,
  ).run();
  db.prepare(
    `INSERT INTO workspace_agent_members
       (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
     VALUES ('inst-leader', 'ws1', 'def-1', '@inst-leader:s', 1)`,
  ).run();
  addSessionMember(sessionId, 'inst-leader', true);
}

/** 会话内 system 行计数（注入断言载体） */
function systemRows(sessionId: string): Array<{ sender: string; event_type: string; body: string }> {
  return getDb()
    .prepare(`SELECT sender, event_type, body FROM messages WHERE session_id = ? AND sender = 'system'`)
    .all(sessionId) as Array<{ sender: string; event_type: string; body: string }>;
}

describe('1) requestHuman(question)：请求 + 任务/双 waiting_human', () => {
  it('请求 pending（keep_waiting 缺省、无 deadline）+ 任务 waiting_human + run waiting_human', () => {
    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial' });

    const req = requestHuman({
      sessionId: hitlSessionId,
      kind: 'question',
      title: '确认方案',
      prompt: 'A 还是 B？',
      taskId,
      runId: run.id,
      optionsJson: JSON.stringify(['A', 'B']),
    });

    expect(req.status).toBe('pending');
    expect(req.kind).toBe('question');
    expect(req.timeoutPolicy).toBe('keep_waiting');
    expect(req.deadlineAt).toBeNull();
    expect(getTask(taskId)!.status).toBe('waiting_human');
    expect(getActiveRun(taskId)!.status).toBe('waiting_human');
    // 有 run 但未绑 runId 的入参透传不改动（显式 null 保持 null）
    expect(req.runId).toBe(run.id);
  });

  it('manual_action 缺省 escalate + deadlineMinutes → deadline_at = now + 分钟', () => {
    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial' });
    const before = Date.now();

    const req = requestHuman({
      sessionId: hitlSessionId,
      kind: 'manual_action',
      title: '手动改配置',
      prompt: '请打开设置页',
      taskId,
      runId: run.id,
      deadlineMinutes: 30,
    });

    expect(req.timeoutPolicy).toBe('escalate');
    expect(req.deadlineAt).toBeGreaterThan(before + 29 * 60_000);
    expect(req.deadlineAt).toBeLessThan(Date.now() + 31 * 60_000);
  });

  it('无任务会话仅建请求（不动任何任务态）', () => {
    const req = requestHuman({
      sessionId: hitlSessionId,
      kind: 'question',
      title: '随便问问',
      prompt: '在吗',
    });
    expect(req.taskId).toBeNull();
    expect(req.status).toBe('pending');
  });
});

describe('2) answerHuman：answered + in_progress + 系统注入 + 唤醒', () => {
  it('答复落库 + 任务/run 恢复 + system 消息 1 条 + routeUserChat(systemKickoff) 1 次', () => {
    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial' });
    seedSessionLeader(hitlSessionId);
    const req = requestHuman({
      sessionId: hitlSessionId,
      kind: 'question',
      title: '确认方案',
      prompt: 'A 还是 B？',
      taskId,
      runId: run.id,
      optionsJson: JSON.stringify(['A', 'B']),
    });

    const answer = { selected: ['A'], text: '就用 A' };
    const disp = answerHuman(req.id, answer, 'user:local');

    expect(disp).toEqual({ disposition: 'answered' });
    const row = getHumanRequest(req.id)!;
    expect(row.status).toBe('answered');
    expect(row.answerJson).toBe(JSON.stringify(answer));
    expect(row.answeredByNodeId).toBe('user:local');
    expect(row.answeredAt).not.toBeNull();
    expect(getTask(taskId)!.status).toBe('in_progress');
    expect(getActiveRun(taskId)!.status).toBe('running');

    const sys = systemRows(hitlSessionId);
    expect(sys).toHaveLength(1);
    expect(sys[0]!.event_type).toBe('human_answer');
    expect(sys[0]!.body.startsWith('【人工答复】')).toBe(true);
    expect(sys[0]!.body).toContain('已选：A');
    expect(pushSessionMessageMock).toHaveBeenCalledTimes(1);
    // T11 评审顺手项：注入消息行与唤醒回合共享 streamSessionId（deliverChainResult 同构）
    const sysRow = getDb()
      .prepare(`SELECT stream_session_id FROM messages WHERE session_id = ? AND sender = 'system'`)
      .get(hitlSessionId) as { stream_session_id: string };
    expect(routeUserChatMock).toHaveBeenCalledTimes(1);
    expect(routeUserChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: hitlSessionId,
        assignmentId: 'inst-leader',
        systemKickoff: true,
        body: sys[0]!.body,
        streamSessionId: sysRow.stream_session_id,
      }),
    );
  });
});

describe('3) 任务取消后答复（Review Focus #1）：stale 防竞态', () => {
  it('cancelActiveRun 后 answerHuman → stale + 零消息 + 零 routeUserChat', () => {
    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial' });
    seedSessionLeader(hitlSessionId);
    const req = requestHuman({
      sessionId: hitlSessionId,
      kind: 'question',
      title: '确认方案',
      prompt: '继续吗',
      taskId,
      runId: run.id,
    });

    cancelActiveRun(taskId, '用户取消');
    expect(getHumanRequest(req.id)!.status).toBe('superseded');

    const disp = answerHuman(req.id, { text: '继续' }, 'user:local');
    expect(disp).toEqual({ disposition: 'stale' });
    expect(systemRows(hitlSessionId)).toHaveLength(0);
    expect(routeUserChatMock).not.toHaveBeenCalled();
    expect(pushSessionMessageMock).not.toHaveBeenCalled();
  });
});

describe('4) manual_action completed=false + text：同样注入', () => {
  it('正文含说明文本与未完成标记，任务恢复 in_progress', () => {
    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial' });
    seedSessionLeader(hitlSessionId);
    const req = requestHuman({
      sessionId: hitlSessionId,
      kind: 'manual_action',
      title: '手动改配置',
      prompt: '请打开设置页改回端口',
      taskId,
      runId: run.id,
    });

    const disp = answerHuman(req.id, { completed: false, text: '权限不足改不动' }, 'user:local');

    expect(disp).toEqual({ disposition: 'answered' });
    expect(getTask(taskId)!.status).toBe('in_progress');
    const sys = systemRows(hitlSessionId);
    expect(sys).toHaveLength(1);
    expect(sys[0]!.body).toContain('未完成');
    expect(sys[0]!.body).toContain('权限不足改不动');
    expect(routeUserChatMock).toHaveBeenCalledTimes(1);
  });
});

describe('5) acceptance kind 走 answerHuman → 契约错', () => {
  it('acceptance 请求 answerHuman 抛错且不落任何答复', () => {
    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial' });
    const req = insertHumanRequest({
      sessionId: hitlSessionId,
      kind: 'acceptance',
      title: '验收',
      taskId,
      runId: run.id,
    });

    expect(() => answerHuman(req.id, { decision: 'accept' }, 'user:local')).toThrow(/acceptance/);
    expect(getHumanRequest(req.id)!.status).toBe('pending');
    expect(systemRows(hitlSessionId)).toHaveLength(0);
    expect(routeUserChatMock).not.toHaveBeenCalled();
  });

  it('不存在的请求 → 人话抛错', () => {
    expect(() => answerHuman('req-nope', { text: 'x' }, 'user:local')).toThrow(/不存在/);
  });
});

describe('6) 双答幂等：第二次 answerHuman → stale', () => {
  it('重复答复 stale，零增量注入/唤醒', () => {
    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial' });
    seedSessionLeader(hitlSessionId);
    const req = requestHuman({
      sessionId: hitlSessionId,
      kind: 'question',
      title: '确认方案',
      prompt: '继续吗',
      taskId,
      runId: run.id,
    });

    expect(answerHuman(req.id, { text: '继续' }, 'user:local')).toEqual({ disposition: 'answered' });
    expect(answerHuman(req.id, { text: '再想想' }, 'user:local')).toEqual({ disposition: 'stale' });

    expect(getHumanRequest(req.id)!.answerJson).toBe(JSON.stringify({ text: '继续' }));
    expect(systemRows(hitlSessionId)).toHaveLength(1);
    expect(routeUserChatMock).toHaveBeenCalledTimes(1);
  });
});

describe('7) 终态窗口（Review Focus #1 后半）：pending 但任务已终态', () => {
  it('任务 completed 后答复 → answered 落库但零注入零唤醒', async () => {
    const taskId = seedAssignedTask();
    startRun(taskId, { trigger: 'initial' });
    seedSessionLeader(hitlSessionId);
    // 未绑 run、不挂等人的请求（窗口形态）：submitRun 的未决闸按 run_id 计数，
    // 不拦截——run 一路 running → submitted → accepted，请求全程 pending 未被顶替
    const req = insertHumanRequest({
      sessionId: hitlSessionId,
      kind: 'question',
      title: '窗口请求',
      prompt: '确认吗',
      taskId,
      runId: null,
    });
    updateTask(taskId, { executionSessionId: hitlSessionId });

    await submitRun(taskId, { summary: '交付' });
    await acceptTask(taskId);
    expect(getTask(taskId)!.status).toBe('completed');
    expect(getHumanRequest(req.id)!.status).toBe('pending'); // 窗口：请求未被顶替

    const disp = answerHuman(req.id, { text: '迟到答复' }, 'user:local');
    expect(disp).toEqual({ disposition: 'answered' });
    expect(getHumanRequest(req.id)!.status).toBe('answered');
    expect(systemRows(hitlSessionId)).toHaveLength(0); // 零注入
    expect(routeUserChatMock).not.toHaveBeenCalled(); // 零唤醒
    expect(pushSessionMessageMock).not.toHaveBeenCalled();
  });
});

describe('8) tool_gate 分派', () => {
  it('无注册回调：answered 落库不抛、零注入零唤醒', () => {
    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial' });
    const req = insertHumanRequest({
      sessionId: hitlSessionId,
      kind: 'tool_gate',
      title: '写目录授权',
      taskId,
      runId: run.id,
    });

    const disp = answerHuman(req.id, { decision: 'approve' }, 'user:local');
    expect(disp).toEqual({ disposition: 'answered' });
    expect(getHumanRequest(req.id)!.status).toBe('answered');
    expect(systemRows(hitlSessionId)).toHaveLength(0);
    expect(routeUserChatMock).not.toHaveBeenCalled();
  });

  it('注册后回调收到 (requestId, answer)；任务终态时不回调', async () => {
    const taskId = seedAssignedTask();
    const run = startRun(taskId, { trigger: 'initial' });
    const req = insertHumanRequest({
      sessionId: hitlSessionId,
      kind: 'tool_gate',
      title: '写目录授权',
      taskId,
      runId: run.id,
    });

    const calls: Array<[string, { decision?: string }]> = [];
    setToolGateHandler((id, ans) => {
      calls.push([id, ans]);
    });
    answerHuman(req.id, { decision: 'deny', reason: '不给' }, 'user:local');
    expect(calls).toEqual([[req.id, { decision: 'deny', reason: '不给' }]]);

    // 终态窗口：任务取消后（请求被顶替 → stale 不回调）+ 未顶替终态不回调
    const req2 = insertHumanRequest({
      sessionId: hitlSessionId,
      kind: 'tool_gate',
      title: '再授权',
      taskId,
      runId: null,
    });
    updateTask(taskId, { executionSessionId: hitlSessionId });
    await submitRun(taskId, { summary: '交付' });
    await acceptTask(taskId);
    expect(answerHuman(req2.id, { decision: 'approve' }, 'user:local')).toEqual({
      disposition: 'answered',
    });
    expect(calls).toHaveLength(1); // 终态后不回调
    setToolGateHandler(null); // 还原模块态，防泄漏
  });
});
