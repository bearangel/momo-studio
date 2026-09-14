// electron/tests/agent/tools/browser-takenover-wait.test.ts
//
// 工具层挂起锁回归矩阵（spec 2026-09-14 §6 用例 10「桥形态冒烟」+ M3 收尾）。
//
// 根因/本质：v2.0.0 起 agent 工具经 IPC 桥调用主进程 manager（BrowserTools→
// BrowserManager.gateAgentSide 链）。v2.7.0 接管等待特性把 manager.gateAgentSide
// 改为「user 态 park 至释放/空闲自愈/超时」——对子进程 IPC 桥是「invoke 挂久一点」，
// 工具层必须正确 await park Promise 而非立即 reject 或吞错。本测试锁工具层的 await
// 语义穿透：park 不立即拒绝、park resolve 后正常返回、立即抛错原文穿透。
//
// mock 纪律（momo-test-rules）：
//   - pending Promise 由测试受控（deferred 形态，resolve/reject 外置）——避免占位
//     id / 立即 resolve 让「挂起」断言失去意义
//   - 错误路径专项：manager 抛 BrowserTakenOverError 子类实例——验证工具层不包装、
//     不吞、不改文案（与 §6 用例 2/2b 文案诚实化契约一致）
//   - 断言覆盖：park 中（数微任务周期） / park resolve / 立即 fail / 其他工具路径
//     同源（snapshot/click 一并锁——避免只锁 navigate 造成别工具独立漂移）
//
// 与 runtime-browser-bridge-wiring.test.ts 互补：桥接线锁桥形态（initBrowserTools
// 被调次数 / 端口形状），本测试锁工具层对长 invoke 的 await 语义。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BrowserTools,
  initBrowserTools,
  __resetBrowserToolsForTest,
  type BrowserManagerPort,
  type BrowserPolicyPort,
} from '../../../src/main/agent/tools/browser-tools';
import { BrowserTakenOverError } from '../../../src/main/browser/errors';
import type { ToolContext } from '../../../src/main/agent/tools/types';

// =================================================================================
// 常量与夹具
// =================================================================================

/** 仿照既有 browser-tools.test.ts 的 ctx 构造（fixture 骨架照抄） */
function mkCtx(): ToolContext {
  return {
    wsFs: {} as never,
    workspaceId: 'ws1',
    workspaceDir: '/tmp/ws1',
    skillRegistry: {} as never,
    streamSessionId: 'ssn-agent-1',
    roomId: 'room-1',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: 'u1',
  };
}

/**
 * 自受控 deferred 工厂——返回 Promise 与外部 resolve/reject 钩子。
 * 用于「park」用例：Promise 在测试显式 resolve 前永挂起。
 * momo-test-rules：mock 必须仿真真实运行时语义（park 是真实 manager.gateAgentSide
 * await 一个内部 setInterval 驱动的 Promise，测试侧以受控 deferred 等价仿真）。
 */
function mkDeferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** policy mock——工具层只消费 assertAllowed / assertEvaluate，全放行 */
function mkPolicyMock(): BrowserPolicyPort {
  return {
    assertAllowed: (_wsId: string) => {},
    assertEvaluate: (_wsId: string) => {},
  };
}

/**
 * 构造 manager mock，其 navigate 返回受控 deferred；其余 11 工具同形——本测试
 * 只关心 execute 透传 park 与错误穿透，故其他方法只要「可达、不抛」即可。
 */
interface ParkManagerMock extends BrowserManagerPort {
  navDeferred: ReturnType<typeof mkDeferred<{ url: string; title: string }>>;
}

