// electron/tests/ipc/auth-handlers-restore.test.ts
//
// v1.5.8 auth handlers 测试：login/register 成功后调 startSyncFromSession +
// autoStartAgents + broadcastRuntimeChanged（失败隔离语义）。
//
// 策略：mock 模块依赖（sync-manager / auto-start / authFlows），mock electron
// 捕获 ipcMain.handle 注册的回调，直接调用回调验证行为。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AuthDeps } from '../../src/main/ipc/authFlows';

// hoisted 状态容器
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const mocks = vi.hoisted(() => ({
  startSyncFromSession: vi.fn().mockResolvedValue(undefined),
  broadcastRuntimeChanged: vi.fn(),
  autoStartAgents: vi.fn().mockResolvedValue(undefined),
  registerFlow: vi.fn().mockResolvedValue({ userId: '@a:localhost', deviceId: 'D' }),
  loginFlow: vi.fn().mockResolvedValue({ userId: '@a:localhost', deviceId: 'D' }),
  logoutFlow: vi.fn().mockResolvedValue(undefined),
  getCurrentUserFlow: vi.fn().mockResolvedValue(null),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

vi.mock('../../src/main/matrix/sync-manager', () => ({
  startSyncFromSession: mocks.startSyncFromSession,
  broadcastRuntimeChanged: mocks.broadcastRuntimeChanged,
  stopSync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/main/agent/auto-start', () => ({
  autoStartAgents: mocks.autoStartAgents,
}));

vi.mock('../../src/main/ipc/authFlows', () => ({
  registerFlow: mocks.registerFlow,
  loginFlow: mocks.loginFlow,
  logoutFlow: mocks.logoutFlow,
  getCurrentUserFlow: mocks.getCurrentUserFlow,
}));

// 其他 transitive 依赖（auth.handlers 顶部 import 链）
vi.mock('../../src/main/conduit/manager', () => ({
  startConduit: vi.fn().mockResolvedValue({ port: 8008, baseUrl: 'http://127.0.0.1:8008' }),
}));
vi.mock('../../src/main/matrix/client', () => ({
  createMatrixClient: vi.fn().mockReturnValue({}),
}));
vi.mock('../../src/main/storage/keychain', () => ({
  setSecret: vi.fn().mockResolvedValue(undefined),
  getSecret: vi.fn().mockResolvedValue(null),
  deleteSecret: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/main/storage/db', () => ({
  getDb: vi.fn(),
}));

let registerAuthHandlers: () => void;

beforeEach(async () => {
  handlers.clear();
  mocks.startSyncFromSession.mockClear();
  mocks.broadcastRuntimeChanged.mockClear();
  mocks.autoStartAgents.mockClear();
  mocks.registerFlow.mockClear();
  mocks.loginFlow.mockClear();
  mocks.startSyncFromSession.mockResolvedValue(undefined);
  mocks.autoStartAgents.mockResolvedValue(undefined);

  const mod = await import('../../src/main/ipc/auth.handlers');
  registerAuthHandlers = mod.registerAuthHandlers;
  registerAuthHandlers();
});

describe('auth handlers: 登录后恢复 sync + 自启动 agent', () => {
  it('auth:login 成功后调用 startSyncFromSession → autoStartAgents → broadcastRuntimeChanged', async () => {
    const handler = handlers.get('auth:login')!;
    await handler({}, { username: 'a', password: 'p' });

    expect(mocks.loginFlow).toHaveBeenCalled();
    expect(mocks.startSyncFromSession).toHaveBeenCalledTimes(1);
    expect(mocks.autoStartAgents).toHaveBeenCalledTimes(1);
    expect(mocks.broadcastRuntimeChanged).toHaveBeenCalledTimes(1);
  });

  it('auth:register 成功后同样调用恢复流程', async () => {
    const handler = handlers.get('auth:register')!;
    await handler({}, { username: 'a', password: 'p' });

    expect(mocks.registerFlow).toHaveBeenCalled();
    expect(mocks.startSyncFromSession).toHaveBeenCalledTimes(1);
    expect(mocks.autoStartAgents).toHaveBeenCalledTimes(1);
    expect(mocks.broadcastRuntimeChanged).toHaveBeenCalledTimes(1);
  });

  it('startSyncFromSession 失败不阻塞 autoStartAgents', async () => {
    mocks.startSyncFromSession.mockRejectedValueOnce(new Error('sync failed'));

    const handler = handlers.get('auth:login')!;
    await handler({}, { username: 'a', password: 'p' });

    expect(mocks.autoStartAgents).toHaveBeenCalledTimes(1);
    expect(mocks.broadcastRuntimeChanged).toHaveBeenCalledTimes(1);
  });

  it('autoStartAgents 失败不阻塞 broadcastRuntimeChanged', async () => {
    mocks.autoStartAgents.mockRejectedValueOnce(new Error('auto-start failed'));

    const handler = handlers.get('auth:login')!;
    await handler({}, { username: 'a', password: 'p' });

    expect(mocks.broadcastRuntimeChanged).toHaveBeenCalledTimes(1);
  });

  it('auth:logout 不触发恢复流程', async () => {
    const handler = handlers.get('auth:logout')!;
    await handler({});

    expect(mocks.startSyncFromSession).not.toHaveBeenCalled();
    expect(mocks.autoStartAgents).not.toHaveBeenCalled();
  });
});

// AuthDeps 占位（authFlows 被全 mock 后类型仍然需要存在用于编译）
void (null as unknown as AuthDeps);
