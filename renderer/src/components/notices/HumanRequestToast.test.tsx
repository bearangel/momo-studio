// renderer/src/components/notices/HumanRequestToast.test.tsx
//
// 人工请求吐司（S4，CONTRACT #19-23）测试：mock 骨架照抄 NoticeStack.test.tsx
// 的 window.api 桩模式（onChanged 捕获 + list 桩 + 默认解订阅）。
// 覆盖：插入→吐司渲染（title+会话名）/ answered 事件不建条 / 同会话第二条→
// 计数 2 计数变体（不叠条）/ 点击主体→selectSession+消散 / 6s 自动消散
// （fake timers）/ deadline<5min 预警描边+剩余文案 / 手动关闭 / 上限 4 条溢出行。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { HumanRequestToast } from './HumanRequestToast';
import { useSessionStore } from '../../stores/session.store';
import type { HumanRequestRow, SessionSummary } from '../../ipc/types';

const onChangedMock = vi.fn();
const listMock = vi.fn();
(globalThis as unknown as { window: { api: unknown } }).window.api = {
  human: {
    onChanged: onChangedMock,
    list: listMock,
  },
};

function armEvent(): { push: (e: { sessionId: string; requestId?: string; kind: string }) => void } {
  let captured: ((e: { sessionId: string; requestId?: string; kind: string }) => void) | null = null;
  onChangedMock.mockImplementation(
    (cb: (e: { sessionId: string; requestId?: string; kind: string }) => void) => {
      captured = cb;
      return () => {};
    },
  );
  return {
    push: (e: { sessionId: string; requestId?: string; kind: string }) =>
      act(() => captured?.(e)),
  };
}

