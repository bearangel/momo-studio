// renderer/src/components/hub/RemoteSessionDrawer.test.tsx
//
// 远端会话只读抽屉行为测试（P3 S2）——ipc.hub / ipc.task 边界全 mock：
// 1. 入口条件渲染（CONTRACT #10）：delegationRole='out' 且任务行有 delegation_id
//    才出「查看远端会话」钮；'in'/无委派/未关联任务皆不渲染
// 2. 打开 = 定位链实时反查（Review Focus #2）：taskList（带 routing.groupId）→
//    viewSessions（同名工作空间 + 组锚定）→ viewMessages 尾窗 50（含头含尾）→
//    viewSubscribe 恰好一次（groupId 传 delegation 组）
// 3. 实时追加：onViewAppended 按 sessionId 过滤 + seq 去重；「新入」徽标随最新
//    批让位（CONTRACT #8）
// 4. 加载更早（CONTRACT #4）：fromSeq 向上翻页 + 头部去重 + 加载中禁用
// 5. 断开徽标（CONTRACT #3）：订阅失败 / hub 连接断 → 「已断开 · 重连后恢复」
//    + 流域降不透明度；hub 重连 → 自动重订 + 尾后补拉
// 6. 关闭退订：X / Esc 都恰好一次 view.unsubscribe（幂等清理语义）
// 7. 定位失败：账本无该委派 / 执行方空间无同名会话 → 人话占位
//    「未找到执行会话（任务可能尚未开始）」
// 8. 错误态：forbidden（对方关闭查看）→ 人话 403 提示替换消息流
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { RemoteSessionEntry, RemoteSessionDrawer } from './RemoteSessionDrawer';
import type {
  HubStateChangedEvent, HubViewAppendedEvent, HubViewMessage, SessionSummary, TaskRow,
} from '../../ipc/types';

let appendedCb: ((e: HubViewAppendedEvent) => void) | undefined;
let stateChangedCb: ((e: HubStateChangedEvent) => void) | undefined;

const api = {
  task: {
    get: vi.fn(),
  },
  hub: {
    taskList: vi.fn(),
    getNodes: vi.fn(),
    viewSessions: vi.fn(),
    viewMessages: vi.fn(),
    viewSubscribe: vi.fn(),
    viewUnsubscribe: vi.fn(),
    onViewAppended: vi.fn((cb: (e: HubViewAppendedEvent) => void) => {
      appendedCb = cb;
      return () => undefined;
    }),
    onStateChanged: vi.fn((cb: (e: HubStateChangedEvent) => void) => {
      stateChangedCb = cb;
      return () => undefined;
    }),
  },
};

const baseTask: TaskRow = {
  id: 'T-1042', workspaceId: 'ws1', title: '支付回调重试', description: '', status: 'in_progress',
  sourceSessionId: null, sourceMessageId: null, creatorUserId: 'owner', executionSessionId: 'sess-track',
  assigneeAgentId: null, targetTeamId: null, targetSessionId: null, recurrenceParentId: null,
  priority: 0, scheduledAt: null, recurrenceRule: null, deadlineAt: null, queuePosition: null,
  runtimeInstanceId: null, estimatedTokens: null, actualTokens: null, toolCallsUsed: 0,
  errorMessage: null, sourceNodeId: null, createdAt: 0, updatedAt: 0, startedAt: null, completedAt: null,
  currentRunId: 'run-2', submittedAt: null, acceptedAt: null, delegationRole: 'out', autoAccept: false,
  groupId: null, pinnedAt: null, archivedAt: null,
  routing: { mode: 'node', groupId: 'grp-1', targetNodeId: 'node-b' },
  delegationId: 'dl-1', origin: 'user', parentTaskId: null,
};

function makeSummary(patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-track', workspaceId: 'ws1', title: '#T-1042 · → 节点B', titleAuto: false,
    kind: 'task_execution', lastMessageAt: null, pinnedAt: null, groupId: null, groupName: null,
    sessionType: null, delegationRole: 'out', readOnly: true, taskId: 'T-1042', members: [],
    ...patch,
  };
}

function msg(seq: number, content: string, role = 'assistant'): HubViewMessage {
  return { seq, at: 1_700_000_000_000 + seq * 1000, role, content };
}

const LEDGER = {
  tasks: [{
    taskId: 'dl-1', workspaceName: '研发工作站', targetNodeId: 'node-b', groupId: 'grp-1',
    status: 'running', title: '支付回调重试', createdAt: 1, updatedAt: 2, runNo: 2,
  }],
};

