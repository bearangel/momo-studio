// renderer/src/stores/hub-delegation.store.test.ts
//
// 委派面板 store 契约（M2e T12）：task.list 拉取 / task.progress 500ms 批合并
// （同窗多拍一条增量、终态冲刷在途批）/ 终态四推送状态迁移 / cancelled 无推送——
// 由 taskCancel 回执本地落 + 重拉对账 / 向导受理链（delegate → accepted + prompts
// 记录 + 重拉）/ 未知 taskId 事件不凭空造行。
// M4.2（协议 1.6.0）：taskList 选中组过滤双态锁（有组携带 groupId / 无组无参
// 全组聚合现状）+ 组切换重拉重入护栏（旧过滤应答不覆盖新结果）+ 组名映射缓存
// （group.list 投影 / group.changed 推送刷新 / 失败尽力而为不落 error）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDelegationBatchesForTest, humanizeDelegationReason } from './hub-delegation.store';
import type {
  HubTaskProgressEvent,
  HubTaskRecord,
  HubTaskTerminalEvent,
} from '../ipc/types';

let progressCb: ((e: HubTaskProgressEvent) => void) | undefined;
let completedCb: ((e: HubTaskTerminalEvent) => void) | undefined;
let failedCb: ((e: HubTaskTerminalEvent) => void) | undefined;
let interruptedCb: ((e: HubTaskTerminalEvent) => void) | undefined;
let groupChangedCb: (() => void) | undefined;

