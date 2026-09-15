// electron/tests/browser/manager-ownership.test.ts
//
// 归属制内核回归锁（spec §6.1）：多 owner tab 并存、光标独立、工具按 owner
// 解析、agent close 只清自己集合、user 源保持全局语义。
//
// mock 保真度说明（momo-test-rules 铁律 1）：loadURL 更新 getURL 返回值——
// 真实 Electron webContents.getURL() 反映最后一次载入的 URL，mock 若返回
// 固定常量则全部 URL 断言失真（brief 草稿缺陷，此处按真实运行时语义修正）。
import { describe, it, expect, vi } from 'vitest';
import { BrowserManager, type ViewFactory, type ManagedView } from '../../src/main/browser/manager';
import { USER_OP_CTX, type BrowserOpCtx } from '../../src/main/browser/op-protocol';

function makeView(): ManagedView {
  let url = 'about:blank';
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

function mk(): { manager: BrowserManager; states: Array<{ tabs: Array<{ url: string; owner: string }>; current: number }> } {
  const factory: ViewFactory = { create: () => makeView(), destroy: vi.fn(), clearData: vi.fn(async () => {}) };
  const states: Array<{ tabs: Array<{ url: string; owner: string }>; current: number }> = [];
  const manager = new BrowserManager(
    factory,
    { assertUrl: (_ws: string, u: string) => u, isAllowed: () => true, assertEvaluate: () => {}, setWorkspaceRoot: vi.fn() } as never,
    { pushState: (s) => states.push({ tabs: s.tabs.map((t) => ({ url: t.url, owner: t.owner })), current: s.current }), pushNotice: vi.fn() },
  );
  return { manager, states };
}

const A: BrowserOpCtx = { ownerId: 'inst-a', sessionId: 'sess-1' };
const B: BrowserOpCtx = { ownerId: 'inst-b', sessionId: 'sess-2' };

describe('归属制内核', () => {
  it('P1 回归锁：A 开百度 + B 开 bing → 两 tab 并存互不覆盖，list 按各自作用域返回', async () => {
    const { manager } = mk();
    manager.onWorkspaceActivated('w1', '/tmp');
    await manager.navigate('w1', 'https://baidu.com', A);
    await manager.navigate('w1', 'https://bing.com', B);
    // A 视角：只有自己的 tab
    const listA = await manager.tabsAction('w1', 'list', undefined, undefined, 'agent', A);
    expect(listA.map((t) => t.url)).toEqual(['https://baidu.com']);
    expect(listA[0]!.index).toBe(0); // 集合内重索引
    const listB = await manager.tabsAction('w1', 'list', undefined, undefined, 'agent', B);
    expect(listB.map((t) => t.url)).toEqual(['https://bing.com']);
    // user 全局视角：两个都在
    const all = await manager.tabsAction('w1', 'list', undefined, undefined, 'user');
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.owner).sort()).toEqual(['inst-a', 'inst-b']);
  });

  it('agent open 追加自己集合且光标迁移，不动可见 tab', async () => {
    const { manager } = mk();
    manager.onWorkspaceActivated('w1', '/tmp');
    await manager.navigate('w1', 'https://a1.com', A);
    await manager.navigate('w1', 'https://b1.com', B);
    // user 把可见 tab 切到 B 的页面（全局下标）
    await manager.tabsAction('w1', 'switch', 1, undefined, 'user');
    // A 再 open 新 tab（无 url）
    const list = await manager.tabsAction('w1', 'open', undefined, undefined, 'agent', A);
    expect(list).toHaveLength(2); // A 视角：a1 + 新 tab
    // A 的后续 navigate 落在新 tab 而非 a1
    await manager.navigate('w1', 'https://a2.com', A);
    const list2 = await manager.tabsAction('w1', 'list', undefined, undefined, 'agent', A);
    expect(list2.map((t) => t.url)).toEqual(['https://a1.com', 'https://a2.com']);
  });

  it('agent close 关光自己最后一个 tab → 集合清空不触发关浏览器；再次 navigate 懒建', async () => {
    const { manager } = mk();
    manager.onWorkspaceActivated('w1', '/tmp');
    await manager.navigate('w1', 'https://a1.com', A);
    await manager.navigate('w1', 'https://b1.com', B);
    const after = await manager.tabsAction('w1', 'close', 0, undefined, 'agent', A);
    expect(after).toEqual([]); // A 集合空
    // B 不受影响
    const listB = await manager.tabsAction('w1', 'list', undefined, undefined, 'agent', B);
    expect(listB.map((t) => t.url)).toEqual(['https://b1.com']);
    // A 再导航 → 懒建首 tab
    await manager.navigate('w1', 'https://a3.com', A);
    const listA = await manager.tabsAction('w1', 'list', undefined, undefined, 'agent', A);
    expect(listA.map((t) => t.url)).toEqual(['https://a3.com']);
  });

  it('视图类工具按 owner 光标解析：evaluate 落在 owner 的 current tab', async () => {
    const { manager } = mk();
    manager.onWorkspaceActivated('w1', '/tmp');
    await manager.navigate('w1', 'https://a1.com', A);
    await manager.navigate('w1', 'https://b1.com', B);
    const r = await manager.evaluate('w1', '1+1', B);
    expect(r).toBeNull(); // mock executeJavaScript 返回 null——断言不抛 NoView 即按 owner 解析成功
  });

  it('browser_close（agent 源）只销毁自己的 tab；user 源销毁全部', async () => {
    const { manager } = mk();
    manager.onWorkspaceActivated('w1', '/tmp');
    await manager.navigate('w1', 'https://a1.com', A);
    await manager.navigate('w1', 'https://b1.com', B);
    await manager.closeBrowser('w1', 'agent', A);
    const all = await manager.tabsAction('w1', 'list', undefined, undefined, 'user');
    expect(all.map((t) => t.url)).toEqual(['https://b1.com']); // 只剩 B
    await manager.closeBrowser('w1', 'user');
    const all2 = await manager.tabsAction('w1', 'list', undefined, undefined, 'user');
    expect(all2).toEqual([]);
  });

  it('ownerCurrent 悬空（用户关掉 agent 的当前 tab）→ 下次操作修正回集合首个', async () => {
    const { manager } = mk();
    manager.onWorkspaceActivated('w1', '/tmp');
    await manager.navigate('w1', 'https://a1.com', A);
    // open 建 A 集合第二个 tab（navigate 复用光标 tab——第二个 tab 须经 open 建立）
    await manager.tabsAction('w1', 'open', undefined, 'https://a2.com', 'agent', A);
    // user 全局视角关掉 A 的当前 tab（全局下标 1）
    await manager.tabsAction('w1', 'close', 1, undefined, 'user');
    // A 的 navigate 修正回集合首个（a1 的 tab）而非报错/悬空——a3 载入该 tab，不新建
    await manager.navigate('w1', 'https://a3.com', A);
    const listA = await manager.tabsAction('w1', 'list', undefined, undefined, 'agent', A);
    expect(listA).toHaveLength(1);
    expect(listA[0]!.url).toBe('https://a3.com');
  });

  it('I-1 回归锁：删除点位于他方光标之前时，他方 navigate 仍落在自己的 current tab', async () => {
    const { manager } = mk();
    manager.onWorkspaceActivated('w1', '/tmp');
    await manager.navigate('w1', 'https://a1.com', A);
    await manager.navigate('w1', 'https://b1.com', B);
    // B 开第二个 tab 并 switch 到它（全局视角 B 光标 = 2）
    await manager.tabsAction('w1', 'open', undefined, undefined, 'agent', B);
    await manager.tabsAction('w1', 'switch', 1, undefined, 'agent', B);
    // A 关光自己唯一的 tab（删全局 0，B 光标前移）→ B 的 navigate 必须落在其 current（b2）而非漂移
    await manager.tabsAction('w1', 'close', 0, undefined, 'agent', A);
    await manager.navigate('w1', 'https://b3.com', B);
    const listB = await manager.tabsAction('w1', 'list', undefined, undefined, 'agent', B);
    expect(listB.map((t) => t.url)).toEqual(['https://b1.com', 'https://b3.com']);
  });

  it('user 源保持既有全局语义（缺省 ctx 直调 = user 路径不回归）', async () => {
    const { manager } = mk();
    manager.onWorkspaceActivated('w1', '/tmp');
    const r = await manager.navigate('w1', 'https://u1.com'); // 缺省 USER_OP_CTX
    expect(r.url).toBe('https://u1.com');
    const all = await manager.tabsAction('w1', 'list', undefined, undefined, 'user');
    expect(all[0]!.owner).toBe('user');
    // 显式传 USER_OP_CTX 与缺省等价（视图类工具同一路径）
    const msgs = await manager.consoleMessages('w1', USER_OP_CTX);
    expect(msgs).toEqual([]);
  });
});
