// renderer/src/components/workgroup/DelegatedTaskCard.test.tsx
//
// 外派看板卡（M2.1 T9，视觉合同 S1/S6——.omo/previews/hub-ia-fullapp.html）：
//   - leader 侧：节点徽标（Bot+节点名）/ 待派发徽标（组内调度 · 待派发，S1）/
//     六态徽标（spinner 执行中 / CircleCheck 已完成 / CircleX 失败 / CircleHelp
//     等待节点确认）+ 进度行（surface-2 圆角摘要；waiting 态 warning tint）
//   - worker 侧：来源徽标（Zap+「来自 {node}」，S6）+ mono #T-id + 等你确认引导
//   - 左 3px 状态色边：默认 violet / waiting warning（.routed / .routed-w）
//   - 操作菜单门控：取消（可取消态）/ 重试派发（仅待派发 RM-M21-5）/ 失败重派（仅 failed）
//   - waiting 占位（T11/T12 接通前无生产者）：waitingSummary=null → 等待态零渲染
// 纯组件测试：board context 直注入（IPC 边界由 provider/BoardCanvas 层承接）。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactElement } from 'react';
import {
  DelegatedTaskCard,
  DelegationBoardProvider,
  type DelegationBoardContextValue,
} from './DelegatedTaskCard';
import { showToast } from '../ui/Toast';
import type { TaskRow } from '../../ipc/types';
import { ipc } from '../../ipc/client';

/** 推送订阅捕获（vi.hoisted——vi.mock 工厂与用例体共享） */
const h = vi.hoisted(() => {
  const subs: Record<string, Array<(p: unknown) => void>> = {};
  return { subs };
});
function fire(channel: string, payload: unknown): void {
  for (const cb of h.subs[channel] ?? []) cb(payload);
}

vi.mock('../../ipc/client', () => ({
  ipc: {
    hub: {
      taskCancel: vi.fn().mockResolvedValue({ ok: true }),
      retryDispatch: vi.fn().mockResolvedValue({ dispatched: true, nodeId: 'node-b', delegationId: 'hub-new' }),
      delegationBoard: vi.fn().mockResolvedValue({ progress: {}, received: [] }),
      taskList: vi.fn().mockResolvedValue({ tasks: [] }),
      getStatus: vi.fn().mockResolvedValue({ nodeId: 'node-self', state: 'online' }),
      groupList: vi.fn().mockResolvedValue({ groups: [] }),
      localWaiting: vi.fn().mockResolvedValue([]),
      onTaskProgress: vi.fn((cb: (p: unknown) => void) => { (h.subs.progress ??= []).push(cb); return () => {}; }),
      onTaskCompleted: vi.fn((cb: (p: unknown) => void) => { (h.subs.completed ??= []).push(cb); return () => {}; }),
      onTaskFailed: vi.fn((cb: (p: unknown) => void) => { (h.subs.failed ??= []).push(cb); return () => {}; }),
      onTaskInterrupted: vi.fn((cb: (p: unknown) => void) => { (h.subs.interrupted ??= []).push(cb); return () => {}; }),
    },
    task: { transition: vi.fn().mockResolvedValue({}) },
    sandbox: {
      onWriteBlocked: vi.fn((cb: (p: unknown) => void) => { (h.subs.writeBlocked ??= []).push(cb); return () => {}; }),
    },
  },
}));
vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));

function mkTask(partial: Partial<TaskRow> & Pick<TaskRow, 'id' | 'title' | 'status'>): TaskRow {
  return {
    workspaceId: 'ws-1',
    description: '',
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'user-1',
    executionSessionId: null,
    assigneeAgentId: null,
    targetTeamId: null,
    targetSessionId: null,
    recurrenceParentId: null,
    priority: 0,
    scheduledAt: null,
    recurrenceRule: null,
    deadlineAt: null,
    queuePosition: null,
    runtimeInstanceId: null,
    estimatedTokens: null,
    actualTokens: null,
    toolCallsUsed: 0,
    errorMessage: null,
    sourceNodeId: null,
    createdAt: 1000,
    updatedAt: 1000,
    startedAt: null,
    completedAt: null,
    groupId: null,
    pinnedAt: null,
    archivedAt: null,
    routing: { mode: 'group', groupId: 'g1' },
    delegationId: 'T-8f21abcd',
    ...partial,
  };
}

