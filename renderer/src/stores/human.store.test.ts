// renderer/src/stores/human.store.test.ts
//
// human.store 行为锁（Task 22）：
//   1. loadPending 按 sessionId 落 pendingBySession（human.list 默认 pending 面）
//   2. answer → ipc.human.answer 透传 + 所属会话立即重拉（不等推送）
//   3. onChanged 订阅：已跟踪会话事件 → 合并重拉（同请求连发两事件只拉一次）；
//      未跟踪会话事件不触发拉取
//   4. runChanged 兜底（T16 carry）：无 sessionId 载荷 → 全部已跟踪会话重拉
//   5. __resetForTest 退订 + 复位（订阅防重入标记回收）
//
// mock 收窄在 IPC 边界（InFlightPanel 同款：换 window.api，经真实 ipc Proxy 走
// wrapNamespace/wrapFunction——不 vi.mock client 模块）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HumanRequestRow } from '../ipc/types';
import { useHumanStore } from './human.store';

const listMock = vi.fn();
const answerMock = vi.fn();
const attentionMock = vi.fn();
const humanOnChangedMock = vi.fn().mockReturnValue(() => {});
const taskRunChangedMock = vi.fn().mockReturnValue(() => {});

const mockApi = {
  human: {
    list: listMock,
    answer: answerMock,
    attention: attentionMock,
    onChanged: humanOnChangedMock,
  },
  task: {
    onTaskRunChanged: taskRunChangedMock,
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

/** 构造真实形状 HumanRequestRow（默认 question，1 分钟前创建） */
function makeRow(overrides: Partial<HumanRequestRow> = {}): HumanRequestRow {
  return {
    id: 'req-1',
    taskId: null,
    runId: null,
    sessionId: 'sess-1',
    delegationId: null,
    originNodeId: null,
    remoteId: null,
    kind: 'question',
    status: 'pending',
    title: '兼容性确认',
    prompt: '旧版 token 是否继续兼容？',
    payloadJson: null,
    optionsJson: null,
    assigneeNodeId: null,
    authorityJson: null,
    deadlineAt: null,
    timeoutPolicy: 'keep_waiting',
    lastRemindedAt: null,
    answerJson: null,
    answeredByNodeId: null,
    answeredAt: null,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
    ...overrides,
  };
}

/** 冲刷事件合并窗口（100ms）并落定重拉 promise */
async function flushCoalesce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(150);
}

beforeEach(() => {
  vi.useFakeTimers();
  useHumanStore.getState().__resetForTest();
  listMock.mockReset().mockResolvedValue([]);
  answerMock.mockReset().mockResolvedValue({ disposition: 'answered' });
  attentionMock.mockReset().mockResolvedValue({});
  humanOnChangedMock.mockClear();
  taskRunChangedMock.mockClear();
});

afterEach(() => {
  useHumanStore.getState().__resetForTest();
  vi.useRealTimers();
});

describe('human.store — loadPending / refreshAttention', () => {
  it('loadPending 按 sessionId 落 pendingBySession', async () => {
    const row = makeRow();
    listMock.mockResolvedValue([row]);
    await useHumanStore.getState().loadPending('sess-1');
    expect(listMock).toHaveBeenCalledWith({ sessionId: 'sess-1' });
    expect(useHumanStore.getState().pendingBySession.get('sess-1')).toEqual([row]);
  });

  it('loadPending 失败静默：保持既有值不清空', async () => {
    await useHumanStore.getState().loadPending('sess-1');
    listMock.mockRejectedValue(new Error('ipc down'));
    await useHumanStore.getState().loadPending('sess-1');
    expect(useHumanStore.getState().pendingBySession.get('sess-1')).toEqual([]);
  });

  it('refreshAttention 整体替换 attentionBySession', async () => {
    attentionMock.mockResolvedValue({ 'sess-1': { waiting: 2, submitted: false, executorSubmitted: false, failed: false } });
    await useHumanStore.getState().refreshAttention('ws-1');
    expect(attentionMock).toHaveBeenCalledWith('ws-1');
    expect(useHumanStore.getState().attentionBySession['sess-1']?.waiting).toBe(2);
  });
});

describe('human.store — answer', () => {
  it('透传 ipc.human.answer 三参 + 所属会话立即重拉', async () => {
    const row = makeRow();
    listMock.mockResolvedValue([row]);
    await useHumanStore.getState().loadPending('sess-1');
    listMock.mockClear();

    const disposition = await useHumanStore.getState().answer('req-1', { decision: 'approve' }, '附言');
    expect(disposition).toBe('answered');
    expect(answerMock).toHaveBeenCalledWith('req-1', { decision: 'approve' }, '附言');
    // 答后立即重拉（不等 onChanged 推送）——卡片原地消失的数据源
    expect(listMock).toHaveBeenCalledWith({ sessionId: 'sess-1' });
  });
});

describe('human.store — onChanged / runChanged 订阅', () => {
  it('initSubscriptions 幂等：重复调用只订阅一次', () => {
    useHumanStore.getState().initSubscriptions();
    useHumanStore.getState().initSubscriptions();
    expect(humanOnChangedMock).toHaveBeenCalledTimes(1);
    expect(taskRunChangedMock).toHaveBeenCalledTimes(1);
  });

  it('已跟踪会话事件 → 重拉；同请求连发两事件（去重）只拉一次', async () => {
    await useHumanStore.getState().loadPending('sess-1');
    listMock.mockClear();

    useHumanStore.getState().initSubscriptions();
    const onChanged = humanOnChangedMock.mock.calls[0]![0];
    onChanged({ sessionId: 'sess-1', requestId: 'req-9', kind: 'inserted' });
    onChanged({ sessionId: 'sess-1', requestId: 'req-9', kind: 'answered' });
    await flushCoalesce();

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledWith({ sessionId: 'sess-1' });
  });

  it('未跟踪会话事件不触发拉取', async () => {
    await useHumanStore.getState().loadPending('sess-1');
    listMock.mockClear();

    useHumanStore.getState().initSubscriptions();
    const onChanged = humanOnChangedMock.mock.calls[0]![0];
    onChanged({ sessionId: 'sess-other', requestId: 'req-x', kind: 'inserted' });
    await flushCoalesce();
    expect(listMock).not.toHaveBeenCalled();
  });

  it('runChanged 兜底：载荷无 sessionId → 全部已跟踪会话重拉', async () => {
    await useHumanStore.getState().loadPending('sess-1');
    await useHumanStore.getState().loadPending('sess-2');
    listMock.mockClear();

    useHumanStore.getState().initSubscriptions();
    const onRunChanged = taskRunChangedMock.mock.calls[0]![0];
    // T16 carry：supersede / cancel 通路只发 runChanged 不发 human:changed
    onRunChanged({ taskId: 'T-1', runId: 'run-1', status: 'cancelled' });
    await flushCoalesce();

    expect(listMock).toHaveBeenCalledWith({ sessionId: 'sess-1' });
    expect(listMock).toHaveBeenCalledWith({ sessionId: 'sess-2' });
  });

  // T23：两类事件顺带合并刷新 attention（徽标/待处理分区数据源——未打开会话
  // 的等待计数、任务态翻转仅经此通路反映到会话列表）
  it('onChanged 事件兜底刷新 attention：未跟踪会话（无 pending 拉取）也刷', async () => {
    await useHumanStore.getState().refreshAttention('ws-1');
    attentionMock.mockClear();

    useHumanStore.getState().initSubscriptions();
    const onChanged = humanOnChangedMock.mock.calls[0]![0];
    onChanged({ sessionId: 'sess-other', requestId: 'req-x', kind: 'inserted' });
    await flushCoalesce();

    expect(attentionMock).toHaveBeenCalledWith('ws-1');
  });

  it('runChanged 兜底顺带刷新 attention（复用最近 workspace 上下文）', async () => {
    await useHumanStore.getState().refreshAttention('ws-9');
    listMock.mockClear();
    attentionMock.mockClear();

    useHumanStore.getState().initSubscriptions();
    const onRunChanged = taskRunChangedMock.mock.calls[0]![0];
    onRunChanged({ taskId: 'T-1', runId: 'run-1', status: 'completed' });
    await flushCoalesce();

    expect(attentionMock).toHaveBeenCalledWith('ws-9');
  });

  it('未建立 workspace 上下文（从未 refreshAttention）→ 事件不刷 attention', async () => {
    useHumanStore.getState().initSubscriptions();
    const onChanged = humanOnChangedMock.mock.calls[0]![0];
    onChanged({ sessionId: 'sess-1', requestId: 'req-9', kind: 'inserted' });
    await flushCoalesce();
    expect(attentionMock).not.toHaveBeenCalled();
  });

  it('__resetForTest 退订：此后事件不再触发拉取', async () => {
    await useHumanStore.getState().loadPending('sess-1');
    useHumanStore.getState().initSubscriptions();
    const onChanged = humanOnChangedMock.mock.calls[0]![0];
    useHumanStore.getState().__resetForTest();
    listMock.mockClear();

    onChanged({ sessionId: 'sess-1', requestId: 'req-9', kind: 'inserted' });
    await flushCoalesce();
    expect(listMock).not.toHaveBeenCalled();
  });
});
