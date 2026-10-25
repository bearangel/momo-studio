// renderer/src/stores/hub-view.store.test.ts
//
// hub-view store 回归锁（M2 fix round 1——回放尾页 off-by-one 丢尾事件）：
// 锁 a（集成面）单会话连续 rowid 51 条：含头窗口首页必须含 seq=lastSeq 尾事件、
//      恰 50 条、hasMore 正确——修复前 fromSeq=lastSeq-50 开窗含 51 值，服务端
//      ASC LIMIT 50 保留最低 50 条丢尾（mock 逐字复刻 view-server.ts 真实语义）
// 锁 b（公式）lastSeq=50 → fromSeq===1（含头恰 50）；lastSeq<页尺寸/空会话 →
//      fromSeq 落 1 防负边界
// 锁 c（自愈）view.messages 应答与 view.subscribe 锚定间到达的间隙事件两不沾
//      （不在页内、低于锚点永不经 tail），refreshReplay 重订+尾后补拉可见
//
// mock 纪律（momo-test-rules #4 契约测试）：viewMessages/subscribe 按服务端
// 真实语义实现（rowid >= fromSeq 升序 LIMIT n / hasMore=存在更早 / 锚定当前
// 最大 rowid），不做「方便测试」的简化——被测公式与真实 ASC LIMIT 截断的
// 相互作用正是本 bug 的根因。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHubViewStore, VIEW_PAGE_SIZE } from './hub-view.store';
import type { HubViewMessage } from '../ipc/types';

interface FakeEvent {
  seq: number;
  content: string;
}

const api = {
  hub: {
    viewWorkspace: vi.fn(),
    viewSessions: vi.fn(),
    viewMessages: vi.fn(),
    viewTasks: vi.fn(),
    viewSubscribe: vi.fn(),
    viewUnsubscribe: vi.fn(),
    onViewAppended: vi.fn(
      (_cb: (e: { sessionId: string; events: HubViewMessage[] }) => void) => () => undefined,
    ),
  },
};

function ev(seq: number, content = `事件-${seq}`): FakeEvent {
  return { seq, content };
}

function toMessage(e: FakeEvent): HubViewMessage {
  return { seq: e.seq, at: 1_700_000_000_000 + e.seq, role: 'assistant', content: e.content };
}

/** 忠实服务端语义（view-server.ts sessionEvents/assembleMessages 逐字复刻）：
 *  messages = 本会话 rowid >= fromSeq 升序 LIMIT n；hasMore = fromSeq>0 且存在
 *  rowid < fromSeq 的事件。store 消费的 fromSeq/limit 原样入查询。 */
function wireFaithfulMessages(state: { events: FakeEvent[] }): void {
  api.hub.viewMessages.mockImplementation(async (p: { fromSeq: number; limit: number }) => {
    const page = state.events
      .filter((e) => e.seq >= p.fromSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, p.limit)
      .map(toMessage);
    const hasMore = p.fromSeq > 0 && state.events.some((e) => e.seq < p.fromSeq);
    return { messages: page, hasMore };
  });
}

function openPanel(): void {
  useHubViewStore.getState().openPanel({
    targetNodeId: 'node-b',
    targetName: 'studio-mini',
    workspaces: [{ id: 'ws-1', name: 'product-dev' }],
  });
}

async function enterReplay(lastSeq: number, sessionId = 'sess-1'): Promise<void> {
  await useHubViewStore.getState().enterReplay({
    sessionId, title: `会话-${sessionId}`, lastSeq, updatedAt: Date.now(),
  });
}

function replayMessages(): HubViewMessage[] {
  return useHubViewStore.getState().replay?.messages ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { window: { api: typeof api } }).window.api = api;
  api.hub.viewWorkspace.mockResolvedValue({
    overview: { name: 'product-dev', description: '', sessionCount: 1 },
    agentMembers: [], teams: [], mcpEnabled: [], skills: [], pluginsEnabled: [],
    resourcesSummary: { agent: 0, mcp: 0, skill: 0, plugin: 0 },
  });
  api.hub.viewSessions.mockResolvedValue({ sessions: [] });
  api.hub.viewTasks.mockResolvedValue({ tasks: [] });
  api.hub.viewMessages.mockResolvedValue({ messages: [], hasMore: false });
  api.hub.viewSubscribe.mockResolvedValue({ ok: true });
  api.hub.viewUnsubscribe.mockResolvedValue({ ok: true });
  useHubViewStore.setState({
    open: false, picking: false, targetNodeId: null, targetName: null,
    workspaceId: null, workspaceName: null, tab: 'overview',
    overview: null, sessions: [], tasks: [], loading: false, error: null, replay: null,
  });
});