const SESSIONS = {
  sessions: [
    { sessionId: 'other', title: '别的会话', lastSeq: 200, updatedAt: 3 },
    { sessionId: 'ws-9', title: '支付回调重试', lastSeq: 120, updatedAt: 4 },
    { sessionId: 'ws-old', title: '支付回调重试', lastSeq: 80, updatedAt: 5 },
  ],
};

const TAIL_PAGE = {
  // lastSeq=120 → fromSeq = 120-50+1 = 71
  messages: [
    msg(100, '支付回调重试改造：幂等键 + 指数退避', 'user'),
    msg(101, '收到。先核对现有回调链路与测试基线。'),
    msg(102, '调用工具 read_file'),
    msg(103, '回调入口在 src/payment/callback.ts。'),
  ],
  hasMore: true,
};

function stateEvt(state: 'online' | 'disconnected'): HubStateChangedEvent {
  return { state, lastError: null, lastErrorCode: null, hubProtoVer: '1.12.0' };
}

beforeEach(() => {
  vi.clearAllMocks();
  appendedCb = undefined;
  stateChangedCb = undefined;
  (globalThis as unknown as { window: { api: typeof api } }).window.api = api;
  api.task.get.mockResolvedValue(baseTask);
  api.hub.taskList.mockResolvedValue(LEDGER);
  api.hub.getNodes.mockResolvedValue([{ nodeId: 'node-b', nodeName: '节点B' }]);
  api.hub.viewSessions.mockResolvedValue(SESSIONS);
  api.hub.viewMessages.mockResolvedValue(TAIL_PAGE);
  api.hub.viewSubscribe.mockResolvedValue({ ok: true });
  api.hub.viewUnsubscribe.mockResolvedValue({ ok: true });
});

// ── 1. 入口条件渲染 ─────────────────────────────────────────────────────────

describe('RemoteSessionEntry 入口门控', () => {
  it('delegationRole=out 且任务行有 delegation_id → 渲染入口钮', async () => {
    render(<RemoteSessionEntry session={makeSummary()} />);
    await waitFor(() => expect(screen.getByTestId('remote-session-entry')).toBeInTheDocument());
    expect(api.task.get).toHaveBeenCalledWith('T-1042');
  });

  it('delegationRole=null / in / 无关联任务 → 不渲染', async () => {
    const { rerender } = render(<RemoteSessionEntry session={makeSummary({ delegationRole: null, readOnly: false, taskId: null })} />);
    rerender(<RemoteSessionEntry session={makeSummary({ delegationRole: 'in' })} />);
    // null/in 两种都不触发任务反查
    expect(api.task.get).not.toHaveBeenCalled();
    expect(screen.queryByTestId('remote-session-entry')).not.toBeInTheDocument();
  });

  it('任务行无 delegation_id → 不渲染（无委派可指）', async () => {
    api.task.get.mockResolvedValue({ ...baseTask, delegationId: null });
    render(<RemoteSessionEntry session={makeSummary()} />);
    await waitFor(() => expect(api.task.get).toHaveBeenCalled());
    expect(screen.queryByTestId('remote-session-entry')).not.toBeInTheDocument();
  });
});

// ── 2. 打开 = 定位链 + 尾窗 + 订阅 ─────────────────────────────────────────