function task(overrides?: Partial<HubTaskRecord>): HubTaskRecord {
  return {
    taskId: 'tk-1',
    workspaceName: 'product-dev',
    targetNodeId: 'node-b',
    status: 'running',
    title: '重构登录模块的错误处理',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

const mockApi = {
  hub: {
    taskList: vi.fn(),
    taskDelegate: vi.fn(),
    taskCancel: vi.fn(),
    onTaskProgress: vi.fn((cb: (e: HubTaskProgressEvent) => void) => { progressCb = cb; return () => undefined; }),
    onTaskCompleted: vi.fn((cb: (e: HubTaskTerminalEvent) => void) => { completedCb = cb; return () => undefined; }),
    onTaskFailed: vi.fn((cb: (e: HubTaskTerminalEvent) => void) => { failedCb = cb; return () => undefined; }),
    onTaskInterrupted: vi.fn((cb: (e: HubTaskTerminalEvent) => void) => { interruptedCb = cb; return () => undefined; }),
    groupList: vi.fn(),
    onGroupChanged: vi.fn((cb: () => void) => { groupChangedCb = cb; return () => undefined; }),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  progressCb = undefined;
  completedCb = undefined;
  failedCb = undefined;
  interruptedCb = undefined;
  groupChangedCb = undefined;
  (globalThis as unknown as { window: { api: typeof mockApi } }).window = { api: mockApi };
  mockApi.hub.taskList.mockResolvedValue({ tasks: [task()] });
  mockApi.hub.groupList.mockResolvedValue({ groups: [] });
});

afterEach(() => {
  __resetDelegationBatchesForTest();
  vi.useRealTimers();
});

async function freshInit(fakeTimers = false): Promise<void> {
  const { useHubDelegationStore } = await import('./hub-delegation.store');
  useHubDelegationStore.setState({
    tasks: [], loading: false, error: null,
    streams: {}, prompts: {}, agentSlugs: {}, sessionIds: {}, reasons: {}, waiting: {},
    groupNames: {}, groupIdFilter: null,
  });
  useHubDelegationStore.getState().init();
  if (fakeTimers) {
    // 假时钟下 vi.waitFor 的轮询定时器也被冻结——用定时器推进冲微任务
    await vi.advanceTimersByTimeAsync(0);
  } else {
    await vi.waitFor(() => expect(useHubDelegationStore.getState().tasks).toHaveLength(1));
  }
}

describe('列表与事件驱动状态迁移', () => {
  it('init → 订阅四推送 + 首拉 task.list', async () => {
    await freshInit();
    const { useHubDelegationStore } = await import('./hub-delegation.store');
    expect(mockApi.hub.onTaskProgress).toHaveBeenCalledTimes(1);
    expect(mockApi.hub.onTaskCompleted).toHaveBeenCalledTimes(1);
    expect(mockApi.hub.onTaskFailed).toHaveBeenCalledTimes(1);
    expect(mockApi.hub.onTaskInterrupted).toHaveBeenCalledTimes(1);
    expect(useHubDelegationStore.getState().tasks[0]!.taskId).toBe('tk-1');
  });

  it('completed/failed{reason}/interrupted → 状态迁移；failed 附因留痕', async () => {
    await freshInit();
    const { useHubDelegationStore } = await import('./hub-delegation.store');

    completedCb!({ taskId: 'tk-1' });
    expect(useHubDelegationStore.getState().tasks[0]!.status).toBe('done');

    failedCb!({ taskId: 'tk-1', reason: 'declined:并发已达上限（2）' });
    expect(useHubDelegationStore.getState().tasks[0]!.status).toBe('failed');
    expect(useHubDelegationStore.getState().reasons['tk-1']).toBe('declined:并发已达上限（2）');

    interruptedCb!({ taskId: 'tk-1' });
    expect(useHubDelegationStore.getState().tasks[0]!.status).toBe('interrupted');
  });

  it('未知 taskId 事件不凭空造行（load 兜底）', async () => {
    await freshInit();
    const { useHubDelegationStore } = await import('./hub-delegation.store');
    completedCb!({ taskId: 'ghost' });
    expect(useHubDelegationStore.getState().tasks).toHaveLength(1);
  });

  it('T12 等待标志：kind=waiting-input → waiting 置 true；恢复拍/终态清除（监控台在跑行消费）', async () => {
    await freshInit();
    const { useHubDelegationStore } = await import('./hub-delegation.store');
    expect(useHubDelegationStore.getState().waiting['tk-1']).toBeFalsy();

    progressCb!({ taskId: 'tk-1', sessionId: 'sess-9', lastSeq: 1, excerpt: 'a', kind: 'waiting-input' });
    expect(useHubDelegationStore.getState().waiting['tk-1']).toBe(true);

    progressCb!({ taskId: 'tk-1', sessionId: 'sess-9', lastSeq: 2, excerpt: 'b' });
    expect(useHubDelegationStore.getState().waiting['tk-1']).toBe(false);

    progressCb!({ taskId: 'tk-1', sessionId: 'sess-9', lastSeq: 3, excerpt: 'c', kind: 'waiting-input' });
    completedCb!({ taskId: 'tk-1' });
    expect(useHubDelegationStore.getState().waiting['tk-1']).toBe(false);
  });

  it('load 失败 → error 呈现不吞', async () => {
    await freshInit();
    const { useHubDelegationStore } = await import('./hub-delegation.store');
    mockApi.hub.taskList.mockRejectedValueOnce(new Error('hub 未连接，请先在设置中接入 momo-hub'));
    await useHubDelegationStore.getState().load();
    expect(useHubDelegationStore.getState().error).toBe('hub 未连接，请先在设置中接入 momo-hub');
  });
});

describe('进度 500ms 批合并', () => {
  it('同窗多拍合并一条增量：count/excerpt 取末拍、lastSeq 取最大；跨窗各一条', async () => {
    vi.useFakeTimers();
    await freshInit(true);
    const { useHubDelegationStore } = await import('./hub-delegation.store');

    progressCb!({ taskId: 'tk-1', sessionId: 'sess-1', lastSeq: 10, excerpt: '分析中' });
    progressCb!({ taskId: 'tk-1', sessionId: 'sess-1', lastSeq: 12, excerpt: '已定位根因' });
    progressCb!({ taskId: 'tk-1', sessionId: 'sess-1', lastSeq: 11, excerpt: '中间拍' }); // 乱序 lastSeq 取 max
    expect(useHubDelegationStore.getState().streams['tk-1']).toBeUndefined(); // 窗内在途不落流

    vi.advanceTimersByTime(500);
    let entries = useHubDelegationStore.getState().streams['tk-1']!;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ count: 3, lastSeq: 12, excerpt: '中间拍' });

    // 跨窗新拍 → 新条目
    progressCb!({ taskId: 'tk-1', sessionId: 'sess-1', lastSeq: 20, excerpt: '正在写补丁' });
    vi.advanceTimersByTime(500);
    entries = useHubDelegationStore.getState().streams['tk-1']!;
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ count: 1, lastSeq: 20, excerpt: '正在写补丁' });
  });

  it('progress 记录 sessionId 且状态迁 running（interrupted 复跑链）', async () => {
    vi.useFakeTimers();
    await freshInit(true);
    const { useHubDelegationStore } = await import('./hub-delegation.store');
    interruptedCb!({ taskId: 'tk-1' });
    progressCb!({ taskId: 'tk-1', sessionId: 'sess-9', lastSeq: 5, excerpt: '续跑中' });
    expect(useHubDelegationStore.getState().sessionIds['tk-1']).toBe('sess-9');
    expect(useHubDelegationStore.getState().tasks[0]!.status).toBe('running');
  });

  it('终态到达即冲刷在途批（末条增量不丢）', async () => {
    vi.useFakeTimers();
    await freshInit(true);
    const { useHubDelegationStore } = await import('./hub-delegation.store');
    progressCb!({ taskId: 'tk-1', sessionId: 'sess-1', lastSeq: 30, excerpt: '收尾总结' });
    completedCb!({ taskId: 'tk-1' }); // 不等 500ms 窗口
    const entries = useHubDelegationStore.getState().streams['tk-1']!;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ count: 1, lastSeq: 30, excerpt: '收尾总结' });
  });
});

