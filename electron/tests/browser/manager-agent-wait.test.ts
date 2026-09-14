// electron/tests/browser/manager-agent-wait.test.ts
//
// 接管驻留等待回归矩阵（spec 2026-09-14-browser-takeover §6 用例 1-8）。
// fixture 对齐 manager.test.ts 模式：mock 收窄在 Electron 视图边界（ViewFactory /
// webContents），policy 用真实实现（momo-test-rules mock 收窄）+ fake timers 控
// tick/超时/空闲。注意：用例2 的时序为「先推进时间触发超时、再断言 rejection」
// ——park 中的 promise 只有 fake clock 前进后才会 settle（与用例5b 同模式）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserManager, type ManagedView, type ManagedWebContents, type ViewFactory } from '../../src/main/browser/manager';
import { BrowserPolicy } from '../../src/main/browser/policy';
import { BrowserTakenOverError } from '../../src/main/browser/errors';
import type { WorkspaceBrowserSettings } from '../../src/main/browser/types';

// === mock 视图（仿真 Electron webContents 交互面——本套件不触发事件，on 仅注册） ===

function makeView(url = 'https://example.com'): ManagedView {
  const webContents: ManagedWebContents = {
    loadURL: vi.fn(async () => {}),
    on: vi.fn(),
    executeJavaScript: vi.fn(async () => null),
    sendInputEvent: vi.fn(),
    capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('') })),
    setWindowOpenHandler: vi.fn(),
    reload: vi.fn(),
    getURL: () => url,
    getTitle: () => 'Example',
    debugger: { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({ nodes: [] })) },
  };
  return { webContents, bounds: { setBounds: vi.fn() } };
}

const baseSettings: WorkspaceBrowserSettings = {
  trust: 'always',
  evaluateEnabled: false,
  blacklist: [],
  whitelist: [],
};

