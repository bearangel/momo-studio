// electron/tests/task/runtime-init.test.ts
//
// 运行时装配测试：initTaskRuntime 同时启动 scheduler + executor（Task 5 接线）。
// - 既有用例（I1 骨架）：scheduler 创建/启动/幂等/重复 init 安全。
// - 新增用例：boot 装配后 executor 在位——assigned 任务在 initTaskRuntime
//   即被放行（kickoff 由测试注入，验证 runtime-init 的依赖注入缝）。
//
// DB 隔离沿用 Task 4 executor.test.ts 的 beforeEach 模式（tmpdir + 真实
// migrations）；不再模块级 mock storage/db——新用例需要真实任务行与状态机。
//
// mock 收窄（momo-test-rules）：只 mock 进程/网络边界——electron（import 图
// 经 executor → starter → agent 域触达 stream-relay 的运行时 electron import）
// 与 p2p 门面（session-service → ../p2p 的网络栈）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));
vi.mock('../../src/main/p2p', () => ({
  broadcastLocalMessage: vi.fn(),
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask } from '../../src/main/storage/tasks/repo';
import { initTaskRuntime, stopTaskRuntime } from '../../src/main/task/runtime-init';

const tmpRoot = path.join(os.tmpdir(), `ap-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  vi.useFakeTimers();
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/tmp', '@o')`)
    .run();
});

afterEach(() => {
  stopTaskRuntime();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** agent 目标合法 seed（与 executor.test.ts 同款，按现行 DDL 补 NOT NULL 列）：
 *  agent_definitions NOT NULL：id/slug/name/version/system_prompt/model_name；
 *  workspace_agent_members NOT NULL：instance_id/workspace_id/agent_definition_id/agent_user_id。 */
function seedAgentMember(instanceId: string): void {
  getDb()
    .prepare(
      `INSERT INTO agent_definitions (id, slug, name, version, system_prompt, model_name) VALUES ('def1', 'c', 'C', '1', 'p', 'm')`,
    )
    .run();
  getDb()
    .prepare(
      `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id) VALUES (?, 'ws1', 'def1', ?)`,
    )
    .run(instanceId, `@${instanceId}:s`);
}

describe('initTaskRuntime', () => {
  it('创建并启动 TaskScheduler（不抛错）', () => {
    expect(() => initTaskRuntime()).not.toThrow();
  });

  it('scheduler 启动后定时触发 checkOnce（pending→assigned 提升）', () => {
    initTaskRuntime({ intervalMs: 1000 });

    // 快进 2 秒 → checkOnce 应被触发至少 1 次（空任务表，不抛错）
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
  });

  it('stopTaskRuntime 幂等（未 init 时调用不抛错）', () => {
    expect(() => stopTaskRuntime()).not.toThrow();
  });

  it('重复 initTaskRuntime 安全（不叠加定时器）', () => {
    initTaskRuntime({ intervalMs: 1000 });
    expect(() => initTaskRuntime({ intervalMs: 1000 })).not.toThrow();
    stopTaskRuntime();
  });

  it('initTaskRuntime 后 executor 在位：assigned 任务在 boot 即被放行', async () => {
    // vi.waitFor 依赖真实计时轮询；executor notify 去抖（100ms）也走真实时钟
    vi.useRealTimers();
    seedAgentMember('inst1');
    insertTask({ workspaceId: 'ws1', title: 'boot', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'assigned' });

    const kickoffs: Array<{ sessionId: string }> = [];
    initTaskRuntime({
      kickoff: async (input) => {
        kickoffs.push(input);
      },
    });
    await vi.waitFor(() => expect(getTask('T-001')!.status).toBe('in_progress'));
    expect(kickoffs).toHaveLength(1);
    stopTaskRuntime();
  });
});
