// task:continue IPC 契约（spec 2026-11-18 DEC-16）：
// 本地任务直接写；委派任务远端先行（失败零本地写入）；成功回读 TaskRow。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface IpcHandler { (event: unknown, ...args: unknown[]): Promise<unknown> | unknown }
const handlers = vi.hoisted(() => new Map<string, IpcHandler>());
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: IpcHandler): void => { handlers.set(channel, fn); } },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, updateTask } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { listRuns } from '../../src/main/storage/tasks/runs-repo';
import { startRun, submitRun } from '../../src/main/task/lifecycle-runs';
import {
  registerTaskHandlers, setContinueForwarder, continueTaskRouted,
  type ContinueForwardInput,
} from '../../src/main/task/ipc.handlers';

const DELEGATION_ID = 'dl-cont-1';
const tmpRoot = path.join(os.tmpdir(), `ap-continue-ipc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const forwarderMock = vi.fn<(input: ContinueForwardInput) => Promise<void>>();
let sessionId = '';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb().prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  sessionId = insertSession({ workspaceId: 'ws1', title: 's', kind: 'chat' }).id;
  forwarderMock.mockReset().mockResolvedValue(undefined);
  setContinueForwarder(forwarderMock);
  handlers.clear();
  registerTaskHandlers();
});
afterEach(() => {
  setContinueForwarder(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

async function submittedTask(role: 'out' | null): Promise<string> {
  const t = insertTask({
    workspaceId: 'ws1', title: 'T', creatorUserId: '@owner:home',
    assigneeAgentId: 'inst-1', status: 'assigned', executionSessionId: sessionId,
  });
  // delegation_role 不在 insertTask 列集（生产由 dispatch-submit 回执补戳）
  if (role === 'out') updateTask(t.id, { delegationRole: 'out', delegationId: DELEGATION_ID });
  startRun(t.id, { trigger: 'initial' });
  await submitRun(t.id, { summary: 'x' });
  return t.id;
}

describe('task:continue', () => {
  it('本地任务：直接续作，不走 forwarder', async () => {
    const id = await submittedTask(null);
    await continueTaskRouted(id, '按主题一写正文');
    expect(forwarderMock).not.toHaveBeenCalled();
    expect(getTask(id)!.status).toBe('in_progress');
    expect(listRuns(id)).toHaveLength(2);
  });

  it('委派任务：先远端后本地，转发载荷 {delegationId, requirement}', async () => {
    const id = await submittedTask('out');
    await continueTaskRouted(id, '按主题一写正文');
    expect(forwarderMock).toHaveBeenCalledWith({ delegationId: DELEGATION_ID, requirement: '按主题一写正文' });
    expect(listRuns(id)).toHaveLength(2);
  });

  it('远端失败 → 人话抛且本地零写入（卡片保持待裁决）', async () => {
    const id = await submittedTask('out');
    forwarderMock.mockRejectedValueOnce(new Error('[peer_version_unsupported] 执行节点协议版本不足'));
    await expect(continueTaskRouted(id, '继续')).rejects.toThrow('执行节点版本不支持继续，可改用完成或驳回');
    expect(getTask(id)!.status).toBe('submitted');
    expect(listRuns(id)).toHaveLength(1);
  });

  it('IPC 通道注册 + 空白要求人话拒', async () => {
    const handler = handlers.get('task:continue')!;
    expect(handler).toBeTruthy();
    const id = await submittedTask(null);
    await expect(handler({}, id, '  ')).rejects.toThrow('继续要求需 1-4000 字');
  });
});
