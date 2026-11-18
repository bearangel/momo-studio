// remote-session.view store 行为测试（spec 2026-11-17 §5/§7）——ipc 边界全 mock：
// 1. 定位链：delegationId 精确匹配优先（标题不同也命中）；全缺 → 标题兜底；双 miss
// 2. wire 协商：回显 wire:2 → 帧路径 + appended frames 按 frameId upsert（同 id 两拍替换）
// 3. 降级：无回显 → wire2=false + appended events 走 legacy 数组（seq 去重）
// 4. steer：帧回流（kind=steer）消解 pending 同文最旧项；sendSteer 成/败态机
// 5. 断线重连：offline → live=false；online → 重订（先幂等退订）+ fromSeq 补拉
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubViewAppendedEvent, TaskRow } from '../ipc/types';
import { useRemoteSessionStore, type RemoteSessionTarget } from './remote-session.view';

// ── ipc mock（window.api 全桩——store 经 ipc client 消费） ─────────────────────

type FrameShape = RemoteSessionTarget extends never ? never : import('../ipc/types').HubViewFrame;

const appendedCallbacks: Array<(payload: HubViewAppendedEvent) => void> = [];
const stateCallbacks: Array<(evt: { state: string }) => void> = [];

const runChangedCallbacks: Array<(e: { taskId: string; runId: string; status: string }) => void> = [];
const api = {
  session: { getMessages: vi.fn().mockResolvedValue({ messages: [] }) },
  task: { get: vi.fn(), steer: vi.fn(), onTaskRunChanged: vi.fn((cb: (e: { taskId: string; runId: string; status: string }) => void) => { runChangedCallbacks.push(cb); return () => { const i = runChangedCallbacks.indexOf(cb); if (i >= 0) runChangedCallbacks.splice(i, 1); }; }) },
  hub: {
    taskList: vi.fn(),
    viewSessions: vi.fn(),
    viewMessages: vi.fn(),
    viewSubscribe: vi.fn(),
    viewUnsubscribe: vi.fn().mockResolvedValue({ ok: true }),
    getNodes: vi.fn().mockResolvedValue([{ nodeId: 'node-b', nodeName: '节点B' }]),
    onViewAppended: vi.fn((cb: (p: HubViewAppendedEvent) => void) => {
      appendedCallbacks.push(cb);
      return () => { const i = appendedCallbacks.indexOf(cb); if (i >= 0) appendedCallbacks.splice(i, 1); };
    }),
    onStateChanged: vi.fn((cb: (e: { state: string }) => void) => {
      stateCallbacks.push(cb);
      return () => { const i = stateCallbacks.indexOf(cb); if (i >= 0) stateCallbacks.splice(i, 1); };
    }),
  },
};

const task: TaskRow = {
  id: 'T-9', workspaceId: 'ws1', title: '远端任务', description: '', status: 'in_progress',
  sourceSessionId: null, sourceMessageId: null, creatorUserId: 'owner', executionSessionId: null,
  assigneeAgentId: null, targetTeamId: null, targetSessionId: null, recurrenceParentId: null,
  priority: 0, scheduledAt: null, recurrenceRule: null, deadlineAt: null, queuePosition: null,
  runtimeInstanceId: null, estimatedTokens: null, actualTokens: null, toolCallsUsed: 0,
  errorMessage: null, sourceNodeId: null, createdAt: 0, updatedAt: 0, startedAt: null, completedAt: null,
  currentRunId: null, submittedAt: null, acceptedAt: null, delegationRole: 'out', autoAccept: false,
  groupId: null, pinnedAt: null, archivedAt: null,
  routing: { mode: 'node', groupId: 'g-1', targetNodeId: 'node-b' },
  delegationId: 'dl-9', origin: 'user', parentTaskId: null,
};

const frame = (seq: number, over: Partial<FrameShape> = {}): FrameShape => ({
  frameId: `f${seq}`, seq, at: 1, role: 'assistant', kind: 'text', content: `c${seq}`, ...over,
});

function emitAppended(payload: HubViewAppendedEvent): void {
  for (const cb of [...appendedCallbacks]) cb(payload);
}