describe('打开抽屉：定位链实时反查', () => {
  it('taskList(带组) → viewSessions(同名空间+组锚定) → 尾窗 50 含头含尾 → subscribe 恰一次', async () => {
    render(<RemoteSessionDrawer task={baseTask} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('remote-session-drawer')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('执行会话 · 节点B · 只读')).toBeInTheDocument());

    expect(api.hub.taskList).toHaveBeenCalledWith({ groupId: 'grp-1' });
    // 标题匹配取 lastSeq 最高（清单降序首个命中——rework 新会话同标题天然最新）
    expect(api.hub.viewSessions).toHaveBeenCalledWith({
      targetNodeId: 'node-b', workspaceName: '研发工作站', limit: 50, groupId: 'grp-1',
    });
    expect(api.hub.viewMessages).toHaveBeenCalledWith({
      targetNodeId: 'node-b', sessionId: 'ws-9', workspaceName: '研发工作站',
      fromSeq: 71, limit: 50, groupId: 'grp-1',
    });
    expect(api.hub.viewSubscribe).toHaveBeenCalledTimes(1);
    expect(api.hub.viewSubscribe).toHaveBeenCalledWith({ targetNodeId: 'node-b', sessionId: 'ws-9', groupId: 'grp-1' });

    // 副标 run 号 + 工作站；工具系统行 + user 气泡 + 只读条（CONTRACT #2/#5/#6/#9）
    expect(screen.getByText(/run #2 · 节点B · 研发工作站/)).toBeInTheDocument();
    expect(screen.getByText('read_file')).toBeInTheDocument();
    expect(screen.getByText('只读回放 · 不落本地消息')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('经入口打开 → 实时徽标在线', async () => {
    render(<RemoteSessionEntry session={makeSummary()} />);
    fireEvent.click(await screen.findByTestId('remote-session-entry'));
    await waitFor(() => expect(screen.getByText('实时')).toBeInTheDocument());
  });
});

// ── 3. 实时追加（过滤 + 去重 + 新入让位）───────────────────────────────────

describe('onViewAppended 尾部追加', () => {
  async function openReady(): Promise<void> {
    render(<RemoteSessionDrawer task={baseTask} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('执行会话 · 节点B · 只读')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('实时')).toBeInTheDocument());
  }

  it('异会话事件忽略；命中追加 + 「新入」徽标随最新批让位；重复 seq 去重', async () => {
    await openReady();
    // 异会话 → 忽略
    appendedCb!({ sessionId: 'other', events: [msg(104, '异会话事件')] });
    await waitFor(() => expect(screen.queryByText('异会话事件')).not.toBeInTheDocument());

    // 首批追加 → 104 带「新入」
    appendedCb!({ sessionId: 'ws-9', events: [msg(104, '幂等键已加。')] });
    await waitFor(() => expect(screen.getByText('幂等键已加。')).toBeInTheDocument());
    expect(screen.getAllByText('新入')).toHaveLength(1);

    // 次批到达 → 104 徽标让位给 105
    appendedCb!({ sessionId: 'ws-9', events: [msg(105, '冲突路径补齐用例。')] });
    await waitFor(() => expect(screen.getAllByText('新入')).toHaveLength(1));

    // 重复 seq（重订补拉交叠）→ 不重复渲染
    appendedCb!({ sessionId: 'ws-9', events: [msg(105, '冲突路径补齐用例。')] });
    await waitFor(() => expect(screen.getAllByText('冲突路径补齐用例。')).toHaveLength(1));
  });
});

// ── 4. 加载更早 ─────────────────────────────────────────────────────────────

describe('加载更早', () => {
  it('fromSeq 向上翻页 + 头部去重；加载中禁用', async () => {
    let earlierPage: { messages: HubViewMessage[]; hasMore: boolean } | undefined;
    let resolveEarlier: (p: { messages: HubViewMessage[]; hasMore: boolean }) => void = () => undefined;
    api.hub.viewMessages.mockImplementation((input: { fromSeq: number }) =>
      input.fromSeq === 71 ? Promise.resolve(TAIL_PAGE) : new Promise((r) => { resolveEarlier = r; earlierPage = undefined; }),
    );
    render(<RemoteSessionDrawer task={baseTask} onClose={() => {}} />);
    const btn = await screen.findByTestId('remote-session-load-earlier');
    fireEvent.click(btn);
    expect(api.hub.viewMessages).toHaveBeenLastCalledWith({
      targetNodeId: 'node-b', sessionId: 'ws-9', workspaceName: '研发工作站',
      fromSeq: 50, limit: 50, groupId: 'grp-1',
    });
    // 在途：钮禁用 + 文案切换
    expect((screen.getByTestId('remote-session-load-earlier') as HTMLButtonElement).disabled).toBe(true);
    resolveEarlier({ messages: [msg(60, '更早的上下文')], hasMore: false });
    await waitFor(() => expect(screen.getByText('更早的上下文')).toBeInTheDocument());
    // hasMore=false → 按钮卸载（已到最早）
    await waitFor(() => expect(screen.queryByTestId('remote-session-load-earlier')).not.toBeInTheDocument());
    expect(earlierPage).toBeUndefined();
  });
});

// ── 5. 断开徽标 ─────────────────────────────────────────────────────────────

describe('断开徽标（订阅态 ∪ hub 连接态）', () => {
  it('订阅失败 → 已断开徽标 + 流域降不透明度；流式光标不出现', async () => {
    api.hub.viewSubscribe.mockRejectedValue(new Error('[node_offline] 目标节点不在线'));
    render(<RemoteSessionDrawer task={baseTask} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('已断开 · 重连后恢复')).toBeInTheDocument());
    expect(screen.getByTestId('remote-session-flow').className).toContain('opacity-60');
    expect(document.querySelector('.remote-stream-cursor')).toBeNull();
  });

  it('订阅在线但 hub 断线 → 徽标切断开；重连 → 自动重订 + 尾后补拉', async () => {
    render(<RemoteSessionDrawer task={baseTask} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('实时')).toBeInTheDocument());

    stateChangedCb!(stateEvt('disconnected'));
    await waitFor(() => expect(screen.getByText('已断开 · 重连后恢复')).toBeInTheDocument());

    // 重连：退订（幂等清锚）→ 重订 → 从已知尾 seq(103)+1 补拉
    api.hub.viewMessages.mockResolvedValue({ messages: [msg(104, '重连补拉事件')], hasMore: false });
    stateChangedCb!(stateEvt('online'));
    await waitFor(() => expect(api.hub.viewUnsubscribe).toHaveBeenCalledWith({ targetNodeId: 'node-b', sessionId: 'ws-9', groupId: 'grp-1' }));
    await waitFor(() => expect(api.hub.viewSubscribe).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('重连补拉事件')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('实时')).toBeInTheDocument());
    expect(api.hub.viewMessages).toHaveBeenLastCalledWith({
      targetNodeId: 'node-b', sessionId: 'ws-9', workspaceName: '研发工作站',
      fromSeq: 104, limit: 50, groupId: 'grp-1',
    });
  });
});

