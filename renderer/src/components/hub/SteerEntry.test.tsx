// renderer/src/components/hub/SteerEntry.test.tsx
//
// 发起方补充指令入口行为测试（P3 S3，CONTRACT #11-16）——ipc 边界全 mock：
// 1. 入口门控：delegationRole='out' + delegation_id 在场 + 任务非终态 → 渲染；
//    终态（completed/failed/cancelled）/ 无委派 / 非跟踪会话皆不渲染
// 2. 浮层形态：打开出 textarea + 计数 n/4000 + 恒显离线提示行 + 取消/发送指令；
//    头部节点名经 getNodes 解析（失败降级短 id）
// 3. 计数与禁发：空文本禁发；超 4000 码点计数转 error 色并禁发（码点计非
//    UTF-16 单元）；trim 后发送
// 4. 发送流：成功 → ipc.task.steer 后浮层收起；失败 → ui-Toast 底部居中人话 +
//    浮层保持；发送中禁双击 + 取消/Escape 失效
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { SteerEntry } from './SteerEntry';
import { Toast } from '../ui/Toast';
import type { SessionSummary, TaskRow } from '../../ipc/types';

const api = {
  task: {
    get: vi.fn(),
    steer: vi.fn(),
  },
  hub: {
    getNodes: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { window: { api: typeof api } }).window.api = api;
  api.task.get.mockResolvedValue(baseTask);
  api.task.steer.mockResolvedValue({ ok: true });
  api.hub.getNodes.mockResolvedValue([{ nodeId: 'node-b', nodeName: '节点B' }]);
});

// ── 1. 入口门控 ─────────────────────────────────────────────────────────────

