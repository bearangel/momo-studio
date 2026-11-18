// task.continued worker 消费契约（spec 2026-11-18 §7.2）：
// 1) submitted 承接行 → acceptAndContinue + 里程碑 kind='continued' + 注入要求 + 停靠出清；
// 2) 非 submitted / 终态 / 空白要求 → 静默幂等收敛（不复活任务、不建 run）。
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
import { insertTask, getTask, updateTask } from '../../src/main/storage/tasks/repo';
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
  seedSessionLeader();
  routeUserChatMock.mockReset().mockResolvedValue(undefined);
  pushSessionMessageMock.mockClear();
  settleDocked.mockClear();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 会话种 leader 成员（注入唤醒目标；agent 定义与成员行 FK 前置） */
function seedSessionLeader(): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name, icon_emoji)
     VALUES ('def-1', 'Worker', 'worker', '1', 'p', 'm', '🤖')`,
  ).run();
  db.prepare(
    `INSERT INTO workspace_agent_members
       (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
     VALUES ('agent-1', 'ws1', 'def-1', '@agent-1:s', 1)`,
  ).run();
  addSessionMember(sessionId, 'agent-1', true);
}

const ports: WorkerTerminalConsumePorts = {
  selfNodeId: () => SELF_NODE,
  settleDocked: (taskId, outcome) => settleDocked(taskId, outcome),
};

async function seedSubmitted(): Promise<string> {
  const t = insertTask({
    workspaceId: 'ws1', title: 'T', creatorUserId: '@owner:home', assigneeAgentId: 'agent-1',
    status: 'assigned', delegationId: DELEGATION_ID, executionSessionId: sessionId,
  });
  // delegation_role 不在 insertTask 列集（生产由 dispatch-submit 回执补戳）
  updateTask(t.id, { delegationRole: 'in' });
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
    expect(listRuns(id)[1]!.trigger).toBe('continue');
    const msg = pushSessionMessageMock.mock.calls.at(-1)?.[0] as { body: string };
    expect(msg.body).toContain('【发起方要求继续】按主题一写正文');
    expect(routeUserChatMock).toHaveBeenCalled();
    expect(settleDocked).toHaveBeenCalledWith(DELEGATION_ID, 'continued');
  });

  it('空白要求 / 非 submitted / 终态 → 静默零写入', async () => {
    const id = await seedSubmitted();
    handleTaskContinued({ taskId: DELEGATION_ID, runNo: 2, requirement: '   ' }, ports);
    expect(getTask(id)!.status).toBe('submitted');
    handleTaskContinued({ taskId: 'dl-miss', runNo: 2, requirement: '继续' }, ports);
    expect(settleDocked).not.toHaveBeenCalled();
    handleTaskContinued({ taskId: DELEGATION_ID, runNo: 2, requirement: '继续' }, ports);
    handleTaskContinued({ taskId: DELEGATION_ID, runNo: 3, requirement: '再继续' }, ports);
    expect(listRuns(id)).toHaveLength(2);
    expect(settleDocked).toHaveBeenCalledTimes(1);
  });
});