function emitState(state: string): void {
  for (const cb of [...stateCallbacks]) cb({ state });
}

/** 定位链默认桩：账本行 + 会话列表（带 delegationId）+ 帧页 + 订阅回显 */
function stubHappyPath(opts: { sessions?: Array<{ sessionId: string; title: string; lastSeq: number; updatedAt: number; delegationId?: string }>; echoWire?: boolean } = {}): void {
  api.hub.taskList.mockResolvedValue({ tasks: [{ taskId: 'dl-9', targetNodeId: 'node-b', workspaceName: 'ws-b', groupId: 'g-1', runNo: 1 }] });
  api.hub.viewSessions.mockResolvedValue({ sessions: opts.sessions ?? [
    { sessionId: 'sx', title: '改名后的会话', lastSeq: 30, updatedAt: 1, delegationId: 'dl-9' },
    { sessionId: 'sy', title: '别的会话', lastSeq: 5, updatedAt: 1 },
  ] });
  api.hub.viewMessages.mockResolvedValue({ frames: [frame(20), frame(25)], hasMore: true });
  api.hub.viewSubscribe.mockResolvedValue(opts.echoWire === false ? { ok: true } : { ok: true, wire: 2 });
}

beforeEach(() => {
  vi.clearAllMocks();
  appendedCallbacks.length = 0;
  stateCallbacks.length = 0;
  (globalThis as unknown as { window: { api: typeof api } }).window.api = api;
  api.hub.viewUnsubscribe.mockResolvedValue({ ok: true });
  api.hub.getNodes.mockResolvedValue([{ nodeId: 'node-b', nodeName: '节点B' }]);
  stubHappyPath();
  useRemoteSessionStore.getState().close();
  useRemoteSessionStore.setState({ frames: [], legacy: [], pendingSteers: [], wire2: false, live: false });
});

// ── 1. 定位链 ────────────────────────────────────────────────────────────────

describe('定位链', () => {
  it('delegationId 精确匹配优先（标题不同也命中）', async () => {
    await useRemoteSessionStore.getState().open(task);
    const s = useRemoteSessionStore.getState();
    expect(s.phase).toBe('ready');
    expect(s.target?.sessionId).toBe('sx');
    expect(s.target?.nodeName).toBe('节点B');
  });

  it('delegationId 全缺 → 标题全等兜底命中（存量路径）', async () => {
    api.hub.viewSessions.mockResolvedValue({ sessions: [{ sessionId: 'st', title: '远端任务', lastSeq: 3, updatedAt: 1 }] });
    await useRemoteSessionStore.getState().open(task);
    expect(useRemoteSessionStore.getState().target?.sessionId).toBe('st');
  });

  it('双 miss → phase=miss', async () => {
    api.hub.viewSessions.mockResolvedValue({ sessions: [] });
    await useRemoteSessionStore.getState().open(task);
    expect(useRemoteSessionStore.getState().phase).toBe('miss');
  });
});

// ── 2/3. wire 协商与帧 upsert / 降级 ────────────────────────────────────────

describe('wire 协商与帧流', () => {
  it('回显 wire:2 → wire2 + 帧页 + appended frames 按 frameId upsert（同 id 两拍替换不重复）', async () => {
    await useRemoteSessionStore.getState().open(task);
    let s = useRemoteSessionStore.getState();
    expect(s.wire2).toBe(true);
    expect(s.frames.map((f) => f.frameId)).toEqual(['f20', 'f25']);
    // 第一拍：流式增长（同 frameId 替换）
    emitAppended({ sessionId: 'sx', events: [], frames: [frame(25, { content: '增长', streaming: true })] });
    s = useRemoteSessionStore.getState();
    expect(s.frames).toHaveLength(2);
    expect(s.frames[1]!.content).toBe('增长');
    // 第二拍：新帧追加
    emitAppended({ sessionId: 'sx', events: [], frames: [frame(30)] });
    s = useRemoteSessionStore.getState();
    expect(s.frames.map((f) => f.frameId)).toEqual(['f20', 'f25', 'f30']);
    expect(s.live).toBe(true);
  });

  it('回显无 wire → wire2=false + legacy 路径（appended events seq 去重追加）', async () => {
    stubHappyPath({ echoWire: false });
    api.hub.viewMessages.mockResolvedValue({ messages: [{ seq: 1, at: 1, role: 'assistant', content: '旧投影' }], hasMore: false });
    await useRemoteSessionStore.getState().open(task);
    let s = useRemoteSessionStore.getState();
    expect(s.wire2).toBe(false);
    expect(s.legacy).toHaveLength(1);
    emitAppended({ sessionId: 'sx', events: [{ seq: 2, at: 2, role: 'assistant', content: '新行' }] });
    emitAppended({ sessionId: 'sx', events: [{ seq: 2, at: 2, role: 'assistant', content: '新行' }] });
    s = useRemoteSessionStore.getState();
    expect(s.legacy).toHaveLength(2);
  });
});