describe('SteerEntry 入口门控', () => {
  it("delegationRole=out 且非终态 → 渲染入口钮（与查看钮并排位由 MiddlePanel 挂载）", async () => {
    render(<SteerEntry session={makeSummary()} />);
    await waitFor(() => expect(screen.getByTestId('steer-entry')).toBeInTheDocument());
    expect(api.task.get).toHaveBeenCalledWith('T-1042');
  });

  it('delegationRole=null / in / 无关联任务 → 不渲染', () => {
    render(<SteerEntry session={makeSummary({ delegationRole: null, taskId: null })} />);
    expect(api.task.get).not.toHaveBeenCalled();
    expect(screen.queryByTestId('steer-entry')).not.toBeInTheDocument();
  });

  it('任务行无 delegation_id → 不渲染（无委派可指）', async () => {
    api.task.get.mockResolvedValue({ ...baseTask, delegationId: null });
    render(<SteerEntry session={makeSummary()} />);
    await waitFor(() => expect(api.task.get).toHaveBeenCalled());
    expect(screen.queryByTestId('steer-entry')).not.toBeInTheDocument();
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    '任务终态（%s）→ 不渲染（账本终态无执行可指）',
    async (status) => {
      api.task.get.mockResolvedValue({ ...baseTask, status });
      render(<SteerEntry session={makeSummary()} />);
      await waitFor(() => expect(api.task.get).toHaveBeenCalled());
      expect(screen.queryByTestId('steer-entry')).not.toBeInTheDocument();
    },
  );
});

// ── 2/3. 浮层形态与计数禁发 ─────────────────────────────────────────────────

describe('输入浮层（CONTRACT #12-14）', () => {
  async function open(): Promise<void> {
    render(<SteerEntry session={makeSummary()} />);
    fireEvent.click(await screen.findByTestId('steer-entry'));
    await waitFor(() => expect(screen.getByTestId('steer-popover')).toBeInTheDocument());
  }

  it('打开：textarea + 计数 0/4000 + 恒显离线提示行 + 头部节点名 + 空文本禁发', async () => {
    await open();
    expect(screen.getByTestId('steer-textarea')).toBeInTheDocument();
    expect(screen.getByTestId('steer-count')).toHaveTextContent('0 / 4000');
    // CONTRACT #14：恒显预警行（hub 离线拒——指令时效性强，不缓存重发）
    expect(screen.getByText('执行节点离线时发送将失败')).toBeInTheDocument();
    expect(screen.getByText('补充指令 · 送达节点B')).toBeInTheDocument();
    expect(screen.getByText(/#T-1042 支付回调重试 · 指令在执行方回合边界注入/)).toBeInTheDocument();
    expect((screen.getByTestId('steer-send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('getNodes 失败 → 头部降级短 id 不阻断', async () => {
    api.hub.getNodes.mockRejectedValue(new Error('hub 未连接'));
    api.task.get.mockResolvedValue({
      ...baseTask,
      routing: { mode: 'node', groupId: 'grp-1', targetNodeId: 'node-b-12345678' },
    });
    await open();
    await waitFor(() => expect(screen.getByText('补充指令 · 送达node…5678')).toBeInTheDocument());
  });

  it('空文本禁发；输入后启用；计数随码点（emoji 计 1 不计 2）', async () => {
    await open();
    const ta = screen.getByTestId('steer-textarea');
    fireEvent.change(ta, { target: { value: '😀😀' } });
    expect(screen.getByTestId('steer-count')).toHaveTextContent('2 / 4000');
    expect((screen.getByTestId('steer-send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('超 4000 码点 → 计数转 status-error 并禁发', async () => {
    await open();
    fireEvent.change(screen.getByTestId('steer-textarea'), {
      target: { value: 'a'.repeat(4001) },
    });
    expect(screen.getByTestId('steer-count')).toHaveTextContent('4001 / 4000');
    expect(screen.getByTestId('steer-count').className).toContain('text-status-error');
    expect((screen.getByTestId('steer-send') as HTMLButtonElement).disabled).toBe(true);
  });
});

// ── 4. 发送流 / 关闭 ────────────────────────────────────────────────────────

describe('发送流（CONTRACT #15-16 + #18）', () => {
  async function openWithText(text: string): Promise<void> {
    render(
      <>
        <SteerEntry session={makeSummary()} />
        <Toast />
      </>,
    );
    fireEvent.click(await screen.findByTestId('steer-entry'));
    await waitFor(() => expect(screen.getByTestId('steer-popover')).toBeInTheDocument());
    if (text !== '') {
      fireEvent.change(screen.getByTestId('steer-textarea'), { target: { value: text } });
    }
  }

  it('发送 → ipc.task.steer(taskId, trim 后)；成功浮层收起', async () => {
    await openWithText('  覆盖 seeds 表，别直接删。  ');
    fireEvent.click(screen.getByTestId('steer-send'));
    await waitFor(() => expect(api.task.steer).toHaveBeenCalledWith('T-1042', '覆盖 seeds 表，别直接删。'));
    await waitFor(() => expect(screen.queryByTestId('steer-popover')).not.toBeInTheDocument());
  });

  it('失败 → ui-Toast 底部居中人话 + 浮层保持可改可重发', async () => {
    api.task.steer.mockRejectedValue(new Error('执行节点离线，稍后再试'));
    await openWithText('第一条');
    fireEvent.click(screen.getByTestId('steer-send'));
    await waitFor(() => expect(screen.getByTestId('ui-toast')).toHaveTextContent('执行节点离线，稍后再试'));
    expect(screen.getByTestId('steer-popover')).toBeInTheDocument();
    // 重发成功 → toast 让位语义外，浮层收起
    api.task.steer.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByTestId('steer-send'));
    await waitFor(() => expect(screen.queryByTestId('steer-popover')).not.toBeInTheDocument());
  });

  it('发送中禁双击 + 取消/Escape 失效（在途卸载会丢反馈）', async () => {
    let resolveSend: (v: { ok: true }) => void = () => undefined;
    api.task.steer.mockImplementation(
      () => new Promise<{ ok: true }>((r) => { resolveSend = r; }),
    );
    await openWithText('在途');
    fireEvent.click(screen.getByTestId('steer-send'));
    expect((screen.getByTestId('steer-send') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent(window, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(screen.getByTestId('steer-popover')).toBeInTheDocument();
    resolveSend({ ok: true });
    await waitFor(() => expect(screen.queryByTestId('steer-popover')).not.toBeInTheDocument());
  });

  it('取消钮 / Escape 关浮层；点外部收起', async () => {
    await openWithText('');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByTestId('steer-popover')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('steer-entry'));
    await waitFor(() => expect(screen.getByTestId('steer-popover')).toBeInTheDocument());
    fireEvent(window, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(screen.queryByTestId('steer-popover')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('steer-entry'));
    await waitFor(() => expect(screen.getByTestId('steer-popover')).toBeInTheDocument());
    fireEvent.mouseDown(document.body, { bubbles: true });
    expect(screen.queryByTestId('steer-popover')).not.toBeInTheDocument();
  });
});
