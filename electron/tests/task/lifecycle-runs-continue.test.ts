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
    expect(runs[0]!.status).toBe('accepted');
    expect(runs[0]!.endedAt).not.toBeNull();
    expect(runs[1]!.runNo).toBe(2);
    expect(runs[1]!.trigger).toBe('continue');
    expect(runs[1]!.status).toBe('running');
    expect(getTask(id)!.status).toBe('in_progress');
    expect(getActiveRun(id)!.id).toBe(runs[1]!.id);
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

  it('continue 不产生 rejected run（返工配额不受影响）', async () => {
    const id = seedSubmitted();
    await submitRun(id, { summary: 'x' });
    acceptAndContinue(id, '继续');
    expect(listRuns(id).filter((r) => r.status === 'rejected')).toHaveLength(0);
  });
});
