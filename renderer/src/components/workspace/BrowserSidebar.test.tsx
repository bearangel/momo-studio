// renderer/src/components/workspace/BrowserSidebar.test.tsx
//
// BrowserSidebar 集成测试（v2.7 Task 8，spec §3.5；归属制 2026-09-15 改造）：
//   - 挂载拉 getState 渲染（tabs / 当前 url / 标题 / takeover / trusted）
//   - 订阅 onBrowserState 增量更新（非本 workspace 推送忽略）；卸载清理订阅
//   - 可见性（per-session，spec §9.1）：收起 → setSidebarVisible(w1,false) 且只剩
//     竖条展开钮；再点展开；新会话缺省收起；挂载 / visible 变化主动重报（M-1）
//   - expandHint 条件展开（spec §7.3）：活跃会话隐藏中收到 agent 导航推送 → 自动展开
//   - 空态（无 tab）→ 引导文案 + 地址栏可用
//   - 占位区上报锁：ResizeObserver + window resize → getBoundingClientRect →
//     setSidebarBounds（rect 参数来自 getBoundingClientRect）；卸载 disconnect；
//     隐藏态不上报（隐藏过渡帧一次性零报除外）
//   - TabsBar / DevServerDropdown IPC 接线（openTab→switchTab / closeTab / userNavigate）
//   - 宽度受控 / 拖拽 / 键盘（280-720）：getSettings 还原（含越界钳制）；
//     左缘手柄 pointerdown → window pointermove 实时变宽 → pointerup 单次落库；
//     双向钳制；ArrowLeft/Right ±16 + Home/End 逐键落库；拖拽与还原竞速守卫；
//     隐藏竖条不受宽度受控化影响
//
// v2.7 review fix C2 移除「鼠标接管 overlay」describe 块：接管唯一入口是 main 进程
// 原生 overlay view（view-factory.ts showOverlay），OS 合成层序 native overlay →
// browser view → renderer DOM，DOM 层永远收不到 mousedown——原 jsdom fireEvent
// 测试属「假绿」（jsdom 无原生 overlay 竞态即断言通过）。接管契约在 view-factory.test.ts
// 「showOverlay 三态锁」+「overlay 命中链」段覆盖。
// mock 形态照抄 SandboxNotice.test.tsx（globalThis.window.api 桩 + ipc Proxy 透传）；
// ResizeObserver 为平台边界桩（jsdom 不提供且不执行布局）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { BrowserSidebar, parseOwnerAgentId } from './BrowserSidebar';
import type { BrowserState, BrowserSettings, BrowserTabInfo, SessionSummary } from '../../ipc/types';
import { useBrowserSidebarRectStore } from '../../stores/browser-sidebar-rect.store';
import { useBrowserVisibilityStore } from '../../stores/browser-visibility.store';
import { useSessionStore } from '../../stores/session.store';

// ---------- window.api 桩（browser 命名空间全方法） ----------
const getStateMock = vi.fn();
const userNavigateMock = vi.fn();
const releaseTakeoverMock = vi.fn();
const openTabMock = vi.fn();
const closeTabMock = vi.fn();
const switchTabMock = vi.fn();
const setSidebarBoundsMock = vi.fn();
const setSidebarVisibleMock = vi.fn();
const listDevServersMock = vi.fn();
const getSettingsMock = vi.fn();
const updateSettingsMock = vi.fn();
const onBrowserStateMock = vi.fn();
const onBrowserNoticeMock = vi.fn();

