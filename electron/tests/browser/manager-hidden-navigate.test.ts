// electron/tests/browser/manager-hidden-navigate.test.ts
//
// 隐藏态 agent 导航等价锁（spec 2026-09-15 §7.2——manager-collapsed-navigate.test.ts 改写）。
// 旧回归意图不变：agent 活动不被 UI 收起态阻断、且正确通告 renderer（ebc0179）。
// 语义换轨：折叠销毁 + ensureLive 复活 + collapsed=false 推送 → 隐藏不销毁 +
// 视图本就存活 + expandHint 按活跃会话通告。
import { describe, it, expect, vi } from 'vitest';
import { BrowserManager, type ViewFactory, type ManagedView } from '../../src/main/browser/manager';
import type { BrowserOpCtx } from '../../src/main/browser/op-protocol';

function makeView(): ManagedView {
  const wc = {
    loadURL: vi.fn(async () => {}),
    on: vi.fn(),
    executeJavaScript: vi.fn(async () => null),
    sendInputEvent: vi.fn(),
    capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('') })),
    setWindowOpenHandler: vi.fn(),
    reload: vi.fn(),
    getURL: () => 'https://example.com',
    getTitle: () => 'Example',
    debugger: { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({})) },
  };
  return { webContents: wc, bounds: { setBounds: vi.fn() } } as unknown as ManagedView;
}

function makeManager() {
  const views: ManagedView[] = [];
  const factory: ViewFactory = {
    create: () => { const v = makeView(); views.push(v); return v; },
    destroy: vi.fn(),
    clearData: vi.fn(async () => {}),
  };
  const states: Array<{ expandHint: boolean; current: number; tabs: unknown[] }> = [];
  const manager = new BrowserManager(
    factory,
    { assertUrl: (_ws: string, u: string) => u, isAllowed: () => true, assertEvaluate: () => {}, setWorkspaceRoot: vi.fn() } as never,
    {
      pushState: (s) => states.push({ expandHint: s.expandHint, current: s.current, tabs: s.tabs }),
      pushNotice: vi.fn(),
    },
  );
  return { manager, states, views, factory };
}

const A: BrowserOpCtx = { ownerId: 'inst-a', sessionId: 'sess-1' };

describe('隐藏态 agent 导航（§7.2 等价锁——旧 ebc0179 回归意图承接）', () => {
  it('隐藏态 + owner 无 tab → navigate 直接建专属 tab（无旧清单可复活也不受阻）+ 活跃会话 expandHint=true', async () => {
    const { manager, states } = makeManager();
    manager.onWorkspaceActivated('w1', '/tmp');
    manager.setActiveSession('sess-1');
    manager.setSidebarVisible('w1', false); // 空浏览器上隐藏（旧场景：启动即按落库折叠）
    const r = await manager.navigate('w1', 'https://example.com', A);
    expect(r.url).toBe('https://example.com');
    // 通告 renderer 的不再依赖 collapsed 字段，而是 expandHint（本会话活跃 → true）
    const last = states[states.length - 1]!;
    expect(last.expandHint).toBe(true);
    expect(last.tabs).toHaveLength(1);
  });

  it('对照：隐藏前已有 tab → 隐藏期 navigate 落到既有 owner tab（不新建不销毁），bounds 维持全零', async () => {
    const { manager, states, views } = makeManager();
    manager.onWorkspaceActivated('w1', '/tmp');
    await manager.navigate('w1', 'https://a.com', A);
    manager.setSidebarVisible('w1', false); // 隐藏（tab 存活）
    await manager.navigate('w1', 'https://b.com', A);
    expect(views).toHaveLength(1); // 复用既有 tab——隐藏期懒建语义照旧，无复活重建
    expect(views[0]!.bounds.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 });
    expect(states[states.length - 1]!.expandHint).toBe(false); // 未报活跃会话 → 不打扰
  });
});
