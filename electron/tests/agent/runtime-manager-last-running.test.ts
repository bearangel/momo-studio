// electron/tests/agent/runtime-manager-last-running.test.ts
//
// v1.5.8 测试：spawnAgent 写 last_running=1；stopAgent 写 last_running=0；
// DB 写失败只 warn 不抛（验证降级路径）。
// 使用真实 SQLite（migration 已建 agent_assignments 表）+ fake-runtime 子进程入口。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  spawnAgent,
  stopAgent,
  stopAllAgents,
  setRuntimeEntryOverride,
  type AgentRuntimeOpts,
} from '../../src/main/agent/runtime-manager';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

const fakeRuntime = path.join(__dirname, 'fake-runtime.ts');
const tmpRoot = path.join(os.tmpdir(), `ap-rt-last-running-${Date.now()}`);

function makeOpts(instanceId: string, botUserId: string): AgentRuntimeOpts {
  return {
    instanceId,
    workspaceId: 'ws-1',
    workspaceDir: '/tmp',
    agentUserId: botUserId,
    agentAssignmentId: instanceId,
    systemPrompt: '',
    modelProvider: 'openai',
    modelName: 'gpt-4o',
    llmApiKey: 'key',
    teamSessionId: '!room:localhost',
  };
}

function insertAssignment(instanceId: string, botUserId: string, lastRunning: number): void {
  getDb()
    .prepare(
      `INSERT INTO agent_assignments
        (instance_id, workspace_id, agent_definition_id, agent_user_id, enabled, last_running, role)
       VALUES (?, 'ws-1', 'def-x', ?, 1, ?, 'standalone')`,
    )
    .run(instanceId, botUserId, lastRunning);
}

function seedFixtures(): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, team_session_id, git_initialized, owner_id, icon_emoji)
     VALUES ('ws-1', 'WS', '', '/tmp', '!s:localhost', 0, '@o:localhost', '📁')`,
  ).run();
  db.prepare(
    `INSERT INTO agent_definitions (id, name, slug, version, runtime, system_prompt, model_name, source)
     VALUES ('def-x', 'A', 'a', '1', 'declarative', 'p', 'gpt-4o', 'custom')`,
  ).run();
}

function readLastRunning(instanceId: string): number | undefined {
  const row = getDb()
    .prepare('SELECT last_running FROM agent_assignments WHERE instance_id = ?')
    .get(instanceId) as { last_running: number } | undefined;
  return row?.last_running;
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  seedFixtures();
  setRuntimeEntryOverride(['node', '--import', 'tsx', fakeRuntime]);
});

afterEach(() => {
  stopAllAgents();
  setRuntimeEntryOverride(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('runtime-manager: last_running 持久化', () => {
  it('spawnAgent 写 last_running=1', () => {
    insertAssignment('inst-up', '@bot.up:localhost', 0);
    expect(readLastRunning('inst-up')).toBe(0);

    spawnAgent(makeOpts('inst-up', '@bot.up:localhost'));

    expect(readLastRunning('inst-up')).toBe(1);
  });

  it('stopAgent 写 last_running=0', () => {
    insertAssignment('inst-down', '@bot.down:localhost', 1);
    spawnAgent(makeOpts('inst-down', '@bot.down:localhost'));
    expect(readLastRunning('inst-down')).toBe(1);

    stopAgent('inst-down');

    expect(readLastRunning('inst-down')).toBe(0);
  });

  it('DB 写失败（assignment 行不存在）不抛错', () => {
    // instance_id 不在 DB，UPDATE 影响 0 行但不抛——SQLite 不会因为 WHERE 无匹配报错
    expect(() => spawnAgent(makeOpts('no-such-row', '@bot.nobody:localhost'))).not.toThrow();
    expect(() => stopAgent('no-such-row-stopped')).not.toThrow();
  });

  it('手动下线后 last_running=0，再手动上线 last_running=1', () => {
    insertAssignment('inst-cycle', '@bot.cycle:localhost', 1);

    spawnAgent(makeOpts('inst-cycle', '@bot.cycle:localhost'));
    expect(readLastRunning('inst-cycle')).toBe(1);

    stopAgent('inst-cycle');
    expect(readLastRunning('inst-cycle')).toBe(0);

    spawnAgent(makeOpts('inst-cycle', '@bot.cycle:localhost'));
    expect(readLastRunning('inst-cycle')).toBe(1);
  });
});
