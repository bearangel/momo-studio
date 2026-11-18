// human:list 投影 canDecide 契约锁（spec 2026-11-18 DEC-2）：
// acceptance 行按任务 delegation_role 判定裁决权；其他 kind 恒 true。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, updateTask } from '../../src/main/storage/tasks/repo';
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

function seedAcceptance(delegationRole: 'in' | 'out' | null): string {
  const task = insertTask({
    workspaceId: 'ws1', title: 'T', creatorUserId: '@owner:home',
    assigneeAgentId: 'inst-1', status: 'submitted',
  });
  // delegation_role 不在 insertTask 列集（生产由 dispatch-submit 回执补戳）
  if (delegationRole !== null) updateTask(task.id, { delegationRole, delegationId: 'dl-1' });
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