function makeManager(opts?: { waitMs?: number; idleMs?: number }) {
  const factory: ViewFactory = { create: () => makeView(), destroy: vi.fn(), clearData: vi.fn(async () => {}) };
  const states: Array<{ takeover: string }> = [];
  const notices: Array<{ kind: string; durationMs?: number }> = [];
  const manager = new BrowserManager(
    factory,
    new BrowserPolicy(() => ({ ...baseSettings }), '/tmp'),
    {
      pushState: (s) => states.push({ takeover: s.takeover }),
      pushNotice: (kind, _text, _wsId, durationMs) => notices.push({ kind, durationMs }),
    },
    {
      readAgentWaitMs: () => opts?.waitMs ?? 60_000,
      readIdleAutoReleaseMs: () => opts?.idleMs ?? 90_000,
    },
  );
  return { manager, states, notices };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('gateAgentSide 驻留等待（spec §6）', () => {
  it('用例1：user 态 navigate 不立即抛，释放后放行并完成导航', async () => {
    const { manager } = makeManager();
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.userTakeover('w1');
    const p = manager.navigate('w1', 'https://example.com');
    // 微任务排空后仍 pending（不立即 reject）
    await vi.advanceTimersByTimeAsync(0);
    manager.releaseTakeover('w1');
    const r = await p;
    expect(r.url).toBe('https://example.com');
  });

  it('用例2：超时抛 BrowserTakenOverError，文案含等待秒数与 webfetch 指引', async () => {
    const { manager } = makeManager({ waitMs: 5_000 });
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.userTakeover('w1');
    const p = manager.navigate('w1', 'https://example.com');
    void p.catch(() => {}); // 预挂兜底 handler——超时 rejection 先于断言 attach，防 unhandled rejection 噪音
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).rejects.toBeInstanceOf(BrowserTakenOverError);
    await expect(p).rejects.toThrow(/已等待 5 秒/);
    await expect(p).rejects.toThrow(/webfetch/);
  });

  it('用例3：并发 join 单飞——两个调用只推一次 notice，释放后都放行', async () => {
    const { manager, notices } = makeManager();
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.userTakeover('w1');
    const p1 = manager.navigate('w1', 'https://example.com');
    const p2 = manager.snapshot('w1');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notices.filter((n) => n.kind === 'agent-waiting-release')).toHaveLength(1);
    manager.releaseTakeover('w1');
    await Promise.all([p1, p2]);
  });

  it('用例2b：notice 载荷携带 durationMs（= 实际生效等待时长）', async () => {
    const { manager, notices } = makeManager({ waitMs: 5_000 });
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.userTakeover('w1');
    const p = manager.navigate('w1', 'https://example.com');
    await vi.advanceTimersByTimeAsync(0);
    expect(notices[0]).toMatchObject({ kind: 'agent-waiting-release', durationMs: 5_000 });
    manager.releaseTakeover('w1');
    await p;
  });

  it('用例4：释放后被再接管——循环复查继续等（deadline 内不误放行）', async () => {
    const { manager } = makeManager();
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.userTakeover('w1');
    const p = manager.navigate('w1', 'https://example.com');
    await vi.advanceTimersByTimeAsync(0);
    manager.releaseTakeover('w1');
    manager.userTakeover('w1'); // 释放瞬间再接管（同步竞态仿真）
    await vi.advanceTimersByTimeAsync(1_000);
    // 仍 user 态：p 不得 resolve（挂起断言——用竞态标志）
    let settled = false;
    void p.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    manager.releaseTakeover('w1');
    await p;
  });

  it('用例5a：空闲自愈——lastUserInputAt 过期 → 自动回切并放行', async () => {
    const { manager, states } = makeManager({ idleMs: 10_000, waitMs: 120_000 });
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.userTakeover('w1'); // lastUserInputAt ≈ now
    const p = manager.navigate('w1', 'https://example.com');
    await vi.advanceTimersByTimeAsync(10_000); // 空闲到期
    const r = await p;
    expect(r.url).toBe('https://example.com');
    expect(states[states.length - 1]!.takeover).toBe('agent'); // 状态已回切
  });

  it('用例5b：等待中用户持续输入刷新计时 → 不自愈，走向超时', async () => {
    const { manager } = makeManager({ idleMs: 10_000, waitMs: 30_000 });
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.userTakeover('w1');
    const p = manager.navigate('w1', 'https://example.com');
    void p.catch(() => {}); // 同用例2——超时 rejection 先于断言 attach
    // 每 8s 模拟一次用户输入（before-input-event 路径经 userTakeover 幂等 + 刷新时刻）
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(8_000);
      manager.userTakeover('w1');
    }
    await vi.advanceTimersByTimeAsync(30_000); // 总超时
    await expect(p).rejects.toBeInstanceOf(BrowserTakenOverError);
  });

  it('用例6：不打扰原则——无 waiter 挂起时输入过期绝不自动回切', () => {
    const { manager, states } = makeManager({ idleMs: 10_000 });
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.userTakeover('w1');
    vi.advanceTimersByTime(60_000);
    expect(states[states.length - 1]!.takeover).toBe('user'); // 保持 user
  });

  it('用例7：清理——park 中 closeBrowser 后 waiter 不悬挂（settle，后续门控自然接管）', async () => {
    const { manager } = makeManager();
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.userTakeover('w1');
    const p = manager.navigate('w1', 'https://example.com');
    await vi.advanceTimersByTimeAsync(0);
    await manager.closeBrowser('w1', 'user'); // 用户路径关浏览器（agent 路径会先过 gate）
    // close 后 takeover 复位 agent → park resolve → navigate 走空视图重建路径正常完成
    const r = await p;
    expect(r.url).toBe('https://example.com');
  });

  it('用例8：快路径零回归——agent 态调用零延迟且不推 notice', async () => {
    const { manager, notices } = makeManager();
    manager.onWorkspaceActivated('w1', '/tmp');
    const r = await manager.navigate('w1', 'https://example.com');
    expect(r.url).toBe('https://example.com');
    expect(notices).toHaveLength(0);
  });
});
