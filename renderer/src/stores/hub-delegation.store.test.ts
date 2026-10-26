// renderer/src/stores/hub-delegation.store.test.ts
//
// 委派面板 store 契约（M2e T12）：task.list 拉取 / task.progress 500ms 批合并
// （同窗多拍一条增量、终态冲刷在途批）/ 终态四推送状态迁移 / cancelled 无推送——
// 由 taskCancel 回执本地落 + 重拉对账 / 向导受理链（delegate → accepted + prompts
// 记录 + 重拉）/ 未知 taskId 事件不凭空造行。
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
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  progressCb = undefined;
  completedCb = undefined;
  failedCb = undefined;
  interruptedCb = undefined;
  (globalThis as unknown as { window: { api: typeof mockApi } }).window = { api: mockApi };
  mockApi.hub.taskList.mockResolvedValue({ tasks: [task()] });
});

afterEach(() => {
  __resetDelegationBatchesForTest();
  vi.useRealTimers();
});

async function freshInit(fakeTimers = false): Promise<void> {
  const { useHubDelegationStore } = await import('./hub-delegation.store');
  useHubDelegationStore.setState({
    tasks: [], loading: false, error: null,
    streams: {}, prompts: {}, agentSlugs: {}, sessionIds: {}, reasons: {},
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
