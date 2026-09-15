// electron/tests/browser/manager-collapsed-navigate.test.ts
//
// 折叠态 agent 导航自动展开回归锁（ebc0179 同族，2026-09-15 复现）。
// 根因：ensureLive 在「两清单皆空」（启动即按落库折叠 / 切仓清单耗尽）时早退且
// 不清 ws.collapsed——navigate 继续建视图加载，emitState 推 collapsed=true，
// renderer 永不展开 → 页面以陈旧 lastRect 浮出而 chrome 收起。
import { describe, it, expect, vi } from 'vitest';
import { BrowserManager, type ViewFactory, type ManagedView } from '../../src/main/browser/manager';

function makeView(url = 'https://example.com'): ManagedView {
  const wc = {
    loadURL: vi.fn(async () => {}),
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

function makeManager(readSidebarCollapsed: boolean) {
  const factory: ViewFactory = { create: () => makeView(), destroy: vi.fn(), clearData: vi.fn(async () => {}) };
  const states: Array<{ collapsed: boolean; tabs: unknown[] }> = [];
  const manager = new BrowserManager(
    factory,
    { assertUrl: (_ws: string, u: string) => u, isAllowed: () => true, assertEvaluate: () => {}, setWorkspaceRoot: vi.fn() } as never,
    {
      pushState: (s) => states.push({ collapsed: s.collapsed, tabs: s.tabs }),
      pushNotice: vi.fn(),
    },
    { readSidebarCollapsed: () => readSidebarCollapsed },
  );
  return { manager, states };
}

describe('折叠态 agent 导航自动展开（2026-09-15 回归锁）', () => {
  it('启动即按落库折叠（两清单皆空）→ agent 导航：最终推送必须 collapsed=false（chrome 展开）且建出 tab', async () => {
    const { manager, states } = makeManager(true);
    manager.onWorkspaceActivated('w1', '/tmp');
    // 激活即折叠：无视图、无 collapseStash、无 stashedTabs 条目

    const r = await manager.navigate('w1', 'https://example.com');

    expect(r.url).toBe('https://example.com');
    // 关键断言：navigate 建视图加载后推送的最终态必须宣告展开——否则 renderer
    // 永不展开（页面浮出而 chrome 收起）
    const last = states[states.length - 1]!;
    expect(last.collapsed).toBe(false);
    expect(last.tabs).toHaveLength(1);
  });

  it('对照：会话内折叠（collapseStash 在）→ 同路径本就展开（既有行为锁）', async () => {
    const { manager, states } = makeManager(false);
    manager.onWorkspaceActivated('w1', '/tmp');
    await manager.navigate('w1', 'https://a.com');           // 展开态建 tab
    manager.setSidebarCollapsed('w1', true);                 // 会话内折叠（collapseStash 落）
    await manager.navigate('w1', 'https://b.com');
    expect(states[states.length - 1]!.collapsed).toBe(false);
  });
});