const mockApi = {
  browser: {
    getState: getStateMock,
    userNavigate: userNavigateMock,
    // takeover IPC 仍由 main 进程原生 overlay 命中触发；renderer 不再调用——移除 mock
    // 后保留调用计数能力以备未来 IPC 回归（v2.7 review fix C2：接管路径不再走 renderer）
    releaseTakeover: releaseTakeoverMock,
    openTab: openTabMock,
    closeTab: closeTabMock,
    switchTab: switchTabMock,
    setSidebarBounds: setSidebarBoundsMock,
    setSidebarVisible: setSidebarVisibleMock,
    listDevServers: listDevServersMock,
    getSettings: getSettingsMock,
    updateSettings: updateSettingsMock,
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
    tabs: [{ index: 0, url: 'https://example.com/', title: 'Example', owner: 'user' }],
    current: 0,
    url: 'https://example.com/',
    title: 'Example',
    takeover: 'agent',
    trusted: true,
    expandHint: false,
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

/** 会话摘要工厂（purgeStale effect 消费 sessions 时的最小形状） */
function mkSession(id: string): SessionSummary {
  return {
    id,
    workspaceId: 'w1',
    title: `会话 ${id}`,
    titleAuto: true,
    kind: 'chat',
    lastMessageAt: null,
    members: [],
  };
}

beforeEach(() => {
  for (const m of [
    getStateMock, userNavigateMock, releaseTakeoverMock, openTabMock,
    closeTabMock, switchTabMock, setSidebarBoundsMock, setSidebarVisibleMock,
    listDevServersMock, getSettingsMock, updateSettingsMock, onBrowserStateMock, onBrowserNoticeMock,
  ]) {
    m.mockReset();
  }
  // 默认返回值对齐真实 invoke 语义（恒返回 Promise）——momo-test-rules 保真度
  getStateMock.mockResolvedValue(mkState());
  userNavigateMock.mockResolvedValue({ url: '', title: '' });
  releaseTakeoverMock.mockResolvedValue(undefined);
  openTabMock.mockResolvedValue([]);
  closeTabMock.mockResolvedValue([]);
  switchTabMock.mockResolvedValue([]);
  setSidebarBoundsMock.mockResolvedValue(undefined);
  setSidebarVisibleMock.mockResolvedValue(undefined);
  listDevServersMock.mockResolvedValue([]);
  getSettingsMock.mockResolvedValue(mkSettings());
  updateSettingsMock.mockResolvedValue({ ok: true });
  onBrowserStateMock.mockReturnValue(() => {});
  ResizeObserverStub.instances = [];
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  // 可见性默认态：活跃会话 s1 已展开——保持既有用例的「展开态」前提。
  // 需要缺省收起语义的用例自行重置 visibilityBySession。
  useSessionStore.setState({ activeSessionId: 's1', sessions: [mkSession('s1')] });
  useBrowserVisibilityStore.setState({ visibilityBySession: { s1: true } });
});

describe('BrowserSidebar·状态渲染（v2.7 Task 8）', () => {
  it('挂载调 getState(workspaceId) 并渲染 tabs / 当前 url / 标题 / takeover / trusted', async () => {
    getStateMock.mockResolvedValue(
      mkState({
        takeover: 'user',
        trusted: false,
        url: 'https://a.com/',
        title: '站点 A',
        tabs: [{ index: 0, url: 'https://a.com/', title: '站点 A', owner: 'user' }],
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
      { index: 0, url: 'https://example.com/', title: 'Example', owner: 'user' },
      { index: 1, url: 'https://new.com/', title: '新页面', owner: 'user' },
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

  it('非本 workspace 的推送被忽略（manager 只保证单活跃 ws——契约防御；负断言配正对照）', async () => {
    const { push } = armOnBrowserState();
    getStateMock.mockResolvedValue(mkState());
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');

    // 负推送：异 ws 快照不覆盖当前显示（push 由 act 包装，handler 同步 flush）
    push({ ...mkState({ url: 'https://other.com/', title: '别家' }), workspaceId: 'w2' });
    await Promise.resolve();
    expect(screen.queryByText('别家')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('https://example.com/');

    // 正对照：本 ws 推送 → 显示确实更新——证明订阅 handler 管道在运转
    //（tab 标题渲染来自 tabs[].title，与顶层 title 同步换）
    push(
      mkState({
        url: 'https://switched.com/',
        title: '本家更新',
        tabs: [{ index: 0, url: 'https://switched.com/', title: '本家更新', owner: 'user' }],
      }),
    );
    expect(await screen.findByText('本家更新')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('https://switched.com/');
  });

  it('卸载 → onBrowserState 解订阅被调（sidebar 自身订阅，卸载清理）', async () => {
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
    // 接管唯一入口是 main 进程原生 overlay（view-factory.ts showOverlay）——jsdom 无合成层，
    // 任何 DOM 级接管断言都属假绿；接管契约在 view-factory.test.ts「showOverlay 三态锁」覆盖。

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'https://typed.com/' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(userNavigateMock).toHaveBeenCalledWith('w1', 'https://typed.com/'));
  });

  it('空态 → 占位区 mousedown 不触发 takeover（review fix：不误接管空浏览器，agent 工具不被锁死；负断言配正对照）', async () => {
    // 接管走 main 原生 overlay，DOM 层无接管 div；占位区点击事件不应触达任何 takeover
    // IPC——空态若误触接管，agent 工具立即失败（user 态 TakenOver）+ 用户接管空浏览器无意义。
    armOnBrowserState();
    getStateMock.mockResolvedValue(mkState({ tabs: [], url: '', title: '' }));
    render(<BrowserSidebar workspaceId="w1" />);
    expect(await screen.findByText('浏览器待命')).toBeInTheDocument();

    // 负断言：mousedown 同步派发，无 IPC 副作用即计数不动（仅挂载时拉过一次）
    fireEvent.mouseDown(screen.getByTestId('browser-placeholder'));
    await Promise.resolve();
    expect(getStateMock).toHaveBeenCalledTimes(1);
    // 正对照：同页面内真实 IPC 入口（新建 tab）计数会增长——证明「事件 → IPC mock」
    // 管道活着，上面计数不变才是「mousedown 无副作用」而非 mock 失联
    fireEvent.click(screen.getByRole('button', { name: '新建标签页' }));
    await waitFor(() => expect(openTabMock).toHaveBeenCalledWith('w1'));
  });
});

describe('BrowserSidebar·可见性切换（归属制 spec §6.3 / §9.1）', () => {
  it('收起钮 → setSidebarVisible(w1,false)；组件只剩竖条展开钮（无地址栏/占位区）', async () => {
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');

    fireEvent.click(screen.getByRole('button', { name: '折叠浏览器侧栏' }));
    await waitFor(() => expect(setSidebarVisibleMock).toHaveBeenCalledWith('w1', false));
    expect(screen.queryByTestId('browser-placeholder')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '展开浏览器侧栏' })).toBeInTheDocument();
  });

  it('竖条展开钮 → setSidebarVisible(w1,true) + 占位区回归', async () => {
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');
    fireEvent.click(screen.getByRole('button', { name: '折叠浏览器侧栏' }));
    await screen.findByRole('button', { name: '展开浏览器侧栏' });

    fireEvent.click(screen.getByRole('button', { name: '展开浏览器侧栏' }));
    await waitFor(() => expect(setSidebarVisibleMock).toHaveBeenCalledWith('w1', true));
    expect(screen.getByTestId('browser-placeholder')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('挂载 / visible 变化主动重报可见性（M-1：main 的 viewsHidden 不跨 ws 激活往返保持，renderer 是真相源）', async () => {
    const { rerender } = render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');
    // 挂载即重报当前态（s1 可见 → true）——隐藏中的 ws 切走再切回不至于以 lastRect 浮出
    await waitFor(() => expect(setSidebarVisibleMock).toHaveBeenCalledWith('w1', true));

    // 切 ws：同一 effect 以新 workspaceId 重报
    rerender(<BrowserSidebar workspaceId="w2" />);
    await waitFor(() => expect(setSidebarVisibleMock).toHaveBeenCalledWith('w2', true));
  });

  it('expandHint 推送（活跃会话隐藏中，agent 导航）→ 本会话自动展开（spec §7.3）', async () => {
    const { push } = armOnBrowserState();
    // 活跃会话 s1 无可见性记录（缺省收起）——挂载即竖条
    useBrowserVisibilityStore.setState({ visibilityBySession: {} });
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByRole('button', { name: '展开浏览器侧栏' });

    push(mkState({ url: 'https://agent-opened.com/', title: 'Agent 打开', expandHint: true }));
    // 整个浏览器展开：地址栏 + 占位区回归，竖条展开钮消失
    expect(await screen.findByRole('textbox')).toHaveValue('https://agent-opened.com/');
    expect(screen.getByTestId('browser-placeholder')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '展开浏览器侧栏' })).not.toBeInTheDocument();
    // 展开联动 main：M-1 effect 重报可见
    await waitFor(() => expect(setSidebarVisibleMock).toHaveBeenCalledWith('w1', true));
  });

  it('expandHint=false 推送不展开；紧接 expandHint=true 正对照展开（负断言配正对照——固定 sleep 反模式修复）', async () => {
    const { push } = armOnBrowserState();
    useBrowserVisibilityStore.setState({ visibilityBySession: {} });
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByRole('button', { name: '展开浏览器侧栏' });

    // 负推送：普通状态推送（expandHint=false）无自动展开副作用。
    // push 由 act 包装，handler 同步 flush——微任务一拍即尘埃落定，无需固定 sleep
    push(mkState({ url: 'https://example.com/', title: 'Example', expandHint: false }));
    await Promise.resolve();
    expect(screen.queryByTestId('browser-placeholder')).not.toBeInTheDocument();
    expect(useBrowserVisibilityStore.getState().isVisible('s1')).toBe(false);

    // 正对照：同测试内推 expandHint=true → 展开确实发生。正对照触发即证明
    // effect 循环已运转，前面的负断言才是可信的「已执行且未误触发」
    push(mkState({ url: 'https://example.com/', title: 'Example', expandHint: true }));
    expect(await screen.findByTestId('browser-placeholder')).toBeInTheDocument();
    expect(useBrowserVisibilityStore.getState().isVisible('s1')).toBe(true);
  });

  it('非活跃会话收起记忆独立：切到 s2（无记录）→ 竖条；切回 s1 → 仍展开', async () => {
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');

    act(() => {
      useSessionStore.setState({ activeSessionId: 's2', sessions: [mkSession('s1'), mkSession('s2')] });
    });
    expect(await screen.findByRole('button', { name: '展开浏览器侧栏' })).toBeInTheDocument();

    act(() => {
      useSessionStore.setState({ activeSessionId: 's1' });
    });
    expect(await screen.findByText('Example')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '展开浏览器侧栏' })).not.toBeInTheDocument();
  });
});

describe('BrowserSidebar·可见性初始态（per-session，spec §9.1）', () => {
  it('新会话（无可见性记录）缺省收起：竖条展开钮，无地址栏/占位区', async () => {
    useBrowserVisibilityStore.setState({ visibilityBySession: {} });
    render(<BrowserSidebar workspaceId="w1" />);
    const expand = await screen.findByRole('button', { name: '展开浏览器侧栏' });
    expect(expand).toBeInTheDocument();
    expect(screen.queryByTestId('browser-placeholder')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    // 初始收起由 M-1 effect 上报 main（隐藏 = bounds 置零不销毁）
    await waitFor(() => expect(setSidebarVisibleMock).toHaveBeenCalledWith('w1', false));
  });

  it('非会话视图（activeSessionId=null）同样收起（isVisible(null)=false 安全缺省）', async () => {
    useSessionStore.setState({ activeSessionId: null, sessions: [] });
    useBrowserVisibilityStore.setState({ visibilityBySession: {} });
    render(<BrowserSidebar workspaceId="w1" />);
    expect(await screen.findByRole('button', { name: '展开浏览器侧栏' })).toBeInTheDocument();
    expect(screen.queryByTestId('browser-placeholder')).not.toBeInTheDocument();
  });

  it('落库 sidebarCollapsed 不再影响初始可见性（per-session store 是唯一真相源，getSettings 只管宽度）', async () => {
    getSettingsMock.mockResolvedValue(mkSettings({ sidebarCollapsed: true, sidebarWidth: 520 }));
    render(<BrowserSidebar workspaceId="w1" />);
    // s1 有可见记录（beforeEach 默认 true）→ 仍展开；落库折叠值被忽略
    await waitFor(() =>
      expect(screen.getByTestId('browser-sidebar')).toHaveStyle({ width: '520px' }),
    );
    expect(screen.getByTestId('browser-placeholder')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('会话删除（sessions 剔除）→ purgeStale 清理条目，该会话回缺省收起', async () => {
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');

    act(() => {
      // s1 从会话列表消失（删除）→ purgeStale(['s2', ...]) 场景下 s1 条目被清
      useSessionStore.setState({ sessions: [mkSession('s2')] });
    });
    expect(await screen.findByRole('button', { name: '展开浏览器侧栏' })).toBeInTheDocument();
    expect(useBrowserVisibilityStore.getState().isVisible('s1')).toBe(false);
  });

  it('getSettings 拒绝 → 宽度回默认 + chrome 骨架照常（初始态是体验性增强，不阻塞）', async () => {
    getSettingsMock.mockRejectedValue(new Error('boot 早期通道未就绪'));
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');
    expect(screen.getByTestId('browser-placeholder')).toBeInTheDocument();
    expect(screen.getByTestId('browser-sidebar')).toHaveStyle({ width: '380px' });
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

  it('卸载 → ResizeObserver disconnect + window resize 监听移除（负断言配正对照）', async () => {
    const { unmount } = render(<BrowserSidebar workspaceId="w1" />);
    const placeholder = await screen.findByTestId('browser-placeholder');
    await waitFor(() => expect(setSidebarBoundsMock).toHaveBeenCalled());
    const observer = ResizeObserverStub.instances[0]!;
    expect(observer.disconnected).toBe(false);

    stubRect(placeholder, { x: 11, y: 22, width: 380, height: 600 });
    // 正对照：卸载前同一 resize 事件源确实会上报——监听管道活的
    fireEvent(window, new Event('resize'));
    await waitFor(() =>
      expect(setSidebarBoundsMock).toHaveBeenLastCalledWith({ x: 11, y: 22, width: 380, height: 600 }),
    );

    unmount();
    expect(observer.disconnected).toBe(true);
    // 负断言基线在卸载零报（unmount effect 的既知上报）落账后取——
    // 此后同一事件源不再上报（report 回调同步调 mock，微任务一拍即定）
    const countBefore = setSidebarBoundsMock.mock.calls.length;
    fireEvent(window, new Event('resize'));
    await Promise.resolve();
    expect(setSidebarBoundsMock.mock.calls.length).toBe(countBefore);
  });

  it('卸载（im→files/agents 活动切换）→ 上报零尺寸 rect（view 隐藏但 tabs/状态保留）', async () => {
    const { unmount } = render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');
    setSidebarBoundsMock.mockClear();

    unmount();

    expect(setSidebarBoundsMock).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('workspaceId 变化（侧栏仍在位）不触发零尺寸上报——main 按 lastRect 缓存恢复新 ws 视图（负断言配正对照）', async () => {
    const { rerender, unmount } = render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');
    setSidebarBoundsMock.mockClear();

    // 负断言：ws 切换（effect 重挂载但占位区布局不变）不零报——
    // rerender 同步 commit，若有误零报此刻已记录，无需等
    rerender(<BrowserSidebar workspaceId="w2" />);
    await screen.findByText('Example');
    expect(setSidebarBoundsMock).not.toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 });

    // 正对照：真卸载（im→files 活动切换）零报确实发生——零报 mock 管道活着，
    // 上面「未收到零报」才是「ws 切换不零报」而非 mock 失联
    unmount();
    await waitFor(() =>
      expect(setSidebarBoundsMock).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 }),
    );
  });

  it('收起 → 隐藏过渡帧一次性零报 + 占位区卸载后 window resize 不再上报（manager 隐藏即 bounds 置零，后续无占位区则无真实 rect；负断言配正对照）', async () => {
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');
    const placeholder = screen.getByTestId('browser-placeholder');
    stubRect(placeholder, { x: 11, y: 22, width: 380, height: 600 });
    // 正对照：收起前同一 resize 事件源确实会上报——监听管道活的
    fireEvent(window, new Event('resize'));
    await waitFor(() =>
      expect(setSidebarBoundsMock).toHaveBeenLastCalledWith({ x: 11, y: 22, width: 380, height: 600 }),
    );

    fireEvent.click(screen.getByRole('button', { name: '折叠浏览器侧栏' }));
    await screen.findByRole('button', { name: '展开浏览器侧栏' });
    // 隐藏分支上报零 rect 一次（几何一致性：renderer 无占位区则无真实 rect）
    await waitFor(() =>
      expect(setSidebarBoundsMock).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 }),
    );
    // 负断言：收起后同一事件源不再上报（effect cleanup 同步移除监听，微任务一拍即定）
    const countBefore = setSidebarBoundsMock.mock.calls.length;
    fireEvent(window, new Event('resize'));
    await Promise.resolve();
    expect(setSidebarBoundsMock.mock.calls.length).toBe(countBefore);
  });
});

// ---------- 安全区生产者锁（spec 2026-09-15 §6.1 前半句，终审回填） ----------
// 教训（P0-6 同构）：消费者（CenterPromptLayer / NoticeStack）只信任 store，但
// 生产者（report() 内 setRect / 两处清理 setRect(null)）此前在本套件无任何断言——
// 重构丢掉任一写入，全套照绿、安全区静默回退全窗口、提示被原生视图盖死。
describe('BrowserSidebar·安全区生产者锁（spec §6.1）', () => {
  it('ResizeObserver 触发 → 容器 rect 写入 store（形状 {x,y,width,height}；jsdom 布局恒零不碍形状断言）', async () => {
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByTestId('browser-placeholder');
    ResizeObserverStub.instances[0]!.trigger();
    const rect = useBrowserSidebarRectStore.getState().rect;
    expect(rect).not.toBeNull();
    expect(rect).toEqual({
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    });
  });

  it('卸载 → store rect 清 null（安全区回全窗口）', async () => {
    const { unmount } = render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');
    expect(useBrowserSidebarRectStore.getState().rect).not.toBeNull();
    unmount();
    expect(useBrowserSidebarRectStore.getState().rect).toBeNull();
  });

  it('收起 → store rect 清 null（隐藏即安全区回全窗口——report effect 隐藏分支路径）', async () => {
    render(<BrowserSidebar workspaceId="w1" />);
    await screen.findByText('Example');
    expect(useBrowserSidebarRectStore.getState().rect).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '折叠浏览器侧栏' }));
    await screen.findByRole('button', { name: '展开浏览器侧栏' });
    expect(useBrowserSidebarRectStore.getState().rect).toBeNull();
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
      { index: 0, url: 'https://example.com/', title: 'Example', owner: 'user' },
      { index: 1, url: 'about:blank', title: '', owner: 'user' },
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
          { index: 0, url: 'https://a.com/', title: 'A 页', owner: 'user' },
          { index: 1, url: 'https://b.com/', title: 'B 页', owner: 'user' },
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
          { index: 0, url: 'https://a.com/', title: 'A 页', owner: 'user' },
          { index: 1, url: 'https://b.com/', title: 'B 页', owner: 'user' },
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

describe('BrowserSidebar·宽度受控 / 拖拽 / 键盘（280-720）', () => {
  it('挂载读 getSettings → sidebarWidth 落库值即容器宽度（inline style）；还原只读不写', async () => {
    getSettingsMock.mockResolvedValue(mkSettings({ sidebarWidth: 520 }));
    render(<BrowserSidebar workspaceId="w1" />);
    await waitFor(() =>
      expect(screen.getByTestId('browser-sidebar')).toHaveStyle({ width: '520px' }),
    );
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('落库宽度越界（旧库脏值防御）→ 还原时钳制回 720 上界', async () => {
    getSettingsMock.mockResolvedValue(mkSettings({ sidebarWidth: 9999 }));
    render(<BrowserSidebar workspaceId="w1" />);
    await waitFor(() =>
      expect(screen.getByTestId('browser-sidebar')).toHaveStyle({ width: '720px' }),
    );
  });

  it('拖拽（左缘手柄，向左拖 = 加宽）：down(600) → move(520) 实时 460 → up 单次落库 460', async () => {
    render(<BrowserSidebar workspaceId="w1" />);
    const handle = await screen.findByRole('separator', { name: '调整浏览器侧栏宽度' });
    expect(screen.getByTestId('browser-sidebar')).toHaveStyle({ width: '380px' });

    fireEvent.pointerDown(handle, { clientX: 600 });
    fireEvent.pointerMove(window, { clientX: 520 });
    // 拖拽中本地实时生效，不写 IPC（写释放不写拖动中）
    expect(screen.getByTestId('browser-sidebar')).toHaveStyle({ width: '460px' });
    expect(updateSettingsMock).not.toHaveBeenCalled();

    fireEvent.pointerUp(window, { clientX: 520 });
    await waitFor(() => expect(updateSettingsMock).toHaveBeenCalledTimes(1));
    expect(updateSettingsMock).toHaveBeenCalledWith('w1', { sidebarWidth: 460 });
    expect(screen.getByTestId('browser-sidebar')).toHaveStyle({ width: '460px' });
  });

  it('钳制上界：向左拖超界（380+1000）→ 720 落库', async () => {
    render(<BrowserSidebar workspaceId="w1" />);
    const handle = await screen.findByRole('separator');
    fireEvent.pointerDown(handle, { clientX: 600 });
    fireEvent.pointerMove(window, { clientX: -400 });
    fireEvent.pointerUp(window, { clientX: -400 });
    await waitFor(() =>
      expect(updateSettingsMock).toHaveBeenCalledWith('w1', { sidebarWidth: 720 }),
    );
    expect(screen.getByTestId('browser-sidebar')).toHaveStyle({ width: '720px' });
  });

  it('钳制下界：向右拖超界（380-500）→ 280 落库', async () => {
    render(<BrowserSidebar workspaceId="w1" />);
    const handle = await screen.findByRole('separator');
    fireEvent.pointerDown(handle, { clientX: 600 });
    fireEvent.pointerMove(window, { clientX: 1100 });
    fireEvent.pointerUp(window, { clientX: 1100 });
    await waitFor(() =>
      expect(updateSettingsMock).toHaveBeenCalledWith('w1', { sidebarWidth: 280 }),
    );
    expect(screen.getByTestId('browser-sidebar')).toHaveStyle({ width: '280px' });
  });

  it('键盘：ArrowLeft +16 / ArrowRight -16（左=加宽，同拖拽语义），逐键即时落库；Home/End 直达边界', async () => {
    render(<BrowserSidebar workspaceId="w1" />);
    const handle = await screen.findByRole('separator');
    const container = screen.getByTestId('browser-sidebar');

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(container).toHaveStyle({ width: '396px' });
    expect(updateSettingsMock).toHaveBeenCalledWith('w1', { sidebarWidth: 396 });

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(container).toHaveStyle({ width: '380px' });
    expect(updateSettingsMock).toHaveBeenCalledWith('w1', { sidebarWidth: 380 });

    fireEvent.keyDown(handle, { key: 'Home' });
    expect(container).toHaveStyle({ width: '280px' });
    expect(updateSettingsMock).toHaveBeenCalledWith('w1', { sidebarWidth: 280 });

    fireEvent.keyDown(handle, { key: 'End' });
    expect(container).toHaveStyle({ width: '720px' });
    expect(updateSettingsMock).toHaveBeenCalledWith('w1', { sidebarWidth: 720 });
  });

  it('拖拽先于 getSettings 返回 → 晚到的落库宽度不覆盖用户拖拽结果（还原竞速守卫）', async () => {
    let resolveSettings: (s: BrowserSettings) => void = () => {};
    getSettingsMock.mockReturnValue(
      new Promise<BrowserSettings>((res) => {
        resolveSettings = res;
      }),
    );
    render(<BrowserSidebar workspaceId="w1" />);
    const handle = await screen.findByRole('separator');

    fireEvent.pointerDown(handle, { clientX: 600 });
    fireEvent.pointerMove(window, { clientX: 540 }); // +60 → 440
    fireEvent.pointerUp(window, { clientX: 540 });

    await act(async () => {
      resolveSettings(mkSettings({ sidebarWidth: 380 }));
    });
    expect(screen.getByTestId('browser-sidebar')).toHaveStyle({ width: '440px' });
  });

  it('手柄是 chrome 列的前置兄弟（flex 行列结构）——占位区 rect 自手柄右侧起算，原生视图不再盖住手柄（bug 1）', async () => {
    render(<BrowserSidebar workspaceId="w1" />);
    const outer = await screen.findByTestId('browser-sidebar');
    const resizer = screen.getByTestId('browser-sidebar-resizer');
    const placeholder = screen.getByTestId('browser-placeholder');
    // jsdom 不执行布局，无法断言 rect 几何——锁 DOM 结构序：手柄是外层容器
    // 首个子元素（无前置兄弟），占位区所在的 chrome 列紧随其后为 next sibling
    expect(resizer.parentElement).toBe(outer);
    expect(resizer.previousElementSibling).toBeNull();
    const chromeColumn = placeholder.parentElement;
    expect(chromeColumn).toBeTruthy();
    expect(resizer.nextElementSibling).toBe(chromeColumn);
    // 手柄不得回归绝对定位：absolute 脱离文档流，4px 命中区落进占位区 rect 起点
    // 之内即被原生 WebContentsView（OS 合成层高于一切 renderer 内容）盖住——
    // z-index 无解，正是 bug 1 根因
    expect(resizer.className).not.toContain('absolute');
    expect(outer.className).not.toContain('relative');
  });

  it('缺省收起竖条不受宽度受控化影响：保持 w-10 静态宽、无手柄、无 inline width', async () => {
    getSettingsMock.mockResolvedValue(
      mkSettings({ sidebarCollapsed: true, sidebarWidth: 520 }),
    );
    useBrowserVisibilityStore.setState({ visibilityBySession: {} });
    render(<BrowserSidebar workspaceId="w1" />);
    const strip = await screen.findByTestId('browser-sidebar');
    expect(strip.className).toContain('w-10');
    expect(strip.style.width).toBe('');
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });
});

describe('parseOwnerAgentId（ownerId 复合解析，会话作用域归属键契约）', () => {
  it('复合键取首个冒号后段还原 agentInstanceId', () => {
    expect(parseOwnerAgentId('sess-1:inst-a')).toBe('inst-a');
    expect(parseOwnerAgentId('sess-uuid-2:inst-uuid-x')).toBe('inst-uuid-x');
  });
  it("'user' 与纯实例键（无会话上下文退化形）原样返回", () => {
    expect(parseOwnerAgentId('user')).toBe('user');
    expect(parseOwnerAgentId('inst-x')).toBe('inst-x');
  });
});