const EMPTY_BOARD: DelegationBoardContextValue = {
  selfNodeId: null,
  nodeNames: {},
  ledger: {},
  progress: {},
  received: {},
  localWaiting: {},
  refreshTasks: () => {},
};

function boardCtx(overrides: Partial<DelegationBoardContextValue> = {}): DelegationBoardContextValue {
  return { ...EMPTY_BOARD, ...overrides };
}

function renderCard(task: TaskRow, board: DelegationBoardContextValue = EMPTY_BOARD, waitingSummary?: string | null) {
  return render(
    <DelegationBoardProvider value={board}>
      <DelegatedTaskCard task={task} onSelect={() => {}} waitingSummary={waitingSummary ?? null} />
    </DelegationBoardProvider>,
  );
}

function openMenu(): void {
  fireEvent.contextMenu(screen.getByRole('button', { name: /批量重命名|为支付回调|排查生产/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(h.subs)) delete h.subs[key];
});

// ── leader 侧六态徽标 ────────────────────────────────────────────────────────

describe('DelegatedTaskCard — leader 侧六态', () => {
  it('L-1. running：violet 执行中徽标 + spinner + 节点徽标 + violet 左边 + 进度行', () => {
    renderCard(
      mkTask({ id: 'T-100', title: '批量重命名 legacy API 端点', status: 'in_progress' }),
      boardCtx({
        nodeNames: { 'node-b': 'office-mac' },
        ledger: { 'T-8f21abcd': { taskId: 'T-8f21abcd', workspaceName: 'dev-ws', targetNodeId: 'node-b', status: 'running', title: '批量重命名', createdAt: 1, updatedAt: 2 } },
        progress: { 'T-8f21abcd': { excerpt: 'src/api/v2/user.ts · 第 3/5 文件', lastSeq: 9, at: 3 } },
      }),
    );
    expect(screen.getByText('执行中')).toBeInTheDocument();
    expect(screen.getByText('office-mac')).toBeInTheDocument();
    expect(screen.getByText('src/api/v2/user.ts · 第 3/5 文件')).toBeInTheDocument();
    const card = screen.getByRole('button', { name: /批量重命名/ });
    expect(card.className).toContain('border-l-status-violet');
    expect(card.querySelector('.animate-spin')).not.toBeNull();
  });

  it('L-2. 无 ledger/progress 时从行状态反推徽标（重启/离线对账兜底）', () => {
    renderCard(mkTask({ id: 'T-100', title: '批量重命名 legacy API 端点', status: 'in_progress' }));
    expect(screen.getByText('执行中')).toBeInTheDocument();
  });

  it('L-2b. D5：group 行内已解析目标（routing.targetNodeId）→ 无 ledger 也显节点名（派发回执即写，不待账本）', () => {
    renderCard(
      mkTask({
        id: 'T-100',
        title: '批量重命名 legacy API 端点',
        status: 'in_progress',
        routing: { mode: 'group', groupId: 'g1', targetNodeId: 'node-b' },
      }),
      boardCtx({ nodeNames: { 'node-b': 'office-mac' } }),
    );
    expect(screen.getByText('执行中')).toBeInTheDocument();
    expect(screen.getByText('office-mac')).toBeInTheDocument();
    expect(screen.queryByText('未知节点')).not.toBeInTheDocument();
  });

  it('L-2c. D5：行内已解析目标优先于 ledger（账本滞后/换目标不覆盖行内权威）', () => {
    renderCard(
      mkTask({
        id: 'T-100',
        title: '批量重命名 legacy API 端点',
        status: 'in_progress',
        routing: { mode: 'group', groupId: 'g1', targetNodeId: 'node-b' },
      }),
      boardCtx({
        nodeNames: { 'node-b': 'office-mac', 'node-c': 'lab-node' },
        // 账本快照仍是旧目标（挂载时点滞后）——不得回退显示 lab-node
        ledger: { 'T-8f21abcd': { taskId: 'T-8f21abcd', workspaceName: 'dev-ws', targetNodeId: 'node-c', status: 'running', title: '批量重命名', createdAt: 1, updatedAt: 2 } },
      }),
    );
    expect(screen.getByText('office-mac')).toBeInTheDocument();
    expect(screen.queryByText('lab-node')).not.toBeInTheDocument();
  });

  it('L-2d. D5：failed 卡经行内已解析目标显节点名（declined 场景不再「未知节点」）', () => {
    renderCard(
      mkTask({
        id: 'T-100',
        title: '批量重命名 legacy API 端点',
        status: 'failed',
        errorMessage: 'declined:并发已达上限（2）',
        routing: { mode: 'group', groupId: 'g1', targetNodeId: 'node-b' },
      }),
      boardCtx({ nodeNames: { 'node-b': 'office-mac' } }),
    );
    expect(screen.getByText('失败')).toBeInTheDocument();
    expect(screen.getByText('office-mac')).toBeInTheDocument();
    expect(screen.queryByText('未知节点')).not.toBeInTheDocument();
  });

  it('L-2e. P2-3：failed 卡摘要与 title 优先 errorMessage 全文（running 末拍残留不得占位）', () => {
    renderCard(
      mkTask({
        id: 'T-100',
        title: '人为失败探针',
        status: 'failed',
        errorMessage: '执行失败:模型服务连接失败：HTTP 500 mock人为失败（M2.2 P2-3 验收超长失败原因全文——悬浮 title 必须完整可见）',
        delegationId: 'T-8f21abcd',
        routing: { mode: 'node', groupId: 'g1', targetNodeId: 'node-b' },
      }),
      boardCtx({
        nodeNames: { 'node-b': 'office-mac' },
        ledger: { 'T-8f21abcd': { taskId: 'T-8f21abcd', workspaceName: 'dev-ws', targetNodeId: 'node-b', status: 'failed', title: '人为失败探针', createdAt: 1, updatedAt: 2 } },
        // running 期最后一拍的空转兜底文本——failed 后不得压过 errorMessage
        progress: { 'T-8f21abcd': { excerpt: '（无文本增量）', lastSeq: 5, at: 3 } },
      }),
    );
    const line = document.querySelector('[data-progress-line] [title]');
    expect(line).not.toBeNull();
    expect(line!.textContent).toContain('执行失败:模型服务连接失败');
    expect(line!.getAttribute('title')).toBe('执行失败:模型服务连接失败：HTTP 500 mock人为失败（M2.2 P2-3 验收超长失败原因全文——悬浮 title 必须完整可见）');
    expect(line!.textContent).not.toContain('（无文本增量）');
  });

  it('L-3. done：success 已完成徽标 + 终态降不透明 + 摘要行「已完成」', () => {
    renderCard(
      mkTask({ id: 'T-100', title: '升级依赖并修复类型错误', status: 'completed' }),
      boardCtx({
        ledger: { 'T-8f21abcd': { taskId: 'T-8f21abcd', workspaceName: 'dev-ws', targetNodeId: 'node-c', status: 'done', title: '升级依赖', createdAt: 1, updatedAt: 2 } },
        progress: { 'T-8f21abcd': { excerpt: '已完成', lastSeq: 0, at: 4 } },
      }),
    );
    const card = screen.getByRole('button', { name: /升级依赖/ });
    expect(card.className).toContain('opacity-80');
    // 徽标 + 进度摘要行两处「已完成」（摘要行 data-progress-line 标记）
    const matches = screen.getAllByText('已完成');
    expect(matches).toHaveLength(2);
    expect(matches.some((el) => el.closest('[data-progress-line]') !== null)).toBe(true);
  });

  it('L-4. failed：error 失败徽标 + errorMessage 进度行', () => {
    renderCard(mkTask({ id: 'T-100', title: '批量重命名 legacy API 端点', status: 'failed', errorMessage: '执行失败:测试炸了' }));
    expect(screen.getByText('失败')).toBeInTheDocument();
    expect(screen.getByText('执行失败:测试炸了')).toBeInTheDocument();
  });

  // ── M2.2 P2-3：failed reason 全文透传（truncate + title 全文）──

  it('L-4b. failed reason 超长：进度行截断显示 + title 悬浮全文（hub reason 链已在——errorMessage 列）', () => {
    const longReason =
      '执行失败:目标节点 cargo build 崩溃：error: failed to open ~/.cargo/registry/cache/a.crate Caused by: Operation not permitted (os error 1)，重试三次后仍失败，请检查目标节点沙箱配置';
    renderCard(mkTask({ id: 'T-100', title: '排查生产 500', status: 'failed', errorMessage: longReason }));
    const line = screen.getByText(longReason);
    expect(line).toBeInTheDocument();
    expect(line.closest('[data-progress-line]')?.querySelector('.truncate')?.getAttribute('title')).toBe(longReason);
    expect(line.className).toContain('truncate');
  });

  it('L-4c. failed reason 缺席（errorMessage null）→ 回退现状：无进度行、零 title 悬浮', () => {
    renderCard(mkTask({ id: 'T-100', title: '排查生产 500', status: 'failed', errorMessage: null }));
    expect(screen.getByText('失败')).toBeInTheDocument();
    const card = screen.getByRole('button', { name: /排查生产 500/ });
    expect(card.querySelector('[data-progress-line]')).toBeNull();
    expect(card.querySelector('[title]')).toBeNull();
  });

  it('L-5. cancelled：neutral 已取消徽标', () => {
    renderCard(mkTask({ id: 'T-100', title: '批量重命名 legacy API 端点', status: 'cancelled' }));
    expect(screen.getByText('已取消')).toBeInTheDocument();
  });

  it('L-6. interrupted（ledger 权威）：warning 已中断徽标 + 中断摘要行', () => {
    renderCard(
      mkTask({ id: 'T-100', title: '批量重命名 legacy API 端点', status: 'pending' }),
      boardCtx({
        ledger: { 'T-8f21abcd': { taskId: 'T-8f21abcd', workspaceName: 'dev-ws', targetNodeId: 'node-b', status: 'interrupted', title: '批量重命名', createdAt: 1, updatedAt: 2 } },
        progress: { 'T-8f21abcd': { excerpt: '目标节点连接中断，等待重连续传', lastSeq: 0, at: 5 } },
      }),
    );
    expect(screen.getByText('已中断')).toBeInTheDocument();
    expect(screen.getByText('目标节点连接中断，等待重连续传')).toBeInTheDocument();
  });

  it('L-7. hub pending（已派发待执行）：warning 待执行徽标', () => {
    renderCard(
      mkTask({ id: 'T-100', title: '批量重命名 legacy API 端点', status: 'pending' }),
      boardCtx({
        ledger: { 'T-8f21abcd': { taskId: 'T-8f21abcd', workspaceName: 'dev-ws', targetNodeId: 'node-b', status: 'pending', title: '批量重命名', createdAt: 1, updatedAt: 2 } },
      }),
    );
    expect(screen.getByText('待执行')).toBeInTheDocument();
  });
});

// ── 待派发卡（RM-M21-5）─────────────────────────────────────────────────────

describe('DelegatedTaskCard — 待派发', () => {
  it('P-1. 组内调度待派发：「组内调度 · 待派发」徽标、无状态徽标、无进度行', () => {
    renderCard(mkTask({ id: 'T-100', title: '排查生产环境 WebSocket 断连', status: 'pending', delegationId: null }));
    expect(screen.getByText('组内调度 · 待派发')).toBeInTheDocument();
    expect(screen.queryByText('执行中')).not.toBeInTheDocument();
    expect(screen.queryByText('待执行')).not.toBeInTheDocument();
    expect(screen.queryByText(/第 3\/5 文件/)).not.toBeInTheDocument();
  });

  it('P-2. 指定节点待派发：节点名 + 待派发徽标', () => {
    renderCard(
      mkTask({
        id: 'T-100',
        title: '排查生产环境 WebSocket 断连',
        status: 'pending',
        delegationId: null,
        routing: { mode: 'node', groupId: 'g1', targetNodeId: 'node-b' },
      }),
      boardCtx({ nodeNames: { 'node-b': 'office-mac' } }),
    );
    expect(screen.getByText('office-mac · 待派发')).toBeInTheDocument();
  });
});

// ── worker 侧（S6：来源徽标 + mono #T-id）───────────────────────────────────

describe('DelegatedTaskCard — worker 侧', () => {
  function workerBoard(): DelegationBoardContextValue {
    return boardCtx({
      selfNodeId: 'node-self',
      nodeNames: { 'node-leader': 'mac-main' },
      received: {
        'T-8f21abcd': {
          taskId: 'T-8f21abcd', sessionId: 'sess-1', workspaceId: 'ws-1', workspaceName: 'dev-ws',
          title: '批量重命名 legacy API 端点', byNode: 'node-leader', state: 'running', createdAt: 1, updatedAt: 2,
        },
      },
    });
  }

  it('W-1. routing.targetNodeId=本机 → worker 视角：「来自 mac-main」徽标 + mono #T-id', () => {
    renderCard(
      mkTask({
        id: 'T-900',
        title: '批量重命名 legacy API 端点',
        status: 'in_progress',
        routing: { mode: 'node', groupId: '', targetNodeId: 'node-self' },
      }),
      workerBoard(),
    );
    expect(screen.getByText('来自 mac-main')).toBeInTheDocument();
    expect(screen.getByText('#T-8f21ab')).toBeInTheDocument();
  });

  it('W-2. 来源名缺失 → nodeId 短码兜底（离线节点名不可解析）', () => {
    renderCard(
      mkTask({
        id: 'T-900',
        title: '批量重命名 legacy API 端点',
        status: 'in_progress',
        routing: { mode: 'node', groupId: '', targetNodeId: 'node-self' },
      }),
      boardCtx({ selfNodeId: 'node-self', received: { 'T-8f21abcd': {
        taskId: 'T-8f21abcd', sessionId: 'sess-1', workspaceId: 'ws-1', workspaceName: 'dev-ws',
        title: '批量重命名', byNode: 'node-leader', state: 'running', createdAt: 1, updatedAt: 2,
      } } }),
    );
    expect(screen.getByText(/来自 node…ader/)).toBeInTheDocument();
  });
});

// ── waiting 占位（T11/T12 接通前的占位禁用）─────────────────────────────────

describe('DelegatedTaskCard — waiting 态（占位）', () => {
  it('Q-1. waitingSummary=null（T9 缺省）→ 等待态零渲染（无生产者不点亮）', () => {
    renderCard(mkTask({ id: 'T-100', title: '为支付回调写集成测试', status: 'in_progress' }));
    expect(screen.queryByText('等待节点确认')).not.toBeInTheDocument();
    expect(screen.queryByText('等你确认')).not.toBeInTheDocument();
    expect(screen.getByText('执行中')).toBeInTheDocument();
  });

  it('Q-2. leader waitingSummary → warning 左边 + 等待节点确认徽标 + warning tint 摘要行', () => {
    renderCard(
      mkTask({ id: 'T-100', title: '为支付回调写集成测试', status: 'in_progress' }),
      EMPTY_BOARD,
      'agent 请求 shell 命令 · 超出权限策略',
    );
    expect(screen.getByText('等待节点确认')).toBeInTheDocument();
    expect(screen.queryByText('执行中')).not.toBeInTheDocument();
    const card = screen.getByRole('button', { name: /为支付回调/ });
    expect(card.className).toContain('border-l-status-warning');
    const line = screen.getByText('agent 请求 shell 命令 · 超出权限策略').closest('[data-progress-line]');
    expect(line?.className).toContain('bg-status-warning-tint');
  });

  it('Q-3. worker waitingSummary → 等你确认徽标 + 加粗「打开会话批准/拒绝」引导', () => {
    renderCard(
      mkTask({
        id: 'T-900',
        title: '为支付回调写集成测试',
        status: 'in_progress',
        routing: { mode: 'node', groupId: '', targetNodeId: 'node-self' },
      }),
      boardCtx({ selfNodeId: 'node-self' }),
      'agent 请求 shell 命令（rm -rf node_modules）',
    );
    expect(screen.getByText('等你确认')).toBeInTheDocument();
    expect(screen.getByText(/打开会话批准\/拒绝/)).toBeInTheDocument();
  });
});

// ── waiting 点亮（T12）：等待摘要由 board 上下文派生（prop 占位保留）─────────

describe('DelegatedTaskCard — waiting 派生（T12 点亮）', () => {
  const leaderUi = (board: DelegationBoardContextValue): ReactElement => (
    <DelegationBoardProvider value={board}>
      <DelegatedTaskCard
        task={mkTask({ id: 'T-100', title: '为支付回调写集成测试', status: 'in_progress' })}
        onSelect={() => {}}
      />
    </DelegationBoardProvider>
  );
  const workerUi = (board: DelegationBoardContextValue): ReactElement => (
    <DelegationBoardProvider value={board}>
      <DelegatedTaskCard
        task={mkTask({
          id: 'T-900',
          title: '为支付回调写集成测试',
          status: 'in_progress',
          routing: { mode: 'node', groupId: '', targetNodeId: 'node-self' },
        })}
        onSelect={() => {}}
      />
    </DelegationBoardProvider>
  );

  it('Q-4. leader 派生（progress.waiting=true，无 prop）→ 等待节点确认 + warning 左边 + tint 摘要行', () => {
    render(
      leaderUi(boardCtx({
        progress: { 'T-8f21abcd': { excerpt: 'agent 等待写授权：rm -rf node_modules', lastSeq: 15, at: 9, waiting: true } },
      })),
    );
    expect(screen.getByText('等待节点确认')).toBeInTheDocument();
    const card = screen.getByRole('button', { name: /为支付回调/ });
    expect(card.className).toContain('border-l-status-warning');
    const line = screen.getByText('agent 等待写授权：rm -rf node_modules').closest('[data-progress-line]');
    expect(line?.className).toContain('bg-status-warning-tint');
  });

  it('Q-5. leader 恢复（waiting 清除）→ 执行中回归（RF#3：卡不粘滞）', () => {
    const lit = boardCtx({ progress: { 'T-8f21abcd': { excerpt: '等待中', lastSeq: 15, at: 9, waiting: true } } });
    const resumed = boardCtx({ progress: { 'T-8f21abcd': { excerpt: '续跑产出', lastSeq: 16, at: 10 } } });
    const { rerender } = render(leaderUi(lit));
    expect(screen.getByText('等待节点确认')).toBeInTheDocument();
    rerender(leaderUi(resumed));
    expect(screen.queryByText('等待节点确认')).not.toBeInTheDocument();
    expect(screen.getByText('执行中')).toBeInTheDocument();
  });

  it('Q-6. worker 派生（localWaiting 命中 received.sessionId）→ 等你确认 + 加粗引导 + tint 摘要', () => {
    render(
      workerUi(boardCtx({
        selfNodeId: 'node-self',
        nodeNames: { 'node-leader': 'mac-main' },
        received: {
          'T-8f21abcd': {
            taskId: 'T-8f21abcd', sessionId: 'sess-1', workspaceId: 'ws-1', workspaceName: 'dev-ws',
            title: '为支付回调写集成测试', byNode: 'node-leader', state: 'running', createdAt: 1, updatedAt: 2,
          },
        },
        localWaiting: { 'sess-1': 'agent 等待写授权：rm -rf node_modules' },
      })),
    );
    expect(screen.getByText('等你确认')).toBeInTheDocument();
    expect(screen.getByText(/打开会话批准\/拒绝/)).toBeInTheDocument();
    expect(screen.getByText('agent 等待写授权：rm -rf node_modules')).toBeInTheDocument();
    const card = screen.getByRole('button', { name: /为支付回调/ });
    expect(card.className).toContain('border-l-status-warning');
  });

  it('Q-7. worker 恢复（grant/deny 清登记 → localWaiting 清）→ 执行中回归', () => {
    const received = {
      'T-8f21abcd': {
        taskId: 'T-8f21abcd', sessionId: 'sess-1', workspaceId: 'ws-1', workspaceName: 'dev-ws',
        title: '为支付回调写集成测试', byNode: 'node-leader', state: 'running' as const, createdAt: 1, updatedAt: 2,
      },
    };
    const lit = boardCtx({ selfNodeId: 'node-self', received, localWaiting: { 'sess-1': '等待写授权' } });
    const resumed = boardCtx({ selfNodeId: 'node-self', received, localWaiting: {} });
    const { rerender } = render(workerUi(lit));
    expect(screen.getByText('等你确认')).toBeInTheDocument();
    rerender(workerUi(resumed));
    expect(screen.queryByText('等你确认')).not.toBeInTheDocument();
    expect(screen.getByText('执行中')).toBeInTheDocument();
  });
});

// ── 内置 Provider（无 value 直注入）：推送链 + Low-2 闭包修复 ────────────────

describe('DelegationBoardProvider — 内置拉取（T12）', () => {
  const mountedUi = (refreshTasks?: () => void): ReactElement => (
    <DelegationBoardProvider refreshTasks={refreshTasks}>
      <DelegatedTaskCard
        task={mkTask({ id: 'T-100', title: '为支付回调写集成测试', status: 'in_progress' })}
        onSelect={() => {}}
      />
    </DelegationBoardProvider>
  );

  it('PROV-1. Low-2：refreshTasks 换闭包（切 workspace）后终态推送刷新新闭包、不调旧闭包', async () => {
    const oldWsRefresh = vi.fn();
    const newWsRefresh = vi.fn();
    const { rerender } = render(mountedUi(oldWsRefresh));
    await waitFor(() => expect(h.subs.completed?.length).toBeGreaterThan(0));
    rerender(mountedUi(newWsRefresh));
    act(() => fire('completed', { taskId: 'T-8f21abcd' }));
    expect(newWsRefresh).toHaveBeenCalled();
    expect(oldWsRefresh).not.toHaveBeenCalled();
  });

  it('PROV-2. taskProgress kind=waiting-input → 等待点亮；恢复拍（无 kind）→ 回执行中', async () => {
    render(mountedUi());
    await waitFor(() => expect(h.subs.progress?.length).toBeGreaterThan(0));
    act(() => {
      fire('progress', {
        taskId: 'T-8f21abcd', sessionId: 'sess-9', lastSeq: 15,
        excerpt: 'agent 等待写授权：rm -rf node_modules', kind: 'waiting-input',
      });
    });
    expect(await screen.findByText('等待节点确认')).toBeInTheDocument();
    act(() => {
      fire('progress', { taskId: 'T-8f21abcd', sessionId: 'sess-9', lastSeq: 16, excerpt: '续跑产出' });
    });
    expect(await screen.findByText('执行中')).toBeInTheDocument();
    expect(screen.queryByText('等待节点确认')).not.toBeInTheDocument();
  });
});

// ── 操作菜单门控与动作 ───────────────────────────────────────────────────────

describe('DelegatedTaskCard — 操作菜单', () => {
  it('M-1. running：取消在场；重试派发/失败重派不在场', () => {
    renderCard(mkTask({ id: 'T-100', title: '批量重命名 legacy API 端点', status: 'in_progress' }));
    openMenu();
    expect(screen.getByRole('button', { name: /取消任务/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /重试派发/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /失败重派/ })).not.toBeInTheDocument();
  });

  it('M-2. 待派发：重试派发在场；取消走本地行取消（两步确认后触发）', async () => {
    renderCard(mkTask({ id: 'T-100', title: '排查生产环境 WebSocket 断连', status: 'pending', delegationId: null }));
    openMenu();
    expect(screen.getByRole('button', { name: /重试派发/ })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('cancel-arm'));
    fireEvent.click(screen.getByTestId('cancel-confirm'));
    await waitFor(() => expect(ipc.task.transition).toHaveBeenCalledWith('T-100', 'cancelled'));
    expect(ipc.hub.taskCancel).not.toHaveBeenCalled();
  });

  it('M-3. 已派发取消 → hub.taskCancel（既有 cancel 链，hub 账本权威）', async () => {
    const refreshTasks = vi.fn();
    renderCard(
      mkTask({ id: 'T-100', title: '批量重命名 legacy API 端点', status: 'in_progress' }),
      boardCtx({ refreshTasks }),
    );
    openMenu();
    fireEvent.click(screen.getByTestId('cancel-arm'));
    fireEvent.click(screen.getByTestId('cancel-confirm'));
    await waitFor(() => expect(ipc.hub.taskCancel).toHaveBeenCalledWith({ taskId: 'T-8f21abcd' }));
    await waitFor(() => expect(refreshTasks).toHaveBeenCalled());
  });

  it('M-9. D6 两步确认：首击只 arm 不触发 IPC（P2-10：臂态文案带剩余秒明示）', async () => {
    renderCard(mkTask({ id: 'T-100', title: '批量重命名 legacy API 端点', status: 'in_progress' }));
    openMenu();
    fireEvent.click(screen.getByTestId('cancel-arm'));
    // 臂态：菜单项文案翻确认 + 剩余秒倒计时（path2 痛点：3s 窗口内需明示「再点一次」）；两路取消 IPC 均未触发
    expect(screen.getByText(/再次点击确认取消 · \ds/)).toBeInTheDocument();
    expect(ipc.hub.taskCancel).not.toHaveBeenCalled();
    expect(ipc.task.transition).not.toHaveBeenCalled();
    // 次击才真正取消
    fireEvent.click(screen.getByTestId('cancel-confirm'));
    await waitFor(() => expect(ipc.hub.taskCancel).toHaveBeenCalledWith({ taskId: 'T-8f21abcd' }));
  });

  it('M-10. D6 两步确认：armed 态剩余秒递减 + 3s 无操作回落（防呆臂态不粘滞）', () => {
    vi.useFakeTimers();
    try {
      renderCard(mkTask({ id: 'T-100', title: '批量重命名 legacy API 端点', status: 'in_progress' }));
      openMenu();
      fireEvent.click(screen.getByTestId('cancel-arm'));
      expect(screen.getByText(/再次点击确认取消 · 3s/)).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByText(/再次点击确认取消 · 2s/)).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(2100);
      });
      expect(screen.getByText('取消任务')).toBeInTheDocument();
      expect(screen.queryByTestId('cancel-confirm')).not.toBeInTheDocument();
      expect(ipc.hub.taskCancel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('M-4. failed：失败重派在场；取消不在场（终态）', () => {
    renderCard(mkTask({ id: 'T-100', title: '批量重命名 legacy API 端点', status: 'failed' }));
    openMenu();
    expect(screen.getByRole('button', { name: /失败重派/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /取消任务/ })).not.toBeInTheDocument();
  });

  it('M-5. done：菜单三项全不在场（终态零操作）', () => {
    renderCard(mkTask({ id: 'T-100', title: '批量重命名 legacy API 端点', status: 'completed' }));
    openMenu();
    expect(screen.queryByRole('button', { name: /取消任务/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /重试派发/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /失败重派/ })).not.toBeInTheDocument();
  });

  it('M-6. 重试派发 → hub.retryDispatch + 成功 toast + refreshTasks', async () => {
    const refreshTasks = vi.fn();
    renderCard(
      mkTask({ id: 'T-100', title: '排查生产环境 WebSocket 断连', status: 'pending', delegationId: null }),
      boardCtx({ refreshTasks, nodeNames: { 'node-b': 'office-mac' } }),
    );
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: /重试派发/ }));
    await waitFor(() => expect(ipc.hub.retryDispatch).toHaveBeenCalledWith({ taskId: 'T-100' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('已派发给 office-mac'));
    expect(refreshTasks).toHaveBeenCalled();
  });

  it('M-7. 重试无候选 → dispatched=false 留待处理 toast（RM-M21-5）', async () => {
    vi.mocked(ipc.hub.retryDispatch).mockResolvedValueOnce({ dispatched: false, nodeId: null, delegationId: null });
    renderCard(mkTask({ id: 'T-100', title: '排查生产环境 WebSocket 断连', status: 'pending', delegationId: null }));
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: /重试派发/ }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('暂无可用节点，任务保留待派发'));
  });

  it('M-8. 失败重派 → 同一 retryDispatch 通道（主进程换 delegation_id）', async () => {
    renderCard(mkTask({ id: 'T-100', title: '批量重命名 legacy API 端点', status: 'failed', delegationId: 'hub-old' }));
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: /失败重派/ }));
    await waitFor(() => expect(ipc.hub.retryDispatch).toHaveBeenCalledWith({ taskId: 'T-100' }));
  });
});