function mkParkManager(): ParkManagerMock {
  const navDeferred = mkDeferred<{ url: string; title: string }>();
  return {
    navDeferred,
    navigate: vi.fn((_wsId: string, _rawUrl: string) => navDeferred.promise),
    snapshot: vi.fn(async (_wsId: string) => '- empty'),
    screenshot: vi.fn(
      async (_wsId: string, _filename?: string) => ({ path: '/tmp/momo-browser-shots/ws1/shot.png' }),
    ),
    click: vi.fn(async (_wsId: string, _selector: string) => {}),
    type: vi.fn(async (_wsId: string, _selector: string, _text: string, _submit?: boolean) => {}),
    pressKey: vi.fn(async (_wsId: string, _key: string) => {}),
    hover: vi.fn(async (_wsId: string, _selector: string) => {}),
    scroll: vi.fn(async (_wsId: string, _direction: 'up' | 'down', _amount?: number) => {}),
    evaluate: vi.fn(async (_wsId: string, _expression: string) => ({ n: 1 })),
    consoleMessages: vi.fn(async (_wsId: string) => []),
    tabsAction: vi.fn(async (_wsId: string, _action: string) => []),
    closeBrowser: vi.fn(async (_wsId: string) => {}),
  };
}

/** 立即失败 manager mock——所有方法抛同一 BrowserTakenOverError（text 含「等待已关闭」） */
function mkFailFastManager(message: string): BrowserManagerPort {
  const err = new BrowserTakenOverError(message);
  return {
    navigate: vi.fn(async () => { throw err; }),
    snapshot: vi.fn(async () => { throw err; }),
    screenshot: vi.fn(async () => { throw err; }),
    click: vi.fn(async () => { throw err; }),
    type: vi.fn(async () => { throw err; }),
    pressKey: vi.fn(async () => { throw err; }),
    hover: vi.fn(async () => { throw err; }),
    scroll: vi.fn(async () => { throw err; }),
    evaluate: vi.fn(async () => { throw err; }),
    consoleMessages: vi.fn(async () => { throw err; }),
    tabsAction: vi.fn(async () => { throw err; }),
    closeBrowser: vi.fn(async () => { throw err; }),
  };
}

let tools: BrowserTools;
let ctx: ToolContext;

beforeEach(() => {
  __resetBrowserToolsForTest();
  tools = new BrowserTools();
  ctx = mkCtx();
});

// =================================================================================
// 工具层挂起锁（spec §6 用例 10 + M3 收尾）
// =================================================================================

describe('工具层 await park 语义穿透（user 态 manager mock）', () => {
  it('park 中：navigate 返回受控 pending Promise 时 execute 同步未 reject，挂起而非立即失败', async () => {
    const manager = mkParkManager();
    initBrowserTools(mkPolicyMock(), manager);

    const p = tools.execute('browser_navigate', { url: 'https://example.com' }, ctx);

    // 数微任务周期排空：未 resolve、未 reject——execute 正确地 await 在
    // manager.navigate 的 pending Promise 上（momo-test-rules 仿真真实 park）
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    let settled = false;
    void p.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    // 又一次微任务排空，确认 settled 标志未被翻成 rejected
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(manager.navigate).toHaveBeenCalledTimes(1);
    expect(manager.navigate).toHaveBeenCalledWith('ws1', 'https://example.com');

    // 清理：resolve pending 让未 await 的 p 不悬挂（不阻塞后续用例）
    manager.navDeferred.resolve({ url: 'https://example.com/final', title: 'Example' });
    await expect(p).resolves.toContain('已导航到 https://example.com/final');
  });

  it('park resolve 后：execute 正常返回（透传 manager 的 nav 结果）', async () => {
    const manager = mkParkManager();
    initBrowserTools(mkPolicyMock(), manager);

    const p = tools.execute('browser_navigate', { url: 'https://example.com' }, ctx);

    // 立即 resolve pending Promise（真实 park 在 release 后 resolve 此处等价）
    manager.navDeferred.resolve({ url: 'https://example.com/final', title: 'Example' });
    const result = await p;

    expect(result).toContain('已导航到 https://example.com/final');
    expect(result).toContain('页面标题: Example');
    expect(manager.navigate).toHaveBeenCalledWith('ws1', 'https://example.com');
  });

  it('park 多微任务后再 resolve：execute 仍正确 await（不丢延迟）', async () => {
    const manager = mkParkManager();
    initBrowserTools(mkPolicyMock(), manager);

    const p = tools.execute('browser_navigate', { url: 'https://example.com' }, ctx);

    // 模拟「user 长时间不释放」——execute 必须保持 await 状态
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    manager.navDeferred.resolve({ url: 'https://example.com/final', title: 'Example' });
    const result = await p;
    expect(result).toContain('已导航到');
    expect(result).toContain('https://example.com/final');
  });

  it('park 路径跨工具一致：snapshot / click 也同样 await 透传（非 navigate 专属）', async () => {
    // 工具层 await 语义对所有 12 工具同源——单测锁 navigate 不足以防别工具独立漂移
    const snapDeferred = mkDeferred<string>();
    const clickDeferred = mkDeferred<void>();
    const manager: BrowserManagerPort = {
      navigate: vi.fn(async () => ({ url: 'x', title: 'y' })),
      snapshot: vi.fn(() => snapDeferred.promise),
      screenshot: vi.fn(async () => ({ path: 'x' })),
      click: vi.fn(() => clickDeferred.promise),
      type: vi.fn(async () => {}),
      pressKey: vi.fn(async () => {}),
      hover: vi.fn(async () => {}),
      scroll: vi.fn(async () => {}),
      evaluate: vi.fn(async () => ({ n: 1 })),
      consoleMessages: vi.fn(async () => []),
      tabsAction: vi.fn(async () => []),
      closeBrowser: vi.fn(async () => {}),
    };
    initBrowserTools(mkPolicyMock(), manager);

    const ps = tools.execute('browser_snapshot', {}, ctx);
    const pc = tools.execute('browser_click', { selector: '#btn' }, ctx);
    await Promise.resolve();
    await Promise.resolve();

    let settledSnap = false;
    let settledClick = false;
    void ps.then(() => { settledSnap = true; }, () => { settledSnap = true; });
    void pc.then(() => { settledClick = true; }, () => { settledClick = true; });
    await Promise.resolve();
    await Promise.resolve();

    expect(settledSnap).toBe(false);
    expect(settledClick).toBe(false);

    // 清理：让 p 不悬挂
    snapDeferred.resolve('- root');
    clickDeferred.resolve();
    await expect(ps).resolves.toContain('- root');
    await expect(pc).resolves.toContain('已点击元素');
  });
});