let rowSeq = 1;
function row(overrides: Partial<HumanRequestRow> & { sessionId: string; title: string }): HumanRequestRow {
  rowSeq += 1;
  return {
    id: `req-${rowSeq}`,
    taskId: null,
    runId: null,
    delegationId: null,
    originNodeId: null,
    remoteId: null,
    kind: 'tool_gate',
    status: 'pending',
    prompt: '',
    payloadJson: null,
    optionsJson: null,
    assigneeNodeId: null,
    authorityJson: null,
    deadlineAt: null,
    timeoutPolicy: 'deny_and_wrap',
    lastRemindedAt: null,
    answerJson: null,
    answeredByNodeId: null,
    answeredAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function sessionSummary(id: string, title: string): SessionSummary {
  return {
    id,
    workspaceId: 'w1',
    title,
    titleAuto: false,
    kind: 'chat',
    lastMessageAt: null,
    pinnedAt: null,
    groupId: null,
    groupName: null,
    sessionType: 'collab',
    delegationRole: null,
    readOnly: false,
    taskId: null,
    members: [],
  };
}

/** 推一条 inserted 事件并等 list 单查 promise 落定（吐司在 await 后才渲染） */
async function pushInserted(
  push: ReturnType<typeof armEvent>['push'],
  sessionId: string,
  rows: HumanRequestRow[],
): Promise<void> {
  listMock.mockResolvedValueOnce(rows);
  await act(async () => {
    push({ sessionId, kind: 'inserted' });
  });
}

beforeEach(() => {
  onChangedMock.mockReset();
  onChangedMock.mockReturnValue(() => {});
  listMock.mockReset();
  useSessionStore.setState({
    sessions: [sessionSummary('s1', '会员积分重构')],
    selectSession: vi.fn().mockResolvedValue(undefined),
  });
});

describe('HumanRequestToast（人工请求吐司）', () => {
  it('插入 → 吐司渲染主行 title + 副行会话名；单查带 pending 过滤；answered 事件不建条', async () => {
    const { push } = armEvent();
    render(<HumanRequestToast />);
    await pushInserted(push, 's1', [row({ sessionId: 's1', title: '部署生产环境确认' })]);
    expect(screen.getByTestId('human-request-toast')).toBeInTheDocument();
    expect(screen.getByText('等待你确认 · 部署生产环境确认')).toBeInTheDocument();
    expect(screen.getByText('会员积分重构')).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith({ sessionId: 's1', status: 'pending' });
    // 非 inserted 事件（answered）不产生吐司（CONTRACT #23：被答不另发撤销）
    listMock.mockResolvedValueOnce([]);
    await act(async () => {
      push({ sessionId: 's1', kind: 'answered' });
    });
    expect(screen.getAllByTestId('human-request-toast')).toHaveLength(1);
  });

  it('同会话第二条 → 不叠条、计数变体「等待你确认 · 2 项」、title 换最新（CONTRACT #21）', async () => {
    const { push } = armEvent();
    render(<HumanRequestToast />);
    await pushInserted(push, 's1', [row({ sessionId: 's1', title: '第一条请求' })]);
    await pushInserted(push, 's1', [
      row({ sessionId: 's1', title: '第一条请求' }),
      row({ sessionId: 's1', title: '第二条请求' }),
    ]);
    const toasts = screen.getAllByTestId('human-request-toast');
    expect(toasts).toHaveLength(1);
    expect(screen.getByText('等待你确认 · 2 项')).toBeInTheDocument();
    // 单条形态的旧 title 不再以单条形式出现（title 已被计数变体替换）
    expect(screen.queryByText('等待你确认 · 第二条请求')).toBeNull();
  });

  it('点击卡片主体 → selectSession(sessionId) 且吐司消散（CONTRACT #23）', async () => {
    const { push } = armEvent();
    render(<HumanRequestToast />);
    await pushInserted(push, 's1', [row({ sessionId: 's1', title: '跳转我' })]);
    fireEvent.click(screen.getByText('等待你确认 · 跳转我'));
    const selectSession = useSessionStore.getState().selectSession;
    expect(selectSession).toHaveBeenCalledWith('s1');
    expect(screen.queryByTestId('human-request-toast')).toBeNull();
  });

  it('6 秒自动消散；同会话更新重置消散计时（fake timers，CONTRACT #21/#23）', async () => {
    vi.useFakeTimers();
    try {
      const { push } = armEvent();
      render(<HumanRequestToast />);
      await pushInserted(push, 's1', [row({ sessionId: 's1', title: '稍后消散' })]);
      expect(screen.getByTestId('human-request-toast')).toBeInTheDocument();
      // 3s 处同会话更新 → 计时重锚：6s（原出生点）处不消散，9s（更新点+6s）才消散
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      await pushInserted(push, 's1', [
        row({ sessionId: 's1', title: '第一条请求' }),
        row({ sessionId: 's1', title: '第二条请求' }),
      ]);
      // 原出生点 +6s 处不消散（计时已被更新重锚到 t=3s+6s）
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(screen.getByTestId('human-request-toast')).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(screen.queryByTestId('human-request-toast')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('deadline<5min → 预警描边 + Bell 警示色 + 「剩余 N 分钟」chip；远期/无 deadline 走常规描边（CONTRACT #22）', async () => {
    const { push } = armEvent();
    render(<HumanRequestToast />);
    const now = Date.now();
    await pushInserted(
      push,
      's1',
      [row({ sessionId: 's1', title: '预警请求', deadlineAt: now + 2 * 60_000 })],
    );
    const warnToast = screen.getByTestId('human-request-toast');
    expect(warnToast.className).toContain('border-status-warning');
    expect(screen.getByText('剩余 2 分钟')).toBeInTheDocument();
    const bell = warnToast.querySelector('svg');
    expect(bell?.getAttribute('class')).toContain('text-status-warning');
    // 对照：无 deadline → 常规 border-subtle、无剩余 chip
    await pushInserted(push, 's9', [row({ sessionId: 's9', title: '常规请求' })]);
    const toasts = screen.getAllByTestId('human-request-toast');
    const plain = toasts.find((t) => t.textContent?.includes('常规请求')) as HTMLElement;
    expect(plain.className).toContain('border-subtle');
    expect(screen.queryByText(/剩余 \d+ 分钟/)).toBeInTheDocument(); // 预警条仍在场
  });

  it('手动关闭 × 移除条目', async () => {
    const { push } = armEvent();
    render(<HumanRequestToast />);
    await pushInserted(push, 's1', [row({ sessionId: 's1', title: '手动关' })]);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByTestId('human-request-toast')).toBeNull();
  });

  it('上限 4 条：第 5 个会话到达丢最旧并显示溢出行（CONTRACT #19）', async () => {
    const { push } = armEvent();
    render(<HumanRequestToast />);
    for (let i = 1; i <= 5; i++) {
      await pushInserted(push, `s${i}`, [row({ sessionId: `s${i}`, title: `请求${i}` })]);
    }
    expect(screen.getAllByTestId('human-request-toast')).toHaveLength(4);
    expect(screen.getByTestId('human-request-overflow').textContent).toContain('1');
    expect(screen.queryByText('等待你确认 · 请求1')).toBeNull();
    expect(screen.getByText('等待你确认 · 请求5')).toBeInTheDocument();
  });
});