describe('取消（无 cancelled 推送——回执本地落 + 重拉对账）', () => {
  it('taskCancel 成功 → 本机落 cancelled + 重拉', async () => {
    await freshInit();
    const { useHubDelegationStore } = await import('./hub-delegation.store');
    mockApi.hub.taskCancel.mockResolvedValueOnce({ ok: true });
    mockApi.hub.taskList.mockResolvedValueOnce({ tasks: [task({ status: 'cancelled' })] });
    await useHubDelegationStore.getState().cancel('tk-1');
    expect(mockApi.hub.taskCancel).toHaveBeenCalledWith({ taskId: 'tk-1' });
    expect(useHubDelegationStore.getState().tasks[0]!.status).toBe('cancelled');
  });

  it('conflict（已终态）→ 先重拉对账再呈现错误 + rethrow', async () => {
    await freshInit();
    const { useHubDelegationStore } = await import('./hub-delegation.store');
    mockApi.hub.taskCancel.mockRejectedValueOnce(new Error('任务已处于终态 done，不可取消'));
    mockApi.hub.taskList.mockResolvedValueOnce({ tasks: [task({ status: 'done' })] });
    await expect(useHubDelegationStore.getState().cancel('tk-1')).rejects.toThrow('任务已处于终态 done，不可取消');
    expect(useHubDelegationStore.getState().tasks[0]!.status).toBe('done');
    expect(useHubDelegationStore.getState().error).toBe('任务已处于终态 done，不可取消');
  });
});

describe('M4.2 组过滤（taskList 选中组透传——双态锁）', () => {
  it('态一：无选中组（缺省）→ taskList 无参调用（全组聚合现状零变化）', async () => {
    await freshInit();
    expect(mockApi.hub.taskList).toHaveBeenLastCalledWith(undefined);
  });

  it('态二：选中组 → taskList 带 groupId；切回 null → 回落无参旧形状', async () => {
    await freshInit();
    const { useHubDelegationStore } = await import('./hub-delegation.store');
    mockApi.hub.taskList.mockResolvedValueOnce({ tasks: [task({ taskId: 'tk-g1' })] });
    useHubDelegationStore.getState().setGroupFilter('g-1');
    await vi.waitFor(() => expect(useHubDelegationStore.getState().tasks[0]!.taskId).toBe('tk-g1'));
    expect(mockApi.hub.taskList).toHaveBeenLastCalledWith({ groupId: 'g-1' });

    mockApi.hub.taskList.mockResolvedValueOnce({ tasks: [task()] });
    useHubDelegationStore.getState().setGroupFilter(null);
    await vi.waitFor(() => expect(mockApi.hub.taskList).toHaveBeenLastCalledWith(undefined));
  });

  it('同值 setGroupFilter 不重拉（值变化才拉）', async () => {
    await freshInit();
    const { useHubDelegationStore } = await import('./hub-delegation.store');
    const calls = mockApi.hub.taskList.mock.calls.length;
    useHubDelegationStore.getState().setGroupFilter(null);
    expect(mockApi.hub.taskList.mock.calls.length).toBe(calls);
  });

  it('cancel 对账重拉也走当前过滤（过滤随行——组上下文全链路不丢）', async () => {
    await freshInit();
    const { useHubDelegationStore } = await import('./hub-delegation.store');
    useHubDelegationStore.getState().setGroupFilter('g-1');
    await vi.waitFor(() => expect(mockApi.hub.taskList).toHaveBeenLastCalledWith({ groupId: 'g-1' }));

    mockApi.hub.taskCancel.mockResolvedValueOnce({ ok: true });
    mockApi.hub.taskList.mockResolvedValueOnce({ tasks: [task({ status: 'cancelled' })] });
    await useHubDelegationStore.getState().cancel('tk-1');
    expect(mockApi.hub.taskList).toHaveBeenLastCalledWith({ groupId: 'g-1' });
  });

  it('重入护栏：组切换与在途拉取并发 → 末次补拉取新过滤（旧应答不覆盖新结果）', async () => {
    const { useHubDelegationStore } = await import('./hub-delegation.store');
    let resolveA!: (v: { tasks: HubTaskRecord[] }) => void;
    let resolveB!: (v: { tasks: HubTaskRecord[] }) => void;
    mockApi.hub.taskList
      .mockImplementationOnce(() => new Promise((res) => { resolveA = res; }))
      .mockImplementationOnce(() => new Promise((res) => { resolveB = res; }));
    useHubDelegationStore.setState({
      tasks: [], loading: false, error: null,
      streams: {}, prompts: {}, agentSlugs: {}, sessionIds: {}, reasons: {}, waiting: {},
      groupNames: {}, groupIdFilter: null,
    });
    useHubDelegationStore.getState().init();
    // 首拉（无过滤）在途 → 组过滤切换排队补拉（不并发第二发）
    useHubDelegationStore.getState().setGroupFilter('g-1');
    expect(mockApi.hub.taskList).toHaveBeenCalledTimes(1);

    resolveA({ tasks: [task({ taskId: 'tk-all' })] });
    await vi.waitFor(() => expect(mockApi.hub.taskList).toHaveBeenCalledTimes(2));
    expect(mockApi.hub.taskList).toHaveBeenLastCalledWith({ groupId: 'g-1' });
    resolveB({ tasks: [task({ taskId: 'tk-g1' })] });
    await vi.waitFor(() => expect(useHubDelegationStore.getState().tasks[0]!.taskId).toBe('tk-g1'));
  });
});