describe('回归锁 a：单会话连续 rowid 51 条——含头窗口首页不丢尾事件（集成面）', () => {
  it('enterReplay 后首页恰 50 条、含 seq=lastSeq 尾事件、hasMore 正确', async () => {
    // 单会话独占连续插入（M2 委派拓扑常态）——rowid 1..51 稠密
    const state = { events: Array.from({ length: 51 }, (_, i) => ev(i + 1)) };
    wireFaithfulMessages(state);
    openPanel();
    await enterReplay(51);

    const msgs = replayMessages();
    expect(msgs).toHaveLength(VIEW_PAGE_SIZE); // 修复前也是 50 条——但内容是 [1..50]
    expect(msgs[0]!.seq).toBe(2); // 窗口头 = lastSeq-49（修复前 1——开窗多含一值）
    expect(msgs[msgs.length - 1]!.seq).toBe(51); // 尾事件 seq=lastSeq 在页（修复前丢尾止于 50）
    expect(useHubViewStore.getState().replay?.hasMore).toBe(true); // seq=1 更早事件在望
    expect(useHubViewStore.getState().replay?.live).toBe(true); // 订阅在线
  });

  it('恰好 50 条事件（lastSeq=50）：全量入页且 hasMore=false（无更早）', async () => {
    const state = { events: Array.from({ length: 50 }, (_, i) => ev(i + 1)) };
    wireFaithfulMessages(state);
    openPanel();
    await enterReplay(50);
    const msgs = replayMessages();
    expect(msgs).toHaveLength(50);
    expect(msgs[0]!.seq).toBe(1);
    expect(msgs[49]!.seq).toBe(50);
    expect(useHubViewStore.getState().replay?.hasMore).toBe(false);
  });
});

describe('回归锁 b：含头窗口公式（fromSeq = lastSeq - 页尺寸 + 1，防负边界）', () => {
  it('lastSeq=50 → fromSeq===1（恰 50 含头含尾）；lastSeq=30/0 → fromSeq 落 1', async () => {
    wireFaithfulMessages({ events: [] });
    openPanel();

    await enterReplay(50);
    expect(api.hub.viewMessages).toHaveBeenLastCalledWith({
      targetNodeId: 'node-b', sessionId: 'sess-1', workspaceName: 'product-dev',
      fromSeq: 1, limit: VIEW_PAGE_SIZE,
    });

    await useHubViewStore.getState().leaveReplay();
    await enterReplay(30);
    expect(api.hub.viewMessages).toHaveBeenLastCalledWith({
      targetNodeId: 'node-b', sessionId: 'sess-1', workspaceName: 'product-dev',
      fromSeq: 1, limit: VIEW_PAGE_SIZE, // lastSeq < 页尺寸 → 防负落 1
    });

    await useHubViewStore.getState().leaveReplay();
    await enterReplay(0); // 空会话
    expect(api.hub.viewMessages).toHaveBeenLastCalledWith({
      targetNodeId: 'node-b', sessionId: 'sess-1', workspaceName: 'product-dev',
      fromSeq: 1, limit: VIEW_PAGE_SIZE,
    });
    expect(replayMessages()).toEqual([]);
    expect(useHubViewStore.getState().replay?.hasMore).toBe(false);
  });
});

