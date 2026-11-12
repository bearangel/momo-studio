// electron/tests/agent/resource-ops-restart.test.ts
//
// restart 语义双面测试（spec §8）：本 Task 覆盖 respawn-on-idle 机制；Task 5 扩 op 三行场景。
// 沿 resource-ops.test.ts 夹具；mock 打在运行时边界（start-chain——respawn 拉起通道）。
//
// 断言口径（momo-test-rules）：不 spy 模块命名空间上的 stopAgentRuntime——vite SSR
// 变换下模块内直调走局部绑定，命名空间 spy 拦不到；改用两条真实可观测证据：
//   1. stop 真实发生 = stopAgentRuntime 的 DB 效应（last_running 1→0，schema 默认 1）
//   2. 拉起通道命中 = start-chain 边界 mock（ensureMemberRuntime）的调用记录
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

// 与 resource-ops.test.ts 同款：Task 5 本文件将扩 resource-ops op 侧（crud 引
// runtime-status），registry 侧用例虽不经此依赖，先同款 mock 保两测试面同底座。
vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(() => false),
}));

const tmpRoot = path.join(os.tmpdir(), `ap-restart-${Date.now()}`);
let wsId = '';
let m1 = '';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES ('ws-x', 'w', '', '/tmp', 0, '@o:s', '📁')`,
  ).run();
  db.prepare(
    `INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name)
     VALUES ('def-1', '一', 'agent-1', '1', 'p', 'm')`,
  ).run();
  // instance_id 是 TEXT 主键（UUID 语义）——显式给值，不用 lastInsertRowid（rowid ≠ instance_id）。
  // last_running 走 schema 默认 1——respawn 断言的起点电平。
  db.prepare(
    `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
     VALUES ('mem-1', 'ws-x', 'def-1', '@a:1')`,
  ).run();
  wsId = 'ws-x';
  m1 = 'mem-1';
});

afterEach(async () => {
  // 用例内 vi.resetModules 后模块注册表持有全新 db 模块实例（第二条连接）——
  // 两份都要关，防句柄泄漏（动态 import 命中 reset 后的全新图，与顶层静态实例不同源）
  const freshDb = await import('../../src/main/storage/db');
  freshDb.closeDb();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 读成员 last_running 电平（stopAgentRuntime 翻 0 是其真实可观测效应） */
function lastRunningOf(instanceId: string): number {
  const row = getDb()
    .prepare('SELECT last_running FROM workspace_agent_members WHERE instance_id = ?')
    .get(instanceId) as { last_running: number } | undefined;
  return Number(row?.last_running ?? -1);
}

describe('respawn-on-idle（runtime-registry）', () => {
  it('requestRespawnAfterIdle 幂等登记；idle 边沿触发 stop + 拉起（且仅一次）', async () => {
    vi.resetModules();
    const ensure = vi.fn();
    vi.doMock('../../src/main/agent/start-chain', () => ({ ensureMemberRuntime: ensure }));
    const reg = await import('../../src/main/agent/runtime-registry');

    reg.requestRespawnAfterIdle(m1);
    reg.requestRespawnAfterIdle(m1); // 幂等：Set 去重，双登记只换来一次 respawn
    await reg.__drainRespawnQueueForTest();

    // 拉起通道命中：drainRespawnQueue 动态 import 到的是 start-chain mock
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith(m1);
    // stop 真实发生：stopAgentRuntime 的 DB 效应 last_running 1→0
    expect(lastRunningOf(m1)).toBe(0);

    // pending 已清：再次 idle 电平（重复 drain）不得二次 respawn
    await reg.__drainRespawnQueueForTest();
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('stopAgentRuntime 清除 pending 标记（防 stop→idle→重复 respawn）', async () => {
    vi.resetModules();
    const ensure = vi.fn();
    vi.doMock('../../src/main/agent/start-chain', () => ({ ensureMemberRuntime: ensure }));
    const reg = await import('../../src/main/agent/runtime-registry');

    reg.requestRespawnAfterIdle(m1);
    await reg.stopAgentRuntime(m1); // 手动停止：函数体首行清 pending 标记
    await reg.__drainRespawnQueueForTest();

    // 标记已被 stop 清掉：idle 电平不再触发拉起（成员保持停止态，下次派发自然拉起）
    expect(ensure).not.toHaveBeenCalled();
    expect(lastRunningOf(m1)).toBe(0);
  });
});