describe('M4.2 组名映射缓存（group.list 投影——委派板组徽标数据源）', () => {
  it('init 附带 group.list → groupNames 落地（groupId → groupName）', async () => {
    mockApi.hub.groupList.mockResolvedValue({
      groups: [{ groupId: 'g-1', groupName: '产品组', leaderNodeId: 'node-a', members: [] }],
    });
    await freshInit();
    const { useHubDelegationStore } = await import('./hub-delegation.store');
    expect(mockApi.hub.groupList).toHaveBeenCalledTimes(1);
    expect(useHubDelegationStore.getState().groupNames).toEqual({ 'g-1': '产品组' });
  });

  it('group.changed 推送 → 重拉 group.list 刷新缓存（只刷名不刷任务）', async () => {
    mockApi.hub.groupList.mockResolvedValueOnce({
      groups: [{ groupId: 'g-1', groupName: '产品组', leaderNodeId: 'node-a', members: [] }],
    });
    await freshInit();
    const { useHubDelegationStore } = await import('./hub-delegation.store');
    mockApi.hub.groupList.mockResolvedValueOnce({
      groups: [{ groupId: 'g-1', groupName: '产品组', leaderNodeId: 'node-a', members: [] }, { groupId: 'g-2', groupName: '基建组', leaderNodeId: 'node-b', members: [] }],
    });
    groupChangedCb!();
    // 等缓存落地而非调用计数（promise 决议在调用之后）
    await vi.waitFor(() =>
      expect(useHubDelegationStore.getState().groupNames).toEqual({ 'g-1': '产品组', 'g-2': '基建组' }),
    );
    expect(mockApi.hub.groupList).toHaveBeenCalledTimes(2);
    // 只刷名不刷任务：taskList 仍只 init 首拉一次
    expect(mockApi.hub.taskList).toHaveBeenCalledTimes(1);
  });

  it('group.list 失败 → 尽力而为：缓存保留旧值、error 不置位（徽标降级短码不红行）', async () => {
    mockApi.hub.groupList
      .mockResolvedValueOnce({ groups: [{ groupId: 'g-1', groupName: '产品组', leaderNodeId: 'node-a', members: [] }] })
      .mockRejectedValueOnce(new Error('hub 未连接，请先在设置中接入 momo-hub'));
    await freshInit();
    const { useHubDelegationStore } = await import('./hub-delegation.store');
    groupChangedCb!();
    await vi.waitFor(() => expect(mockApi.hub.groupList).toHaveBeenCalledTimes(2));
    // 微任务冲刷后缓存保持旧值（失败不清洗）、error 不置位
    await vi.waitFor(() =>
      expect(useHubDelegationStore.getState().groupNames).toEqual({ 'g-1': '产品组' }),
    );
    expect(useHubDelegationStore.getState().error).toBeNull();
  });
});

describe('failed reason 人话化', () => {
  it('declined: 前缀 → 拒绝受理人话 + detail 正文；local_session_lost → 会话丢失；其余原文', () => {
    expect(humanizeDelegationReason('declined:并发已达上限（2）')).toEqual({
      headline: '目标节点拒绝受理，任务没有开始',
      body: '并发已达上限（2）',
    });
    expect(humanizeDelegationReason('local_session_lost').headline).toContain('会话已丢失');
    expect(humanizeDelegationReason('执行失败:模型供应商连接失败').body).toBe('执行失败:模型供应商连接失败');
  });
});