describe('工具层错误穿透（readAgentWaitMs=0 形态的立即失败）', () => {
  it('manager 抛 BrowserTakenOverError（文案含「等待已关闭」）→ execute 原文穿透', async () => {
    // 仿真 readAgentWaitMs=0：manager 立即抛 BrowserTakenOverError，文案带
    // 「等待已关闭」（spec §4.5：等待关闭出口替代「等待释放后重试」旧文案）
    const msg =
      '浏览器被用户接管（等待已关闭）。可请用户点击浏览器侧栏的「释放」按钮，或改用 webfetch 等非浏览器方式继续当前任务';
    const manager = mkFailFastManager(msg);
    initBrowserTools(mkPolicyMock(), manager);

    await expect(
      tools.execute('browser_navigate', { url: 'https://example.com' }, ctx),
    ).rejects.toBeInstanceOf(BrowserTakenOverError);
    await expect(
      tools.execute('browser_navigate', { url: 'https://example.com' }, ctx),
    ).rejects.toThrow(/等待已关闭/);
    await expect(
      tools.execute('browser_navigate', { url: 'https://example.com' }, ctx),
    ).rejects.toThrow(/webfetch/);

    // manager.navigate 每次都真的被调到（错误发生在其内部），证明工具层不短路
    expect(manager.navigate).toHaveBeenCalledTimes(3);
  });

  it('错误穿透对所有 12 工具同源：click / snapshot / screenshot 等同样穿透 BrowserTakenOverError', async () => {
    // 锁「错误穿透不是 navigate 专属」——任何工具被 manager 抛错都原文透到 LLM
    const manager = mkFailFastManager('浏览器被用户接管（等待已关闭）');
    initBrowserTools(mkPolicyMock(), manager);

    await expect(
      tools.execute('browser_click', { selector: '#btn' }, ctx),
    ).rejects.toThrow(/等待已关闭/);
    await expect(tools.execute('browser_snapshot', {}, ctx)).rejects.toThrow(/等待已关闭/);
    await expect(tools.execute('browser_screenshot', {}, ctx)).rejects.toThrow(/等待已关闭/);
    await expect(tools.execute('browser_close', {}, ctx)).rejects.toThrow(/等待已关闭/);
  });
});