// ── 4. steer ────────────────────────────────────────────────────────────────

describe('steer', () => {
  it('sendSteer 成功 → sent；steer 帧回流消解同文最旧 pending', async () => {
    api.task.steer.mockResolvedValue({ ok: true });
    await useRemoteSessionStore.getState().open(task);
    await useRemoteSessionStore.getState().sendSteer('先写测试');
    let s = useRemoteSessionStore.getState();
    expect(s.pendingSteers).toHaveLength(1);
    expect(s.pendingSteers[0]).toMatchObject({ text: '先写测试', state: 'sent' });
    emitAppended({ sessionId: 'sx', events: [], frames: [frame(31, { kind: 'steer', role: 'user', content: '先写测试' })] });
    s = useRemoteSessionStore.getState();
    expect(s.pendingSteers).toHaveLength(0);
  });

  it('sendSteer 失败 → failed + 人话 error；retrySteer 复用文本重发', async () => {
    api.task.steer.mockRejectedValueOnce(new Error('执行节点离线，稍后再试'));
    await useRemoteSessionStore.getState().open(task);
    await useRemoteSessionStore.getState().sendSteer('失败指令');
    let s = useRemoteSessionStore.getState();
    expect(s.pendingSteers[0]).toMatchObject({ state: 'failed', error: '执行节点离线，稍后再试' });
    api.task.steer.mockResolvedValue({ ok: true });
    await useRemoteSessionStore.getState().retrySteer(s.pendingSteers[0]!.id);
    s = useRemoteSessionStore.getState();
    expect(s.pendingSteers[0]).toMatchObject({ state: 'sent', error: undefined });
  });
});

// ── 5. 断线重连 ─────────────────────────────────────────────────────────────

describe('断线重连', () => {
  it('offline → live=false；online → 幂等退订 + 重订 + 尾后补拉', async () => {
    await useRemoteSessionStore.getState().open(task);
    expect(useRemoteSessionStore.getState().live).toBe(true);
    emitState('offline');
    expect(useRemoteSessionStore.getState().live).toBe(false);
    emitState('online');
    await vi.waitFor(() => {
      expect(api.hub.viewUnsubscribe).toHaveBeenCalled();
      expect(api.hub.viewSubscribe).toHaveBeenCalledTimes(2);
      expect(api.hub.viewMessages).toHaveBeenLastCalledWith(expect.objectContaining({ afterSeq: 25, wire: 2 }));
    });
    expect(useRemoteSessionStore.getState().live).toBe(true);
  });
});

// ── 终审修复：C3a 初页方向 / C3b 补拉方向 / Important#7 legacy steer 消解 ────

