// electron/tests/agent/stop-task-pause.test.ts
//
// K7-1 回归锁：用户停止 agent（agent:stop / stopAgentRuntime）时，该 agent
// 名下 in_progress 的任务必须转 paused。
//
// 根因（P0）：destroy() 先清空 activeTasks 再 kill 子进程，之后 exit 事件
// 到达时 handleChildExit 双重不可达（活跃表已清 + runner 已从 agentRunners
// Map 删除）——failTaskOnCrash 永不执行，任务永远卡 in_progress（看板显示
// 「进行中」但无任何 runtime 在跑）。
//
// 语义裁定：转 paused（而非 failed/cancelled）——用户停的是 agent 不是任务，
// 任务保留价值，可通过「恢复」重启执行链。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, transitionTaskStatus, getTask } from '../../src/main/storage/tasks/repo';

const { stopAgentRuntime } = await import('../../src/main/agent/runtime-registry');

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-stop-pause-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`,
    )
    .run('ws1', 'Test', '/tmp', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function seedAgentMember(instanceId: string): void {
  getDb()
    .prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, source, model_name, icon_emoji)
       VALUES (?, 'Worker', ?, '1', 'declarative', 'p', '[]', 'custom', 'm', '🤖')`,
    )
    .run(`def-${instanceId}`, `slug-${instanceId}`);
  getDb()
    .prepare(
      `INSERT INTO workspace_agent_members
         (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
       VALUES (?, 'ws1', ?, ?, 0)`,
    )
    .run(instanceId, `def-${instanceId}`, `@${instanceId}:s`);
}

function seedInProgressTask(title: string, assignee: string | null): string {
  const t = insertTask({
    workspaceId: 'ws1',
    title,
    creatorUserId: '@owner:home',
    assigneeAgentId: assignee,
  });
  transitionTaskStatus(t.id, 'assigned');
  transitionTaskStatus(t.id, 'in_progress');
  return t.id;
}

describe('K7-1: stopAgentRuntime → in_progress 任务转 paused', () => {
  it('该 agent 的 in_progress 任务转 paused（带原因）', async () => {
    seedAgentMember('inst-a');
    const taskId = seedInProgressTask('T-k7a', 'inst-a');

    await stopAgentRuntime('inst-a');

    const row = getTask(taskId)!;
    expect(row.status).toBe('paused');
    expect(row.errorMessage).toContain('agent 运行已被用户停止');
  });

  it('其他 agent 的 in_progress 任务不受影响', async () => {
    seedAgentMember('inst-a');
    seedAgentMember('inst-b');
    const otherTask = seedInProgressTask('T-k7b', 'inst-b');

    await stopAgentRuntime('inst-a');

    expect(getTask(otherTask)!.status).toBe('in_progress');
  });

  it('非 in_progress 状态（assigned/pending）不动', async () => {
    seedAgentMember('inst-a');
    const t = insertTask({
      workspaceId: 'ws1',
      title: 'T-k7c',
      creatorUserId: '@owner:home',
      assigneeAgentId: 'inst-a',
      status: 'assigned',
    });

    await stopAgentRuntime('inst-a');

    expect(getTask(t.id)!.status).toBe('assigned');
  });

  it('无 runner / 无任务的 agent 停止是安全 no-op', async () => {
    seedAgentMember('inst-empty');
    await expect(stopAgentRuntime('inst-empty')).resolves.toBeUndefined();
  });
});
