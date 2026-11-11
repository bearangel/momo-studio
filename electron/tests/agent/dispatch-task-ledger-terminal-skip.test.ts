// electron/tests/agent/dispatch-task-ledger-terminal-skip.test.ts
//
// 账本 settle 非法转换预检回归锁（2026-11-11 会话停止竞速实录）：
// abortTurn 的 cancel 投影先行落 cancelled，子进程退出前的 failed settle
// 迟到 → transitionTaskStatus(cancelled → failed) 被状态机拒绝 → 生产日志
// 「dispatch 账本 settle 投影失败（cancelled → failed）」噪声（虽有 catch
// 不影响运行链，但掩盖真实投影失败）。契约：迟到钩子遇非法转换 → 记
// info 跳过（先落的权威终态不被覆盖），正常转换路径不受影响。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../src/main/memory/extraction', () => ({
  scheduleExtraction: vi.fn(),
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { getTask, insertTask, transitionTaskStatus } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { ledgerCancelDispatch, ledgerFailDispatch, ledgerSettleDispatch } from '../../src/main/agent/dispatch-task-ledger';
import { logger } from '../../src/main/logger';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-ledger-terminal-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

let sessionId = '';
let warnSpy: ReturnType<typeof vi.spyOn>;

function setupDb(): void {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`,
  ).run();
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
        default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
     VALUES ('inst-sub', 'sub', 'sub', '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', 'm', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
     VALUES ('inst-sub', 'ws', 'inst-sub', 'agent-sub')`,
  ).run();
  sessionId = insertSession({ workspaceId: 'ws', title: '协作', kind: 'chat' }).id;
}

function seedDispatchTask(id: string): void {
  insertTask({
    id,
    origin: 'dispatch',
    workspaceId: 'ws',
    title: '子任务',
    status: 'in_progress',
    creatorUserId: 'agent:inst-pm',
    assigneeAgentId: 'inst-sub',
    executionSessionId: sessionId,
    sourceSessionId: sessionId,
    startedAt: Date.now(),
  });
}

beforeEach(() => {
  setupDb();
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('ledgerSettleDispatch 非法转换预检（迟到钩子不覆盖权威终态）', () => {
  it('cancelled 行 + 迟到 failed settle → 保持 cancelled + 无 warn（生产竞速场景）', () => {
    seedDispatchTask('tk-cancel');
    transitionTaskStatus('tk-cancel', 'cancelled', { completedAt: Date.now() });

    expect(() => ledgerSettleDispatch('tk-cancel', 'failed', '子进程中断')).not.toThrow();
    expect(getTask('tk-cancel')?.status).toBe('cancelled');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('completed 行 + 迟到 failed settle → 保持 completed + 无 warn', () => {
    seedDispatchTask('tk-done');
    transitionTaskStatus('tk-done', 'completed', { completedAt: Date.now() });

    expect(() => ledgerSettleDispatch('tk-done', 'failed', '迟到失败')).not.toThrow();
    expect(getTask('tk-done')?.status).toBe('completed');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('paused 行 + completed settle（paused→completed 非法）→ 保持 paused + 无 warn', () => {
    seedDispatchTask('tk-pause');
    transitionTaskStatus('tk-pause', 'paused');

    expect(() => ledgerSettleDispatch('tk-pause', 'completed', 'ok')).not.toThrow();
    expect(getTask('tk-pause')?.status).toBe('paused');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('同终态幂等：failed 行 + failed settle → 静默跳过（既有行为不回归）', () => {
    seedDispatchTask('tk-fail');
    transitionTaskStatus('tk-fail', 'failed', { errorMessage: 'x' });

    expect(() => ledgerSettleDispatch('tk-fail', 'failed', '重复失败')).not.toThrow();
    expect(getTask('tk-fail')?.status).toBe('failed');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('正常转换不受预检影响：in_progress + completed settle → 落 completed', () => {
    seedDispatchTask('tk-normal');

    expect(() => ledgerSettleDispatch('tk-normal', 'completed', 'ok')).not.toThrow();
    expect(getTask('tk-normal')?.status).toBe('completed');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('needs_input → paused 落态不受影响（in_progress + needs_input settle）', () => {
    seedDispatchTask('tk-input');

    expect(() => ledgerSettleDispatch('tk-input', 'needs_input', '等待输入')).not.toThrow();
    expect(getTask('tk-input')?.status).toBe('paused');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('ledgerCancelDispatch：completed 行 + 迟到取消 → 保持 completed + 无 warn', () => {
    seedDispatchTask('tk-c1');
    transitionTaskStatus('tk-c1', 'completed', { completedAt: Date.now() });

    expect(() => ledgerCancelDispatch('tk-c1')).not.toThrow();
    expect(getTask('tk-c1')?.status).toBe('completed');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('ledgerFailDispatch：cancelled 行 + 迟到判死 → 保持 cancelled + 无 warn', () => {
    seedDispatchTask('tk-f1');
    transitionTaskStatus('tk-f1', 'cancelled', { completedAt: Date.now() });

    expect(() => ledgerFailDispatch('tk-f1', '心跳死亡')).not.toThrow();
    expect(getTask('tk-f1')?.status).toBe('cancelled');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
