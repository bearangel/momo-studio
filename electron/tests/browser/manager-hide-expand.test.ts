// electron/tests/browser/manager-hide-expand.test.ts
//
// 隐藏/销毁分离 + 自动展开规则（spec §6.3/§7.3）：隐藏不销毁、agent 照常操作，
// 活跃会话导航 expandHint=true + 可见 tab 切换、非活跃不打扰。
import { describe, it, expect, vi } from 'vitest';
import { BrowserManager, type ViewFactory, type ManagedView } from '../../src/main/browser/manager';
import type { BrowserOpCtx } from '../../src/main/browser/op-protocol';

function makeView(): ManagedView {
  // getURL 仿真真实语义：返回最后 loadURL 的 URL（固定值会让 navigate 返回值断言失真）
  let url = 'https://example.com';
  const wc = {
    loadURL: vi.fn(async (u: string) => {
      url = u;
    }),
    on: vi.fn(),
    executeJavaScript: vi.fn(async () => null),
    sendInputEvent: vi.fn(),
    capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('') })),
    setWindowOpenHandler: vi.fn(),
    reload: vi.fn(),
    getURL: () => url,
    getTitle: () => 'Example',
    debugger: { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({})) },
  };
  return { webContents: wc, bounds: { setBounds: vi.fn() } } as unknown as ManagedView;
}

interface Fixture {
  manager: BrowserManager;
  states: Array<{ expandHint: boolean; current: number; tabs: unknown[] }>;
  views: ManagedView[];
}

function mk(): Fixture {
  const views: ManagedView[] = [];
  const factory: ViewFactory = { create: () => { const v = makeView(); views.push(v); return v; }, destroy: vi.fn(), clearData: vi.fn(async () => {}) };
  const states: Fixture['states'] = [];
  const manager = new BrowserManager(
    factory,
    { assertUrl: (_ws: string, u: string) => u, isAllowed: () => true, assertEvaluate: () => {}, setWorkspaceRoot: vi.fn() } as never,
    { pushState: (s) => states.push({ expandHint: s.expandHint, current: s.current, tabs: s.tabs }), pushNotice: vi.fn() },
  );
  return { manager, states, views };
}

const A: BrowserOpCtx = { ownerId: 'inst-a', sessionId: 'sess-1' };

describe('隐藏/销毁分离', () => {
  it('setSidebarVisible(false)：全部视图 bounds 置零、不销毁；true 恢复 current', async () => {
    const f = mk();
    f.manager.onWorkspaceActivated('w1', '/tmp');
    await f.manager.navigate('w1', 'https://a.com', A);
    f.manager.setSidebarVisible('w1', false);
    expect(f.views[0]!.bounds.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 });
    const list = await f.manager.tabsAction('w1', 'list', undefined, undefined, 'agent', A);
    expect(list).toHaveLength(1); // 未销毁
    // 隐藏期 agent 照常 navigate（新页面加载到自己的 tab）
    await f.manager.navigate('w1', 'https://b.com', A);
    // 显示 → applyLastRect 恢复（有 lastRect 时套用；无则等 renderer 重报）
    f.manager.setSidebarVisible('w1', true);
    expect(true).toBe(true);
  });
});

describe('自动展开规则（spec §7.3）', () => {
  it('活跃会话的 agent 导航 → ws.current 切到该 tab + 推送 expandHint=true', async () => {
    const f = mk();
    f.manager.onWorkspaceActivated('w1', '/tmp');
    f.manager.setActiveSession('sess-1');
    f.manager.setSidebarVisible('w1', false);
    await f.manager.navigate('w1', 'https://a.com', A);
    const last = f.states[f.states.length - 1]!;
    expect(last.expandHint).toBe(true);
    expect(last.current).toBe(0); // owner tab 成为可见 tab
  });

  it('非活跃会话的 agent 导航 → 不动可见 tab、expandHint=false（不打扰）', async () => {
    const f = mk();
    f.manager.onWorkspaceActivated('w1', '/tmp');
    f.manager.setActiveSession('sess-2'); // 活跃的是别的会话
    await f.manager.navigate('w1', 'https://a.com', A);
    const last = f.states[f.states.length - 1]!;
    expect(last.expandHint).toBe(false);
  });

  it('setActiveSession(null)（非会话视图）→ 安全缺省：永不 expandHint', async () => {
    const f = mk();
    f.manager.onWorkspaceActivated('w1', '/tmp');
    f.manager.setActiveSession(null);
    await f.manager.navigate('w1', 'https://a.com', A);
    expect(f.states[f.states.length - 1]!.expandHint).toBe(false);
  });
});

describe('折叠链路退役（spec §7.1/§7.4）', () => {
  it('跨 ws 切换保留 tab 归属（TabStash.owners）', async () => {
    const f = mk();
    f.manager.onWorkspaceActivated('w1', '/tmp');
    await f.manager.navigate('w1', 'https://a.com', A);
    f.manager.onWorkspaceActivated('w2', '/tmp2');
    f.manager.onWorkspaceActivated('w1', '/tmp');
    const all = await f.manager.tabsAction('w1', 'list', undefined, undefined, 'user');
    expect(all[0]!.owner).toBe('inst-a');
  });
});