// ── 6. 关闭退订 ─────────────────────────────────────────────────────────────

/** 关闭即卸载的宿主（真实语义：onClose → 父态翻转 → 抽屉卸载 → 清理退订） */
function DrawerHarness(): React.ReactElement {
  const [open, setOpen] = React.useState(true);
  return open ? <RemoteSessionDrawer task={baseTask} onClose={() => setOpen(false)} /> : <span data-testid="closed" />;
}

describe('关闭与退订', () => {
  it('X 钮关闭 → 卸载 → 恰好一次 view.unsubscribe（sessionId + groupId）', async () => {
    render(<DrawerHarness />);
    await waitFor(() => expect(screen.getByText('执行会话 · 节点B · 只读')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '关闭抽屉' }));
    await waitFor(() => expect(screen.getByTestId('closed')).toBeInTheDocument());
    await waitFor(() => expect(api.hub.viewUnsubscribe).toHaveBeenCalledTimes(1));
    expect(api.hub.viewUnsubscribe).toHaveBeenCalledWith({ targetNodeId: 'node-b', sessionId: 'ws-9', groupId: 'grp-1' });
  });

  it('Escape 关闭同样退订', async () => {
    render(<DrawerHarness />);
    await waitFor(() => expect(screen.getByText('执行会话 · 节点B · 只读')).toBeInTheDocument());
    fireEvent(window, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => expect(screen.getByTestId('closed')).toBeInTheDocument());
    await waitFor(() => expect(api.hub.viewUnsubscribe).toHaveBeenCalledTimes(1));
  });
});

// ── 7/8. 定位失败与错误态 ───────────────────────────────────────────────────

describe('定位失败与错误态', () => {
  it('账本无该委派（taskId 未匹配）→ 人话占位', async () => {
    api.hub.taskList.mockResolvedValue({ tasks: [] });
    render(<RemoteSessionDrawer task={baseTask} onClose={() => {}} />);
    expect(await screen.findByTestId('remote-session-miss')).toHaveTextContent('未找到执行会话（任务可能尚未开始）');
    expect(api.hub.viewSessions).not.toHaveBeenCalled();
  });

  it('执行方空间无同名会话 → 同一人话占位（任务未开始的另一形态）', async () => {
    api.hub.viewSessions.mockResolvedValue({ sessions: [SESSIONS.sessions[0]!] });
    render(<RemoteSessionDrawer task={baseTask} onClose={() => {}} />);
    expect(await screen.findByTestId('remote-session-miss')).toBeInTheDocument();
    expect(api.hub.viewMessages).not.toHaveBeenCalled();
  });

  it('forbidden（对方关闭查看）→ 人话 403 提示替换消息流', async () => {
    api.hub.viewMessages.mockRejectedValue(new Error('[forbidden] 目标节点已关闭本组查看'));
    render(<RemoteSessionDrawer task={baseTask} onClose={() => {}} />);
    expect(await screen.findByTestId('remote-session-error')).toHaveTextContent('对方节点关闭了本组查看');
  });
});
