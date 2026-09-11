// electron/tests/browser/view-factory.test.ts
//
// view-factory 真实现的单测（v2.7 McpBrowser Task 10）。
//
// 本文件 import 的 SUT 依赖 'electron'（session / WebContentsView）——按仓库既有
// 模式（agent-start-stop.test.ts）vi.mock('electron') 提供结构性假件：
//   - WebContentsView：可实例化类，实例带 webContents（各方法 vi.fn）
//   - session.fromPartition：返回带 on / clearStorageData 的假 session
//
// 覆盖：DoD 17 真实现侧 setIgnoreMouseEvents（CDP Input.setIgnoreInputEvents +
// SmartDebugger 引用计数——穿透持有与 snapshot 懒附加共享会话）+ 视图挂载
// （setMountTarget → create addChildView / destroy removeChildView）+ partition 去重。

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface DbgMock {
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  sendCommand: ReturnType<typeof vi.fn>;
}
type WcMock = {
  close: ReturnType<typeof vi.fn>;
  debugger: DbgMock;
};

const createdViews: Array<{ partition: string; wc: WcMock; view: unknown }> = [];
const hookedPartitions: string[] = [];

vi.mock('electron', () => {
  class FakeWebContentsView {
    readonly webContents: WcMock;
    constructor(opts: { webPreferences: { session: { partitionTag: string } } }) {
      this.webContents = {
        partitionTag: opts.webPreferences.session.partitionTag,
        loadURL: vi.fn(async () => undefined),
        on: vi.fn(),
        executeJavaScript: vi.fn(async () => null),
        sendInputEvent: vi.fn(),
        capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('') })),
        setWindowOpenHandler: vi.fn(),
        reload: vi.fn(),
        getURL: vi.fn(() => 'about:blank'),
        getTitle: vi.fn(() => ''),
        close: vi.fn(),
        debugger: { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({})) },
      } as unknown as WcMock;
      createdViews.push({
        partition: opts.webPreferences.session.partitionTag,
        wc: this.webContents,
        view: this,
      });
    }
    setBounds(): void {}
  }
  return {
    WebContentsView: FakeWebContentsView,
    session: {
      fromPartition: (partition: string) => ({
        partitionTag: partition,
        on: (event: string) => {
          hookedPartitions.push(`${partition}:${event}`);
        },
        clearStorageData: vi.fn(async () => undefined),
      }),
    },
  };
});

vi.mock('../../src/main/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { initRealViewFactory } from '../../src/main/browser/view-factory';
import type { RealFactoryHooks } from '../../src/main/browser/view-factory';

const hooks: RealFactoryHooks = { pushNotice: vi.fn() };

beforeEach(() => {
  createdViews.length = 0;
  hookedPartitions.length = 0;
});

describe('initRealViewFactory', () => {
  it('create 使用 persist:browser-<wsId> partition + will-download 每 ws 仅挂一次', () => {
    const factory = initRealViewFactory(hooks);
    factory.create('ws-1');
    factory.create('ws-1');
    factory.create('ws-2');
    expect(createdViews.map((v) => v.partition)).toEqual([
      'persist:browser-ws-1',
      'persist:browser-ws-1',
      'persist:browser-ws-2',
    ]);
    // 3 个视图但 will-download 只挂 2 次（per-partition 去重）
    const downloads = hookedPartitions.filter((p) => p.endsWith(':will-download'));
    expect(downloads).toEqual(['persist:browser-ws-1:will-download', 'persist:browser-ws-2:will-download']);
  });

  it('setMountTarget：create → addChildView；destroy → removeChildView + close', () => {
    const factory = initRealViewFactory(hooks);
    const mount = { addChildView: vi.fn(), removeChildView: vi.fn() };
    factory.setMountTarget(mount);
    const v = factory.create('ws-1');
    expect(mount.addChildView).toHaveBeenCalledTimes(1);
    expect(mount.addChildView).toHaveBeenCalledWith(createdViews[0]!.view);
    factory.destroy(v);
    expect(mount.removeChildView).toHaveBeenCalledWith(createdViews[0]!.view);
    expect(createdViews[0]!.wc.close).toHaveBeenCalledTimes(1);
  });

  it('未设挂载目标时 create 不挂载（boot 窗口创建前的懒建视图安全）', () => {
    const factory = initRealViewFactory(hooks);
    factory.create('ws-1');
    // 无挂载目标分支——不抛错即通过
  });
});

describe('setIgnoreMouseEvents（DoD 17 真实现侧——CDP Input.setIgnoreInputEvents）', () => {
  it('agent 态（true）：attach 一次 + setIgnoreInputEvents {ignore:true}，会话保持', () => {
    const factory = initRealViewFactory(hooks);
    factory.create('ws-1');
    factory.create('ws-2');
    factory.setIgnoreMouseEvents('ws-1', true);
    const dbg1 = createdViews[0]!.wc.debugger;
    const dbg2 = createdViews[1]!.wc.debugger;
    expect(dbg1.attach).toHaveBeenCalledTimes(1);
    expect(dbg1.sendCommand).toHaveBeenCalledWith('Input.setIgnoreInputEvents', { ignore: true });
    expect(dbg2.attach).not.toHaveBeenCalled(); // 其他 ws 视图不动
    expect(dbg1.detach).not.toHaveBeenCalled(); // 持有期间不 detach（flag 随会话存活）
  });

  it('重复 agent 态调用幂等：不重复 attach（pushState 每次推送都会调）', () => {
    const factory = initRealViewFactory(hooks);
    factory.create('ws-1');
    factory.setIgnoreMouseEvents('ws-1', true);
    factory.setIgnoreMouseEvents('ws-1', true);
    expect(createdViews[0]!.wc.debugger.attach).toHaveBeenCalledTimes(1);
    expect(createdViews[0]!.wc.debugger.sendCommand).toHaveBeenCalledTimes(2);
  });

  it('user 态（false）：发 {ignore:false} 后解除持有（真 detach）', async () => {
    const factory = initRealViewFactory(hooks);
    factory.create('ws-1');
    factory.setIgnoreMouseEvents('ws-1', true);
    const dbg = createdViews[0]!.wc.debugger;
    factory.setIgnoreMouseEvents('ws-1', false);
    // releaseHold 在 sendCommand promise 之后——微任务冲刷后真 detach
    await new Promise((r) => setTimeout(r, 0));
    expect(dbg.sendCommand).toHaveBeenLastCalledWith('Input.setIgnoreInputEvents', { ignore: false });
    expect(dbg.detach).toHaveBeenCalledTimes(1);
  });

  it('穿透持有期间 snapshot 懒附加（公共 attach/detach）不真 detach（共享会话）', () => {
    const factory = initRealViewFactory(hooks);
    const v = factory.create('ws-1');
    factory.setIgnoreMouseEvents('ws-1', true);
    const dbg = createdViews[0]!.wc.debugger;
    const attachCallsBefore = dbg.attach.mock.calls.length;
    // 模拟 manager.snapshot 的懒附加序列（经 managed.webContents.debugger 公共面）
    v.webContents.debugger.attach('1.3');
    v.webContents.debugger.detach();
    expect(dbg.attach.mock.calls.length).toBe(attachCallsBefore); // 已附加——不重复真 attach
    expect(dbg.detach).not.toHaveBeenCalled(); // 持有期间公共 detach 不拆会话
  });

  it('无视图 ws no-op 不抛错', () => {
    const factory = initRealViewFactory(hooks);
    expect(() => factory.setIgnoreMouseEvents('ws-404', true)).not.toThrow();
  });
});
