// tests/workspace/switch-notify.test.ts
//
// workspace:switch 通道测试（v2.7 McpBrowser Task 10）。
//
// 捕获方式：mock electron.ipcMain.handle 存入 Map，直调真实生产 handler
// （set-coordinator-restart.test.ts 同款约定）。回调 onWorkspaceSwitched 用 spy
// 注入——锁「拿 wsId + directoryPath 调回调」与「ws 不存在抛错」两分支。
// 其余走真实：真 SQLite + 真 workspace/crud.getWorkspace。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { registerWorkspaceHandlers } from '../../src/main/workspace/ipc.handlers';

const tmpRoot = path.join(os.tmpdir(), `ap-ws-switch-${Date.now()}-${process.pid}`);
const onSwitched = vi.fn();

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb().prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES ('ws-1', 'WS', '', '/tmp/ws-dir-1', 0, '@owner:s', '📁')`,
  ).run();
  handlers.clear();
  onSwitched.mockClear();
  registerWorkspaceHandlers({ onWorkspaceSwitched: onSwitched });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('workspace:switch handler', () => {
  it('存在的 ws → 以 (wsId, directoryPath) 调注入回调', async () => {
    const handler = handlers.get('workspace:switch');
    expect(handler).toBeTypeOf('function');
    const res = (await handler?.({} as never, 'ws-1')) as { ok: boolean };
    expect(res).toEqual({ ok: true });
    expect(onSwitched).toHaveBeenCalledTimes(1);
    expect(onSwitched).toHaveBeenCalledWith('ws-1', '/tmp/ws-dir-1');
  });

  it('ws 不存在 → 抛中文错误且回调零调用', () => {
    const handler = handlers.get('workspace:switch');
    // handler 是同步函数：Electron 会把 throw 转为 renderer 侧 rejected promise
    expect(() => handler?.({} as never, 'ws-404')).toThrow(/不存在/);
    expect(onSwitched).not.toHaveBeenCalled();
  });

  it('未注入回调时 no-op 不抛错（注册面默认形态）', () => {
    handlers.clear();
    registerWorkspaceHandlers();
    const handler = handlers.get('workspace:switch');
    expect(handler?.({} as never, 'ws-1')).toEqual({ ok: true });
  });
});