describe('回归锁 c：应答-锚定间隙事件经 refreshReplay 自愈（重订 + 尾后补拉）', () => {
  it('messages 应答后/subscribe 锚定前插入事件 → 刷新后退订-重订各一次、尾后补拉可见', async () => {
    const state = { events: [ev(1), ev(2), ev(3)] };
    wireFaithfulMessages(state);
    // 忠实锚定语义：subscribe 时锚定当前最大 rowid——首次订阅前插入 seq=4，
    // 锚点=4 → tail 只投 >4 的事件，seq=4 两不沾（不在首页、永不经 tail）
    let gapInserted = false;
    api.hub.viewSubscribe.mockImplementation(async () => {
      if (!gapInserted) {
        state.events.push(ev(4, '间隙事件-4'));
        gapInserted = true;
      }
      return { ok: true };
    });
    openPanel();
    await enterReplay(3);
    expect(replayMessages().map((m) => m.seq)).toEqual([1, 2, 3]); // 间隙事件不在页内

    await useHubViewStore.getState().refreshReplay();

    // 重订语义：先 unsubscribe（清 watcher）再 subscribe（锚点重置）
    expect(api.hub.viewUnsubscribe).toHaveBeenCalledTimes(1);
    expect(api.hub.viewSubscribe).toHaveBeenCalledTimes(2);
    // 尾后补拉：从已知最后一条（3）之后起拉——间隙事件落在窗口内
    expect(api.hub.viewMessages).toHaveBeenLastCalledWith({
      targetNodeId: 'node-b', sessionId: 'sess-1', workspaceName: 'product-dev',
      fromSeq: 4, limit: VIEW_PAGE_SIZE,
    });
    expect(replayMessages().map((m) => m.seq)).toEqual([1, 2, 3, 4]); // 自愈
    expect(replayMessages()[3]!.content).toBe('间隙事件-4');
    expect(useHubViewStore.getState().replay?.live).toBe(true);
  });

  it('重订失败（旧订阅已随退订移除）→ 降级已断开呈现人话，不抛出', async () => {
    const state = { events: [ev(1)] };
    wireFaithfulMessages(state);
    openPanel();
    await enterReplay(1);
    expect(useHubViewStore.getState().replay?.live).toBe(true);

    api.hub.viewSubscribe.mockRejectedValueOnce(new Error('目标节点不在线'));
    await expect(useHubViewStore.getState().refreshReplay()).resolves.toBeUndefined();
    const st = useHubViewStore.getState();
    expect(st.replay?.live).toBe(false);
    expect(st.replay?.liveError).toBe('目标节点不在线——连接恢复后可重试');
    expect(st.loading).toBe(false);
  });

  it('非回放态 refreshReplay no-op；补拉与并发 tail 扇出按 seq 去重不双渲染', async () => {
    await expect(useHubViewStore.getState().refreshReplay()).resolves.toBeUndefined();
    expect(api.hub.viewMessages).not.toHaveBeenCalled();

    // 补拉页与 tail 扇出重叠：refreshReplay 后 appended 再投同一条 → 不重复
    const state = { events: [ev(1), ev(2)] };
    wireFaithfulMessages(state);
    let appendedCb: ((e: { sessionId: string; events: HubViewMessage[] }) => void) | null = null;
    api.hub.onViewAppended.mockImplementation((cb: (e: { sessionId: string; events: HubViewMessage[] }) => void) => {
      appendedCb = cb;
      return () => undefined;
    });
    useHubViewStore.getState().init();
    openPanel();
    await enterReplay(2);
    state.events.push(ev(3, '并发-3'));
    await useHubViewStore.getState().refreshReplay(); // 补拉到 3
    appendedCb!({ sessionId: 'sess-1', events: [toMessage(ev(3, '并发-3'))] }); // tail 重投
    expect(replayMessages().map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(replayMessages().filter((m) => m.seq === 3)).toHaveLength(1);
  });
});

describe('错误路径（momo-test-rules #3：错误不吞）', () => {
  it('enterReplay messages 失败 → 不进回放、面板级人话呈现', async () => {
    api.hub.viewMessages.mockRejectedValue(new Error('目标节点已关闭本组查看'));
    openPanel();
    // 先等打开面板的三发落定（真实运行时 loadAll 远早于用户点会话完成——
    // 否则其成功回写 error:null 会与被测错误路径竞态）
    await vi.waitFor(() => expect(useHubViewStore.getState().overview).not.toBeNull());
    await enterReplay(10);
    expect(useHubViewStore.getState().replay).toBeNull();
    expect(useHubViewStore.getState().error).toBe('对方节点关闭了本组查看——可在其「设置 → 节点互联」重新开启');
    expect(api.hub.viewSubscribe).not.toHaveBeenCalled();
  });
});
