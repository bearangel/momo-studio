// 验收 IPC 权威守卫（spec 2026-11-18 DEC-4）：执行方（role='in'）不得本地验收/打回。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, updateTask } from '../../src/main/storage/tasks/repo';
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
  });
  // delegation_role 不在 insertTask 列集（生产由 dispatch-submit 回执补戳）
  if (role !== null) updateTask(t.id, { delegationRole: role, delegationId: 'dl-1' });
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
