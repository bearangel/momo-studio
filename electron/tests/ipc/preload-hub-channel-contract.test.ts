// electron/tests/ipc/preload-hub-channel-contract.test.ts
//
// hub:installProgress 通道名跨进程契约锁（M2.3 T5 件5）。
//
// 架构约束：preload 运行于 sandbox（window.ts sandbox: true）——不可运行时导入
// 主进程模块，通道常量只能 preload 本地承载（preload/index.ts
// HUB_INSTALL_PROGRESS_CHANNEL）。本测试两侧真实导入机械比对：preload 经
// mock-electron 捕获 ipcRenderer.on/off 实际注册的通道名，主进程侧直接导入
// resource/hub-install.ts 的 HUB_INSTALL_PROGRESS_CHANNEL——任何一端单独改值即红
//（改通道名须两端同 commit，双侧 JSDoc 均指向本测试）。两侧均走动态导入：
// vi.mock 工厂被提升，静态导入主进程链会在 mock fn 初始化前触发 factory（TDZ）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ipcRendererOn, ipcRendererOff, exposeInMainWorld } = vi.hoisted(() => ({
  ipcRendererOn: vi.fn(),
  ipcRendererOff: vi.fn(),
  exposeInMainWorld: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: {
    on: ipcRendererOn,
    off: ipcRendererOff,
    invoke: vi.fn().mockResolvedValue(undefined),
  },
}));

interface ExposedHubApi {
  onInstallProgress: (cb: (payload: unknown) => void) => () => void;
}

function getHubApi(): ExposedHubApi {
  expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
  const [, api] = exposeInMainWorld.mock.calls[0] as [string, { hub: ExposedHubApi }];
  return api.hub;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('hub:installProgress 通道名跨进程契约（T5 件5）', () => {
  it('preload 订阅/退订通道 === 主进程 HUB_INSTALL_PROGRESS_CHANNEL（单点对齐机械锁）', async () => {
    const { HUB_INSTALL_PROGRESS_CHANNEL } = await import('../../src/main/resource/hub-install');
    await import('../../src/preload/index');
    const hub = getHubApi();
    const dispose = hub.onInstallProgress(vi.fn());

    // 比对基准来自主进程真实导出（而非测试内复写字面量）
    expect(ipcRendererOn).toHaveBeenCalledWith(HUB_INSTALL_PROGRESS_CHANNEL, expect.any(Function));

    dispose();
    expect(ipcRendererOff).toHaveBeenCalledWith(HUB_INSTALL_PROGRESS_CHANNEL, expect.any(Function));
  });

  it('订阅回调链路分发 HubInstallProgressEvent 载荷（通道接线不只名字）', async () => {
    const { HUB_INSTALL_PROGRESS_CHANNEL } = await import('../../src/main/resource/hub-install');
    await import('../../src/preload/index');
    const hub = getHubApi();
    const cb = vi.fn();
    hub.onInstallProgress(cb);

    const handler = ipcRendererOn.mock.calls.find(
      (c) => c[0] === HUB_INSTALL_PROGRESS_CHANNEL,
    )?.[1] as ((_e: unknown, payload: unknown) => void) | undefined;
    expect(handler).toBeDefined();
    const payload = { stage: 'downloading', type: 'plugin', slug: 'big-tool', receivedBytes: 512 * 1024 };
    handler?.({}, payload);
    expect(cb).toHaveBeenCalledWith(payload);
  });
});
