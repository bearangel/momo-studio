// hub IPC 面接线锁：通道注册与 payload 透传（manager 逻辑在 client.test 已锁，这里只锁接线）。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../src/main/hub/index', () => ({
  initHub: vi.fn(),
  stopHub: vi.fn(),
  hubGetStatus: vi.fn(() => ({ configured: false, state: 'disconnected', hubUrl: null, nodeName: null, nodeId: null, lastError: null })),
  hubConfigure: vi.fn(async (input: { hubUrl: string }) => ({ configured: true, state: 'connecting', hubUrl: input.hubUrl, nodeName: 'a', nodeId: null, lastError: null })),
  hubEnroll: vi.fn(async () => ({ configured: true, state: 'connecting', hubUrl: 'http://h', nodeName: 'a', nodeId: 'n1', lastError: null })),
  hubForget: vi.fn(async () => undefined),
  replayPresenceSeed: vi.fn(),
}));

// publishToHub 只锁接线（透传入参）——打包/上传矩阵在 publish.test.ts
vi.mock('../../src/main/hub/publish', () => ({
  publishToHub: vi.fn(async (input: { type: string; ref: string }) => ({ slug: input.ref, version: '1.0.0', checksum: 'c', sizeBytes: 1 })),
}));

import { registerHubIpc } from '../../src/main/hub/ipc.handlers';
import * as manager from '../../src/main/hub/index';
import { publishToHub } from '../../src/main/hub/publish';

beforeEach(() => { handlers.clear(); vi.clearAllMocks(); });

describe('hub IPC 接线', () => {
  it('注册五通道；getStatus 透传 manager', async () => {
    registerHubIpc();
    expect([...handlers.keys()].sort()).toEqual(['hub:configure', 'hub:enroll', 'hub:forget', 'hub:getStatus', 'hub:publishResource']);
    expect(await handlers.get('hub:getStatus')!()).toEqual(await manager.hubGetStatus());
  });

  it('configure/enroll 透传参数', async () => {
    registerHubIpc();
    await handlers.get('hub:configure')!(null, { hubUrl: 'http://h', nodeName: 'a' });
    expect(manager.hubConfigure).toHaveBeenCalledWith({ hubUrl: 'http://h', nodeName: 'a' });
    await handlers.get('hub:enroll')!(null, { hubUrl: 'http://h', enrollmentToken: 't', nodeName: 'a' });
    expect(manager.hubEnroll).toHaveBeenCalledWith({ hubUrl: 'http://h', enrollmentToken: 't', nodeName: 'a' });
  });

  it('forget 透传', async () => {
    registerHubIpc();
    await handlers.get('hub:forget')!();
    expect(manager.hubForget).toHaveBeenCalledTimes(1);
  });

  it('getStatus → 顺带重播在线节点种子（面板挂载晚于 hello 的补齐面）', async () => {
    registerHubIpc();
    await handlers.get('hub:getStatus')!();
    expect(manager.replayPresenceSeed).toHaveBeenCalledTimes(1);
  });

  it('publishResource 透传 publishToHub（入参原样 + 回执透传）', async () => {
    registerHubIpc();
    const out = await handlers.get('hub:publishResource')!(null, { type: 'skill', ref: 's1', meta: { name: 'N' } });
    expect(publishToHub).toHaveBeenCalledWith({ type: 'skill', ref: 's1', meta: { name: 'N' } });
    expect(out).toEqual({ slug: 's1', version: '1.0.0', checksum: 'c', sizeBytes: 1 });
  });
});
