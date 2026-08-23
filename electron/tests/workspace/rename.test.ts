// electron/tests/workspace/rename.test.ts
//
// workspace:rename / workspace:openDirectory 通道单测（P2 Task 2）。
//
// 捕获方式：mock electron.ipcMain.handle，把通道回调存入 Map，测试直接调用
// 捕获的回调——验证的是真实生产 handler（与 set-coordinator-restart.test.ts 同一约定）。
// rename 走真实 SQLite（storage/db + workspace/crud）；openDirectory mock electron
// shell（openPath 失败语义：返回非空错误字符串而非 reject）。
// runtime 相关模块照既有模式 mock，避免真实子进程依赖。

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { createWorkspace, getWorkspace } from '../../src/main/workspace/crud';

// 捕获 ipcMain.handle 注册的回调（vi.hoisted 保证在 vi.mock 工厂提升前就绪）
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const { openPathMock } = vi.hoisted(() => ({ openPathMock: vi.fn() }));

// mock electron：捕获 handle 注册 + 替换 shell.openPath
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  shell: {
    openPath: openPathMock,
  },
}));

vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  startAgentRuntime: vi.fn(),
  stopAgentRuntime: vi.fn(),
}));
vi.mock('../../src/main/workspace/allocation', () => ({
  getAllocation: vi.fn(() => ({ workspaceId: '', tools: [], skills: [], mcps: [] })),
}));

const tmpRoot = path.join(os.tmpdir(), `ap-ws-rename-${Date.now()}-${process.pid}`);
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) {
    memStore.set(k, v);
  },
  async getSecret(k) {
    return memStore.get(k) ?? null;
  },
  async deleteSecret(k) {
    memStore.delete(k);
  },
};

beforeAll(async () => {
  const mod = await import('../../src/main/workspace/ipc.handlers');
  mod.registerWorkspaceHandlers();
});

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();
  openPathMock.mockReset();
  openPathMock.mockResolvedValue('');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

describe('workspace:rename', () => {
  it('更新 name 列并返回 { ok: true }', async () => {
    const ws = await createWorkspace(
      { name: '旧名', directoryPath: path.join(tmpRoot, 'ws-r1') },
      '@o:localhost',
    );
    const handler = handlers.get('workspace:rename')!;

    const result = await handler({}, ws.id, '新名');

    expect(result).toEqual({ ok: true });
    expect(getWorkspace(ws.id)?.name).toBe('新名');
  });

  it('workspace 不存在时抛错', async () => {
    const handler = handlers.get('workspace:rename')!;

    await expect(handler({}, 'nonexistent', 'x')).rejects.toThrow('Workspace 不存在');
  });
});

describe('workspace:openDirectory', () => {
  it('调 shell.openPath 打开 workspace 目录并返回 { ok: true }', async () => {
    const ws = await createWorkspace(
      { name: 'w', directoryPath: path.join(tmpRoot, 'ws-o1') },
      '@o:localhost',
    );
    const handler = handlers.get('workspace:openDirectory')!;

    const result = await handler({}, ws.id);

    expect(openPathMock).toHaveBeenCalledWith(ws.directoryPath);
    expect(result).toEqual({ ok: true });
  });

  it('openPath 返回非空错误字符串时抛错（renderer alert 用）', async () => {
    const ws = await createWorkspace(
      { name: 'w', directoryPath: path.join(tmpRoot, 'ws-o2') },
      '@o:localhost',
    );
    openPathMock.mockResolvedValue('No such directory');
    const handler = handlers.get('workspace:openDirectory')!;

    await expect(handler({}, ws.id)).rejects.toThrow('打开目录失败: No such directory');
  });

  it('workspace 不存在时抛错', async () => {
    const handler = handlers.get('workspace:openDirectory')!;

    await expect(handler({}, 'nonexistent')).rejects.toThrow('Workspace 不存在');
  });
});
