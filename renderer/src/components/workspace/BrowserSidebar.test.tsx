// renderer/src/components/workspace/BrowserSidebar.test.tsx
//
// BrowserSidebar 集成测试（v2.7 Task 8，spec §3.5）：
//   - 挂载拉 getState 渲染（tabs / 当前 url / 标题 / takeover / trusted）
//   - 订阅 onBrowserState 增量更新（非本 workspace 推送忽略）；卸载清理订阅
//   - 折叠 → setSidebarCollapsed(true) 且只剩竖条展开钮；再点展开
//   - 空态（无 tab）→ 引导文案 + 地址栏可用
//   - 占位区上报锁：ResizeObserver + window resize → getBoundingClientRect →
//     setSidebarBounds（rect 参数来自 getBoundingClientRect）；卸载 disconnect；
//     折叠态不上报
//   - 鼠标接管 overlay（HARD，DoD 17）：agent 态存在 + mousedown → takeover() 且
//     移除；user 态无 overlay；释放回 agent 后重挂；takeover 拒绝重挂（错误路径）
//   - TabsBar / DevServerDropdown IPC 接线（openTab→switchTab / closeTab / userNavigate）
// mock 形态照抄 SandboxNotice.test.tsx（globalThis.window.api 桩 + ipc Proxy 透传）；
// ResizeObserver 为平台边界桩（jsdom 不提供且不执行布局）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { BrowserSidebar } from './BrowserSidebar';
import type { BrowserState, BrowserSettings, BrowserTabInfo } from '../../ipc/types';

// ---------- window.api 桩（browser 命名空间全方法） ----------
const getStateMock = vi.fn();
const userNavigateMock = vi.fn();
const takeoverMock = vi.fn();
const releaseTakeoverMock = vi.fn();
const openTabMock = vi.fn();
const closeTabMock = vi.fn();
const switchTabMock = vi.fn();
const setSidebarBoundsMock = vi.fn();
const setSidebarCollapsedMock = vi.fn();
const listDevServersMock = vi.fn();
const getSettingsMock = vi.fn();
const onBrowserStateMock = vi.fn();
const onBrowserNoticeMock = vi.fn();