describe('终审修复', () => {
  it('open() 初页 fromSeq=0（帧页尾窗语义——含订阅前的流式帧，C3a）', async () => {
    await useRemoteSessionStore.getState().open(task);
    expect(api.hub.viewMessages).toHaveBeenCalledWith(expect.objectContaining({ fromSeq: 0, wire: 2 }));
  });

  it('重连补拉带 afterSeq=已知尾（向前追方向，C3b）', async () => {
    await useRemoteSessionStore.getState().open(task);
    emitState('offline');
    emitState('online');
    await vi.waitFor(() => {
      expect(api.hub.viewMessages).toHaveBeenLastCalledWith(expect.objectContaining({ afterSeq: 25, wire: 2 }));
    });
  });

  it('回流的【发起方指令】里程碑帧（system 行投影）也消解 pending（E2E 实录：远端注入走里程碑非 steer 事件）', async () => {
    await useRemoteSessionStore.getState().open(task);
    api.task.steer.mockResolvedValue({ ok: true });
    await useRemoteSessionStore.getState().sendSteer('追加标记行');
    expect(useRemoteSessionStore.getState().pendingSteers).toHaveLength(1);
    emitAppended({ sessionId: 'sx', events: [], frames: [frame(40, { kind: 'text', content: '【发起方指令】追加标记行' })] });
    expect(useRemoteSessionStore.getState().pendingSteers).toHaveLength(0);
  });

  it('legacy 降级下 steer 回流行（user 行 content=正文）也消解 pending（Important#7）', async () => {
    stubHappyPath({ echoWire: false });
    api.hub.viewMessages.mockResolvedValue({ messages: [], hasMore: false });
    await useRemoteSessionStore.getState().open(task);
    api.task.steer.mockResolvedValue({ ok: true });
    await useRemoteSessionStore.getState().sendSteer('旧模式指令');
    expect(useRemoteSessionStore.getState().pendingSteers).toHaveLength(1);
    emitAppended({ sessionId: 'sx', events: [{ seq: 9, at: 1, role: 'user', content: '旧模式指令' }] });
    expect(useRemoteSessionStore.getState().pendingSteers).toHaveLength(0);
    // assistant 行的【发起方指令】前缀形态同样消解（system 里程碑的 legacy 投影）
    await useRemoteSessionStore.getState().sendSteer('前缀形态');
    emitAppended({ sessionId: 'sx', events: [{ seq: 10, at: 1, role: 'assistant', content: '【发起方指令】前缀形态' }] });
    expect(useRemoteSessionStore.getState().pendingSteers).toHaveLength(0);
  });
});


describe('任务态实时性（E2E 实录：完成后 composer 须禁用）', () => {
  it('onTaskRunChanged 推送本任务 → store.task 刷新（终态门控不再用陈旧快照）', async () => {
    runChangedCallbacks.length = 0;
    await useRemoteSessionStore.getState().open(task);
    api.task.get.mockResolvedValue({ ...task, status: 'completed' });
    for (const cb of [...runChangedCallbacks]) cb({ taskId: task.id, runId: 'r1', status: 'completed' });
    await vi.waitFor(() => {
      expect(useRemoteSessionStore.getState().task?.status).toBe('completed');
    });
  });
});


// ── spec §12.2：本地镜像里程碑行（拉取 + 随 run 推送刷新） ───────────────────

describe('镜像行（mirrorRows）', () => {
  it('open() 拉取跟踪会话本地镜像行；onTaskRunChanged 推送后刷新', async () => {
    api.session.getMessages.mockResolvedValue({ messages: [
      { id: 'm1', sessionId: 'sx', sender: 'system', body: '已提交待验收', eventType: 'delegation_milestone', streamSessionId: null, parentStreamSessionId: null, segmentOf: null, segmentIndex: null, status: 'done', source: 'hub', workspaceId: 'ws1', taskId: 'T-9', createdAt: 1700000000000, updatedAt: 0 },
    ] });
    await useRemoteSessionStore.getState().open({ ...task, executionSessionId: 'sx' });
    expect(useRemoteSessionStore.getState().mirrorRows.map((m) => m.body)).toEqual(['已提交待验收']);
    api.session.getMessages.mockClear();
    api.task.get.mockResolvedValue({ ...task, executionSessionId: 'sx', status: 'completed' });
    for (const cb of [...runChangedCallbacks]) cb({ taskId: task.id, runId: 'r1', status: 'completed' });
    await vi.waitFor(() => expect(api.session.getMessages).toHaveBeenCalled());
  });
});
