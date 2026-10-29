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
import { humanizeViewError, useHubViewStore, VIEW_PAGE_SIZE } from './hub-view.store';
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
    viewWorkspaces: vi.fn(),
    viewFiles: vi.fn(),
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

/** utf-8 正确 base64（jsdom btoa 拒 Latin1 外字符——先经 TextEncoder 编码字节） */
function b64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
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
  api.hub.viewWorkspaces.mockResolvedValue({ workspaces: [] });
  api.hub.viewFiles.mockResolvedValue({ entries: [], truncated: false });
  useHubViewStore.setState({
    open: false, picking: false,
    pickerRemote: false, pickerWorkspaces: null, remoteLoading: false,
    targetNodeId: null, targetName: null,
    workspaceId: null, workspaceName: null, groupId: null, tab: 'overview',
    overview: null, sessions: [], tasks: [],
    files: { dirs: {}, preview: null, loadingDir: null, loadingFile: null, error: null },
    loading: false, error: null, replay: null,
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

// ── M4.1 humanizeViewError 双路径（code 优先 + 子串回落双保险）─────────────────
describe('humanizeViewError（M4.1 错误契约）', () => {
  it('code 驱动：[node_offline] 前缀 → 人话（措辞不含「不在线/离线」子串也命中——不再依赖 hub 措辞）', () => {
    expect(humanizeViewError(new Error('[node_offline] 目标节点处理期间掉线了')))
      .toBe('目标节点不在线——连接恢复后可重试');
  });

  it('forbidden 两义不入码表：consent 关闭文 → 开关人话；同组校验文 → 剥前缀原文（不错标）', () => {
    expect(humanizeViewError(new Error('[forbidden] 目标节点已关闭本组查看')))
      .toBe('对方节点关闭了本组查看——可在其「设置 → 节点互联」重新开启');
    expect(humanizeViewError(new Error('[forbidden] 仅组长可远程查看目标节点（需与其同组）')))
      .toBe('仅组长可远程查看目标节点（需与其同组）');
  });

  it('子串回落（双保险不删）：无前缀旧形态 → 既有子串匹配文案不变', () => {
    expect(humanizeViewError(new Error('目标节点已关闭本组查看')))
      .toBe('对方节点关闭了本组查看——可在其「设置 → 节点互联」重新开启');
    expect(humanizeViewError(new Error('目标节点不在线')))
      .toBe('目标节点不在线——连接恢复后可重试');
  });

  it('未知码 / 无既有人话的码：剥前缀原文呈现（与迁移前一致，前缀是传输编码非用户可读）', () => {
    expect(humanizeViewError(new Error('[not_found] 工作空间不存在: ghost')))
      .toBe('工作空间不存在: ghost');
    expect(humanizeViewError(new Error('目录不存在或不可访问: ghost')))
      .toBe('目录不存在或不可访问: ghost');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// M3.2（协议 1.4.0）：groupId 透传 + openRemotePick + files 子域
// ────────────────────────────────────────────────────────────────────────────

describe('M3.2 groupId 透传（铁律 5：路由目标用当前上下文）', () => {
  it('openPanel 带 groupId → 三发/订阅/退订载荷一律携带；缺省 → 旧形状零变化', async () => {
    useHubViewStore.getState().openPanel({
      targetNodeId: 'node-b', targetName: 'studio-mini',
      workspaces: [{ id: 'ws-1', name: 'product-dev' }], groupId: 'g-dev',
    });
    await vi.waitFor(() => expect(useHubViewStore.getState().overview).not.toBeNull());
    expect(api.hub.viewWorkspace).toHaveBeenCalledWith({ targetNodeId: 'node-b', workspaceName: 'product-dev', groupId: 'g-dev' });
    expect(api.hub.viewSessions).toHaveBeenCalledWith({ targetNodeId: 'node-b', workspaceName: 'product-dev', limit: 50, groupId: 'g-dev' });
    expect(api.hub.viewTasks).toHaveBeenCalledWith({ targetNodeId: 'node-b', workspaceName: 'product-dev', groupId: 'g-dev' });

    await enterReplay(3);
    expect(api.hub.viewMessages).toHaveBeenLastCalledWith({
      targetNodeId: 'node-b', sessionId: 'sess-1', workspaceName: 'product-dev',
      fromSeq: 1, limit: VIEW_PAGE_SIZE, groupId: 'g-dev',
    });
    expect(api.hub.viewSubscribe).toHaveBeenCalledWith({ targetNodeId: 'node-b', sessionId: 'sess-1', groupId: 'g-dev' });
    useHubViewStore.getState().leaveReplay();
    await vi.waitFor(() => expect(api.hub.viewUnsubscribe).toHaveBeenCalledWith({ targetNodeId: 'node-b', sessionId: 'sess-1', groupId: 'g-dev' }));

    // 缺省回落：不携带 groupId（1.3 旧调用形状零变化锁）
    useHubViewStore.getState().openPanel({
      targetNodeId: 'node-c', targetName: 'n', workspaces: [{ id: 'ws-9', name: 'w9' }],
    });
    await vi.waitFor(() => expect(api.hub.viewWorkspace).toHaveBeenLastCalledWith({ targetNodeId: 'node-c', workspaceName: 'w9' }));
    const last = vi.mocked(api.hub.viewWorkspace).mock.calls.at(-1)![0] as Record<string, unknown>;
    expect('groupId' in last).toBe(false);
  });
});

describe('M3.2 openRemotePick 远端清单前置步', () => {
  it('多空间：viewWorkspaces 带 groupId → pickerWorkspaces 落地、picking 保持（选择器渲染远端行）', async () => {
    api.hub.viewWorkspaces.mockResolvedValue({
      workspaces: [
        { id: 'rws-1', name: 'remote-lab', description: '远端主战场' },
        { id: 'rws-2', name: 'remote-docs', description: '' },
      ],
    });
    useHubViewStore.getState().openRemotePick({ targetNodeId: 'node-b', targetName: 'studio-mini', groupId: 'g-dev' });
    expect(useHubViewStore.getState().picking).toBe(true);
    expect(useHubViewStore.getState().pickerRemote).toBe(true);
    expect(useHubViewStore.getState().remoteLoading).toBe(true);
    expect(api.hub.viewWorkspaces).toHaveBeenCalledWith({ targetNodeId: 'node-b', groupId: 'g-dev' });

    await vi.waitFor(() => expect(useHubViewStore.getState().remoteLoading).toBe(false));
    expect(useHubViewStore.getState().pickerWorkspaces).toEqual([
      { id: 'rws-1', name: 'remote-lab' },
      { id: 'rws-2', name: 'remote-docs' },
    ]);
    expect(useHubViewStore.getState().picking).toBe(true); // 多空间仍选择
    expect(api.hub.viewWorkspace).not.toHaveBeenCalled(); // 未选中不拉概览
  });

  it('单空间：自动直达 → loadAll 三发（groupId 继续透传）', async () => {
    api.hub.viewWorkspaces.mockResolvedValue({ workspaces: [{ id: 'rws-1', name: 'remote-lab', description: '' }] });
    useHubViewStore.getState().openRemotePick({ targetNodeId: 'node-b', targetName: 'studio-mini', groupId: 'g-dev' });
    await vi.waitFor(() => expect(useHubViewStore.getState().workspaceName).toBe('remote-lab'));
    expect(useHubViewStore.getState().picking).toBe(false);
    expect(api.hub.viewWorkspace).toHaveBeenCalledWith({ targetNodeId: 'node-b', workspaceName: 'remote-lab', groupId: 'g-dev' });
  });

  it('失败：人话落 error + 清单空（选择器空态而非死等）；groupId 缺省不携带', async () => {
    api.hub.viewWorkspaces.mockRejectedValue(new Error('目标节点已关闭本组查看'));
    useHubViewStore.getState().openRemotePick({ targetNodeId: 'node-b', targetName: 'studio-mini', groupId: null });
    await vi.waitFor(() => expect(useHubViewStore.getState().remoteLoading).toBe(false));
    expect(api.hub.viewWorkspaces).toHaveBeenCalledWith({ targetNodeId: 'node-b' });
    expect(useHubViewStore.getState().pickerWorkspaces).toEqual([]);
    expect(useHubViewStore.getState().error).toBe('对方节点关闭了本组查看——可在其「设置 → 节点互联」重新开启');
  });

  it('pickWorkspace 从远端行选中 → 清远端选择态 + loadAll', async () => {
    api.hub.viewWorkspaces.mockResolvedValue({
      workspaces: [
        { id: 'rws-1', name: 'remote-lab', description: '' },
        { id: 'rws-2', name: 'remote-docs', description: '' },
      ],
    });
    useHubViewStore.getState().openRemotePick({ targetNodeId: 'node-b', targetName: 'studio-mini', groupId: 'g-dev' });
    await vi.waitFor(() => expect(useHubViewStore.getState().pickerWorkspaces).not.toBeNull());
    useHubViewStore.getState().pickWorkspace('rws-2', 'remote-docs');
    expect(useHubViewStore.getState().picking).toBe(false);
    expect(useHubViewStore.getState().pickerWorkspaces).toBeNull();
    await vi.waitFor(() => expect(api.hub.viewWorkspace).toHaveBeenCalledWith({ targetNodeId: 'node-b', workspaceName: 'remote-docs', groupId: 'g-dev' }));
  });
});

describe('M3.2 files 子域（目录懒加载 + 文件预览）', () => {
  function openWorkspace(): void {
    useHubViewStore.getState().openPanel({
      targetNodeId: 'node-b', targetName: 'studio-mini',
      workspaces: [{ id: 'ws-1', name: 'product-dev' }], groupId: 'g-dev',
    });
  }

  it('loadFilesDir：根（path 省略）→ 子目录（path 携带、斜杠拼接）；重复加载幂等；truncated 落域', async () => {
    openWorkspace();
    api.hub.viewFiles.mockResolvedValueOnce({
      entries: [{ name: 'docs', isDirectory: true, size: 0 }, { name: 'README.md', isDirectory: false, size: 12 }],
      truncated: false,
    });
    await useHubViewStore.getState().loadFilesDir('.');
    expect(api.hub.viewFiles).toHaveBeenCalledWith({ targetNodeId: 'node-b', workspaceName: 'product-dev', op: 'list', groupId: 'g-dev' });
    expect(useHubViewStore.getState().files.dirs['.']?.entries.map((e) => e.name)).toEqual(['docs', 'README.md']);

    api.hub.viewFiles.mockResolvedValueOnce({ entries: [{ name: 'a.txt', isDirectory: false, size: 3 }], truncated: true });
    await useHubViewStore.getState().loadFilesDir('docs');
    expect(api.hub.viewFiles).toHaveBeenLastCalledWith({ targetNodeId: 'node-b', workspaceName: 'product-dev', op: 'list', path: 'docs', groupId: 'g-dev' });
    expect(useHubViewStore.getState().files.dirs['docs']?.truncated).toBe(true);

    // 幂等：已加载目录不重复拉
    await useHubViewStore.getState().loadFilesDir('docs');
    expect(api.hub.viewFiles).toHaveBeenCalledTimes(2);
  });

  it('openFilePreview：文本 base64 解码 + truncated 落域；关闭清空', async () => {
    openWorkspace();
    const text = '# 项目\n你好世界';
    api.hub.viewFiles.mockResolvedValueOnce({ content: b64(text), size: text.length, truncated: false });
    await useHubViewStore.getState().openFilePreview('README.md');
    expect(api.hub.viewFiles).toHaveBeenCalledWith({ targetNodeId: 'node-b', workspaceName: 'product-dev', op: 'read', path: 'README.md', groupId: 'g-dev' });
    const preview = useHubViewStore.getState().files.preview;
    expect(preview).toMatchObject({ path: 'README.md', content: text, size: text.length, truncated: false, binary: false });

    useHubViewStore.getState().closeFilePreview();
    expect(useHubViewStore.getState().files.preview).toBeNull();
  });

  it('openFilePreview：二进制（utf-8 roundtrip 不一致）→ binary=true 且 content 空', async () => {
    openWorkspace();
    // PNG 头 + 非法续字节：utf-8 解码再编码必与原字节不一致（与 file:readForEditor 同判据）
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x81]);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    api.hub.viewFiles.mockResolvedValueOnce({ content: btoa(bin), size: bytes.length, truncated: false });
    await useHubViewStore.getState().openFilePreview('logo.png');
    expect(useHubViewStore.getState().files.preview).toMatchObject({ path: 'logo.png', content: '', binary: true });
  });

  it('错误路径：list/read 失败 → files.error 人话（不吞）；面板重开清域', async () => {
    openWorkspace();
    api.hub.viewFiles.mockRejectedValue(new Error('目录不存在或不可访问: ghost'));
    await useHubViewStore.getState().loadFilesDir('ghost');
    expect(useHubViewStore.getState().files.error).toBe('目录不存在或不可访问: ghost');
    expect(useHubViewStore.getState().files.loadingDir).toBeNull();

    // 重开面板 files 域清零（无跨目标残留）
    useHubViewStore.getState().openPanel({
      targetNodeId: 'node-c', targetName: 'n', workspaces: [{ id: 'ws-2', name: 'w2' }],
    });
    expect(useHubViewStore.getState().files).toEqual({ dirs: {}, preview: null, loadingDir: null, loadingFile: null, error: null });
  });

  it('refresh（文件页）：目录树整域重载（根重拉、旧目录清空）', async () => {
    openWorkspace();
    api.hub.viewFiles.mockResolvedValue({ entries: [], truncated: false });
    await useHubViewStore.getState().loadFilesDir('.');
    await useHubViewStore.getState().loadFilesDir('docs');
    expect(Object.keys(useHubViewStore.getState().files.dirs).sort()).toEqual(['.', 'docs']);

    useHubViewStore.setState({ tab: 'files' });
    await useHubViewStore.getState().refresh();
    expect(Object.keys(useHubViewStore.getState().files.dirs)).toEqual(['.']);
    expect(api.hub.viewFiles).toHaveBeenLastCalledWith({ targetNodeId: 'node-b', workspaceName: 'product-dev', op: 'list', groupId: 'g-dev' });
  });
});