const mockApi = {
  browser: {
    getState: getStateMock,
    userNavigate: userNavigateMock,
    takeover: takeoverMock,
    releaseTakeover: releaseTakeoverMock,
    openTab: openTabMock,
    closeTab: closeTabMock,
    switchTab: switchTabMock,
    setSidebarBounds: setSidebarBoundsMock,
    setSidebarCollapsed: setSidebarCollapsedMock,
    listDevServers: listDevServersMock,
    getSettings: getSettingsMock,
    onBrowserState: onBrowserStateMock,
    onBrowserNotice: onBrowserNoticeMock,
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

// ---------- ResizeObserver 桩：捕获实例供测试手动触发 resize ----------
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  public callback: ResizeObserverCallback;
  public observed: Element[] = [];
  public disconnected = false;
  constructor(cb: ResizeObserverCallback) {
    this.callback = cb;
    ResizeObserverStub.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  /** 模拟一次 resize 回调（真实 ResizeObserver observe 后必发首帧回调） */
  trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

// ---------- 状态工厂（真实 BrowserState 形状——types.d.ts 契约） ----------
function mkState(overrides?: Partial<BrowserState>): BrowserState {
  return {
    workspaceId: 'w1',
    tabs: [{ index: 0, url: 'https://example.com/', title: 'Example' }],
    current: 0,
    url: 'https://example.com/',
    title: 'Example',
    takeover: 'agent',
    trusted: true,
    ...overrides,
  };
}

// ---------- 设置工厂（真实 BrowserSettings 形状——types.d.ts 契约） ----------
function mkSettings(overrides?: Partial<BrowserSettings>): BrowserSettings {
  return {
    trust: 'ask',
    evaluateEnabled: false,
    blacklist: [],
    whitelist: [],
    sidebarCollapsed: false,
    sidebarWidth: 380,
    ...overrides,
  };
}

/** onBrowserState 桩默认行为：捕获回调 + 返回解订阅 spy */
function armOnBrowserState(): { push: (s: BrowserState) => void; unsubscribe: ReturnType<typeof vi.fn> } {
  let captured: ((s: BrowserState) => void) | null = null;
  const unsubscribe = vi.fn();
  onBrowserStateMock.mockImplementation((cb: (s: BrowserState) => void) => {
    captured = cb;
    return unsubscribe;
  });
  return {
    push: (s: BrowserState) => act(() => captured?.(s)),
    unsubscribe,
  };
}

/** 把占位区 getBoundingClientRect 桩成固定 rect（jsdom 布局恒零——参数溯源断言依赖此桩） */
function stubRect(el: Element, rect: { x: number; y: number; width: number; height: number }): void {
  el.getBoundingClientRect = () =>
    ({ ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => ({}) }) as DOMRect;
}

beforeEach(() => {
  for (const m of [
    getStateMock, userNavigateMock, takeoverMock, releaseTakeoverMock, openTabMock,
    closeTabMock, switchTabMock, setSidebarBoundsMock, setSidebarCollapsedMock,
    listDevServersMock, getSettingsMock, onBrowserStateMock, onBrowserNoticeMock,
  ]) {
    m.mockReset();
  }
  // 默认返回值对齐真实 invoke 语义（恒返回 Promise）——momo-test-rules 保真度
  getStateMock.mockResolvedValue(mkState());
  userNavigateMock.mockResolvedValue({ url: '', title: '' });
  takeoverMock.mockResolvedValue(undefined);
  releaseTakeoverMock.mockResolvedValue(undefined);
  openTabMock.mockResolvedValue([]);
  closeTabMock.mockResolvedValue([]);
  switchTabMock.mockResolvedValue([]);
  setSidebarBoundsMock.mockResolvedValue(undefined);
  setSidebarCollapsedMock.mockResolvedValue(undefined);
  listDevServersMock.mockResolvedValue([]);
  getSettingsMock.mockResolvedValue(mkSettings());
  onBrowserStateMock.mockReturnValue(() => {});
  ResizeObserverStub.instances = [];
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
});

describe('BrowserSidebar·状态渲染（v2.7 Task 8）', () => {
  it('挂载调 getState(workspaceId) 并渲染 tabs / 当前 url / 标题 / takeover / trusted', async () => {
    getStateMock.mockResolvedValue(
      mkState({
        takeover: 'user',
        trusted: false,
        url: 'https://a.com/',
        title: '站点 A',
        tabs: [{ index: 0, url: 'https://a.com/', title: '站点 A' }],
      }),
    );
    render(<BrowserSidebar workspaceId="w1" />);
    await waitFor(() => expect(getStateMock).toHaveBeenCalledWith('w1'));
    // tabs（标题）+ 当前 url（地址栏）+ takeover（user 徽标）+ trusted（受限徽标）
    expect(await screen.findByText('站点 A')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('https://a.com/');
    expect(screen.getByText('用户接管中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '释放' })).toBeInTheDocument();
    expect(screen.getByText('工具受限')).toBeInTheDocument();
  });

  it('trusted=true → 显示「工具已放行」徽标', async () => {
    getStateMock.mockResolvedValue(mkState({ trusted: true }));
    render(<BrowserSidebar workspaceId="w1" />);
    expect(await screen.findByText('工具已放行')).toBeInTheDocument();
  });

  it('订阅 onBrowserState → 推送增量更新 url / title / tabs', async () => {
    const { push } = armOnBrowserState();
    getStateMock.mockResolvedValue(mkState());
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');

    const tabs: BrowserTabInfo[] = [
      { index: 0, url: 'https://example.com/', title: 'Example' },
      { index: 1, url: 'https://new.com/', title: '新页面' },
    ];
    push(mkState({ url: 'https://new.com/', title: '新页面', tabs, current: 1 }));
    expect(await screen.findByText('新页面')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('https://new.com/');
  });

  it('推送 takeover=user → 接管徽标出现；推送 takeover=agent → 徽标消失', async () => {
    const { push } = armOnBrowserState();
    getStateMock.mockResolvedValue(mkState({ takeover: 'agent' }));
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');
    expect(screen.queryByText('用户接管中')).not.toBeInTheDocument();

    push(mkState({ takeover: 'user' }));
    expect(await screen.findByText('用户接管中')).toBeInTheDocument();

    push(mkState({ takeover: 'agent' }));
    await waitFor(() => expect(screen.queryByText('用户接管中')).not.toBeInTheDocument());
  });

  it('非本 workspace 的推送被忽略（manager 只保证单活跃 ws——契约防御）', async () => {
    const { push } = armOnBrowserState();
    getStateMock.mockResolvedValue(mkState());
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');

    push({ ...mkState({ url: 'https://other.com/', title: '别家' }), workspaceId: 'w2' });
    // 等 microtask 后显示不变
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText('别家')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('https://example.com/');
  });

  it('卸载 → onBrowserState 解订阅被调', async () => {
    const { unsubscribe } = armOnBrowserState();
    getStateMock.mockResolvedValue(mkState());
    const { unmount } = render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('getState 拒绝 → chrome 骨架仍渲染（订阅推送兜底，不白屏——错误路径）', async () => {
    getStateMock.mockRejectedValue(new Error('boot 早期'));
    render(<BrowserSidebar workspaceId="w1" />);
    // 地址栏与折叠钮仍在；引导文案占位（无 tab）
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '折叠浏览器侧栏' })).toBeInTheDocument();
  });
});

describe('BrowserSidebar·空态与地址栏（spec §3.5）', () => {
  it('无 tab → 引导文案 + 地址栏可用（Enter → userNavigate）', async () => {
    getStateMock.mockResolvedValue(mkState({ tabs: [], url: '', title: '' }));
    userNavigateMock.mockResolvedValue({ url: 'https://typed.com/', title: '' });
    render(<BrowserSidebar workspaceId="w1" />);
    expect(await screen.findByText('浏览器待命')).toBeInTheDocument();

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'https://typed.com/' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(userNavigateMock).toHaveBeenCalledWith('w1', 'https://typed.com/'));
  });
});

describe('BrowserSidebar·折叠（spec §3.5 / I2）', () => {
  it('折叠钮 → setSidebarCollapsed(w1,true)；组件只剩竖条展开钮（无地址栏/占位区）', async () => {
    setSidebarCollapsedMock.mockResolvedValue(undefined);
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');

    fireEvent.click(screen.getByRole('button', { name: '折叠浏览器侧栏' }));
    await waitFor(() => expect(setSidebarCollapsedMock).toHaveBeenCalledWith('w1', true));
    expect(screen.queryByTestId('browser-placeholder')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '展开浏览器侧栏' })).toBeInTheDocument();
  });

  it('竖条展开钮 → setSidebarCollapsed(w1,false) + 占位区回归', async () => {
    setSidebarCollapsedMock.mockResolvedValue(undefined);
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');
    fireEvent.click(screen.getByRole('button', { name: '折叠浏览器侧栏' }));
    await screen.findByRole('button', { name: '展开浏览器侧栏' });

    fireEvent.click(screen.getByRole('button', { name: '展开浏览器侧栏' }));
    await waitFor(() => expect(setSidebarCollapsedMock).toHaveBeenCalledWith('w1', false));
    expect(screen.getByTestId('browser-placeholder')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
});

describe('BrowserSidebar·折叠初始态跨重启（v2.7 Task 9）', () => {
  it('挂载读 getSettings(w1)；sidebarCollapsed=true → 初始即折叠竖条（无地址栏/占位区）', async () => {
    getSettingsMock.mockResolvedValue(mkSettings({ sidebarCollapsed: true }));
    render(<BrowserSidebar workspaceId="w1" />);
    await waitFor(() => expect(getSettingsMock).toHaveBeenCalledWith('w1'));
    const expand = await screen.findByRole('button', { name: '展开浏览器侧栏' });
    expect(expand).toBeInTheDocument();
    expect(screen.queryByTestId('browser-placeholder')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    // 初始折叠不重放 setSidebarCollapsed（落库值本就如此，无变更可写）
    expect(setSidebarCollapsedMock).not.toHaveBeenCalled();
  });

  it('sidebarCollapsed=false（默认）→ 初始展开，chrome 照常渲染', async () => {
    getSettingsMock.mockResolvedValue(mkSettings({ sidebarCollapsed: false }));
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');
    expect(screen.getByTestId('browser-placeholder')).toBeInTheDocument();
  });

  it('用户先于读取返回前手动折叠 → 晚到的 collapsed=false 不覆盖用户操作', async () => {
    let resolveSettings: (s: BrowserSettings) => void = () => {};
    getSettingsMock.mockReturnValue(
      new Promise<BrowserSettings>((res) => {
        resolveSettings = res;
      }),
    );
    render(<BrowserSidebar workspaceId="w1" />);
    // 读取未返回期间用户点折叠（默认展开态 → 折叠）
    fireEvent.click(screen.getByRole('button', { name: '折叠浏览器侧栏' }));
    await screen.findByRole('button', { name: '展开浏览器侧栏' });
    // 晚到的落库值（false）到达——不得把用户刚折叠的侧栏强行展开
    await act(async () => {
      resolveSettings(mkSettings({ sidebarCollapsed: false }));
    });
    expect(screen.getByRole('button', { name: '展开浏览器侧栏' })).toBeInTheDocument();
  });

  it('getSettings 拒绝 → 保持默认展开（初始态是体验性增强，不阻塞 chrome 骨架）', async () => {
    getSettingsMock.mockRejectedValue(new Error('boot 早期通道未就绪'));
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');
    expect(screen.getByTestId('browser-placeholder')).toBeInTheDocument();
  });
});

describe('BrowserSidebar·占位区上报锁（spec §3.5）', () => {
  it('挂载（展开态）→ 首帧即调 setSidebarBounds；ResizeObserver 观察占位区', async () => {
    render(<BrowserSidebar workspaceId="w1" />);
    const placeholder = await screen.findByTestId('browser-placeholder');
    await waitFor(() => expect(setSidebarBoundsMock).toHaveBeenCalled());
    const observer = ResizeObserverStub.instances[0]!;
    expect(observer.observed).toContain(placeholder);
  });

  it('rect 参数来自 getBoundingClientRect（jsdom 布局恒零——桩值即溯源证明）', async () => {
    render(<BrowserSidebar workspaceId="w1" />);
    const placeholder = await screen.findByTestId('browser-placeholder');
    await waitFor(() => expect(setSidebarBoundsMock).toHaveBeenCalled());

    stubRect(placeholder, { x: 11, y: 22, width: 380, height: 600 });
    fireEvent(window, new Event('resize'));
    await waitFor(() =>
      expect(setSidebarBoundsMock).toHaveBeenLastCalledWith({ x: 11, y: 22, width: 380, height: 600 }),
    );

    // ResizeObserver 回调路径同样上报
    stubRect(placeholder, { x: 13, y: 24, width: 382, height: 602 });
    ResizeObserverStub.instances[0]!.trigger();
    await waitFor(() =>
      expect(setSidebarBoundsMock).toHaveBeenLastCalledWith({ x: 13, y: 24, width: 382, height: 602 }),
    );
  });

  it('卸载 → ResizeObserver disconnect + window resize 监听移除', async () => {
    const { unmount } = render(<BrowserSidebar workspaceId="w1" />);
    const placeholder = await screen.findByTestId('browser-placeholder');
    await waitFor(() => expect(setSidebarBoundsMock).toHaveBeenCalled());
    const observer = ResizeObserverStub.instances[0]!;
    expect(observer.disconnected).toBe(false);

    stubRect(placeholder, { x: 11, y: 22, width: 380, height: 600 });
    unmount();
    expect(observer.disconnected).toBe(true);

    const countBefore = setSidebarBoundsMock.mock.calls.length;
    fireEvent(window, new Event('resize'));
    await new Promise((r) => setTimeout(r, 10));
    expect(setSidebarBoundsMock.mock.calls.length).toBe(countBefore);
  });

  it('折叠 → 占位区卸载后 window resize 不再上报（折叠态不上报——manager 折叠即销毁视图，零尺寸上报无意义）', async () => {
    setSidebarCollapsedMock.mockResolvedValue(undefined);
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');
    const placeholder = screen.getByTestId('browser-placeholder');
    stubRect(placeholder, { x: 11, y: 22, width: 380, height: 600 });
    fireEvent(window, new Event('resize'));
    await waitFor(() =>
      expect(setSidebarBoundsMock).toHaveBeenLastCalledWith({ x: 11, y: 22, width: 380, height: 600 }),
    );
    const countBefore = setSidebarBoundsMock.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: '折叠浏览器侧栏' }));
    await screen.findByRole('button', { name: '展开浏览器侧栏' });
    fireEvent(window, new Event('resize'));
    await new Promise((r) => setTimeout(r, 10));
    expect(setSidebarBoundsMock.mock.calls.length).toBe(countBefore);
  });
});

describe('BrowserSidebar·鼠标接管 overlay（HARD——DoD 17）', () => {
  it('agent 态 → overlay 存在；mousedown → takeover(w1) 且 overlay 立即移除', async () => {
    takeoverMock.mockResolvedValue(undefined);
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');

    const overlay = screen.getByTestId('browser-takeover-overlay');
    fireEvent.mouseDown(overlay);
    await waitFor(() => expect(takeoverMock).toHaveBeenCalledWith('w1'));
    // 本地立即移除（不等状态推送——用户的下一次点击必须直达页面）
    expect(screen.queryByTestId('browser-takeover-overlay')).not.toBeInTheDocument();
  });

  it('user 态 → 无 overlay（用户直接操作页面）', async () => {
    getStateMock.mockResolvedValue(mkState({ takeover: 'user' }));
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('用户接管中');
    expect(screen.queryByTestId('browser-takeover-overlay')).not.toBeInTheDocument();
  });

  it('空态（无 tab）→ 无 overlay：占位区 mousedown 不触发 takeover（review fix：不误接管空浏览器）', async () => {
    const { push } = armOnBrowserState(); // 订阅须在 render 前接线（组件挂载即订阅）
    takeoverMock.mockResolvedValue(undefined);
    getStateMock.mockResolvedValue(mkState({ tabs: [], url: '', title: '' }));
    render(<BrowserSidebar workspaceId="w1" />);
    expect(await screen.findByText('浏览器待命')).toBeInTheDocument();
    expect(screen.queryByTestId('browser-takeover-overlay')).not.toBeInTheDocument();

    // 占位区 mousedown 不调 takeover（agent 工具不被空态误锁）
    fireEvent.mouseDown(screen.getByTestId('browser-placeholder'));
    await new Promise((r) => setTimeout(r, 10));
    expect(takeoverMock).not.toHaveBeenCalled();

    // 反向锁：tab 出现（agent 打开页面）→ overlay 照常挂载
    push(mkState());
    expect(await screen.findByTestId('browser-takeover-overlay')).toBeInTheDocument();
  });

  it('释放（user → agent 推送）→ overlay 重挂', async () => {
    const { push } = armOnBrowserState();
    getStateMock.mockResolvedValue(mkState({ takeover: 'user' }));
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('用户接管中');
    expect(screen.queryByTestId('browser-takeover-overlay')).not.toBeInTheDocument();

    push(mkState({ takeover: 'agent' }));
    expect(await screen.findByTestId('browser-takeover-overlay')).toBeInTheDocument();
  });

  it('接管后推送 user 态 → 再回 agent（模拟释放）→ overlay 重挂（完整状态机回环）', async () => {
    takeoverMock.mockResolvedValue(undefined);
    const { push } = armOnBrowserState();
    getStateMock.mockResolvedValue(mkState({ takeover: 'agent' }));
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByTestId('browser-takeover-overlay');

    fireEvent.mouseDown(screen.getByTestId('browser-takeover-overlay'));
    await waitFor(() => expect(takeoverMock).toHaveBeenCalled());
    expect(screen.queryByTestId('browser-takeover-overlay')).not.toBeInTheDocument();

    push(mkState({ takeover: 'user' })); // 接管生效
    push(mkState({ takeover: 'agent' })); // 释放
    expect(await screen.findByTestId('browser-takeover-overlay')).toBeInTheDocument();
  });

  it('takeover IPC 拒绝 → overlay 重挂（错误路径：失败不永久锁死入口）', async () => {
    takeoverMock.mockRejectedValue(new Error('ws 未激活'));
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByTestId('browser-takeover-overlay');

    fireEvent.mouseDown(screen.getByTestId('browser-takeover-overlay'));
    await waitFor(() => expect(takeoverMock).toHaveBeenCalled());
    // 拒绝后 overlay 回来——用户可重试
    expect(await screen.findByTestId('browser-takeover-overlay')).toBeInTheDocument();
  });

  it('takeover 仅首次 mousedown 触发（overlay 移除后重复点击不重复调 IPC）', async () => {
    takeoverMock.mockResolvedValue(undefined);
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByTestId('browser-takeover-overlay');
    fireEvent.mouseDown(screen.getByTestId('browser-takeover-overlay'));
    await waitFor(() => expect(takeoverMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('browser-takeover-overlay')).not.toBeInTheDocument();
  });
});

describe('BrowserSidebar·释放与 tabs / 探活接线', () => {
  it('「释放」→ releaseTakeover(w1)', async () => {
    releaseTakeoverMock.mockResolvedValue(undefined);
    getStateMock.mockResolvedValue(mkState({ takeover: 'user' }));
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByRole('button', { name: '释放' });
    fireEvent.click(screen.getByRole('button', { name: '释放' }));
    await waitFor(() => expect(releaseTakeoverMock).toHaveBeenCalledWith('w1'));
  });

  it('「+」→ openTab(w1) → 成功后 switchTab 到新 tab 下标（brief：openTab(about:blank 引导) → switchTab）', async () => {
    openTabMock.mockResolvedValue([
      { index: 0, url: 'https://example.com/', title: 'Example' },
      { index: 1, url: 'about:blank', title: '' },
    ]);
    switchTabMock.mockResolvedValue([]);
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');

    fireEvent.click(screen.getByRole('button', { name: '新建标签页' }));
    await waitFor(() => expect(openTabMock).toHaveBeenCalledWith('w1'));
    await waitFor(() => expect(switchTabMock).toHaveBeenCalledWith('w1', 1));
  });

  it('关闭钮 → closeTab(w1, index)', async () => {
    closeTabMock.mockResolvedValue([]);
    getStateMock.mockResolvedValue(
      mkState({
        tabs: [
          { index: 0, url: 'https://a.com/', title: 'A 页' },
          { index: 1, url: 'https://b.com/', title: 'B 页' },
        ],
      }),
    );
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('B 页');
    fireEvent.click(screen.getByRole('button', { name: '关闭 B 页' }));
    await waitFor(() => expect(closeTabMock).toHaveBeenCalledWith('w1', 1));
  });

  it('点击 tab → switchTab(w1, index)', async () => {
    switchTabMock.mockResolvedValue([]);
    getStateMock.mockResolvedValue(
      mkState({
        tabs: [
          { index: 0, url: 'https://a.com/', title: 'A 页' },
          { index: 1, url: 'https://b.com/', title: 'B 页' },
        ],
        current: 0,
      }),
    );
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('B 页');
    fireEvent.click(screen.getByRole('tab', { name: 'B 页' }));
    await waitFor(() => expect(switchTabMock).toHaveBeenCalledWith('w1', 1));
  });

  it('探活下拉点击存活项 → userNavigate(w1, url)', async () => {
    listDevServersMock.mockResolvedValue([{ port: 5173, url: 'http://localhost:5173' }]);
    userNavigateMock.mockResolvedValue({ url: 'http://localhost:5173', title: '' });
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');

    fireEvent.click(screen.getByRole('button', { name: '开发服务器' }));
    const item = await screen.findByText('http://localhost:5173');
    fireEvent.click(item);
    await waitFor(() => expect(userNavigateMock).toHaveBeenCalledWith('w1', 'http://localhost:5173'));
  });

  it('openTab 拒绝（user 态 BrowserTakenOverError 场景）→ 不崩、chrome 仍可用（错误路径）', async () => {
    openTabMock.mockRejectedValue(new Error('浏览器已被用户接管'));
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');
    fireEvent.click(screen.getByRole('button', { name: '新建标签页' }));
    await waitFor(() => expect(openTabMock).toHaveBeenCalled());
    // chrome 仍可用（地址栏在、折叠钮在）
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '折叠浏览器侧栏' })).toBeInTheDocument();
  });
});
