// renderer/src/components/im/BudgetRenewalCard.test.tsx
//
// 续期卡三动作契约：
//   1. 继续任务 → sendMessage 收到续作指令（含「不要重做」语义），卡片定格「已发送」
//   2. 本会话无限制 → 先 updateSession(maxToolCalls=-1) 再 sendMessage（顺序保证续作回合即无限）
//   3. 就此停止 → 无任何发送/写库，卡片定格「已停止」
//   4. sendMessage 失败 → 卡片保留按钮并显示错误（可重试）
//
// mock 边界（momo-test-rules）：只 mock IPC / store 边界，组件真实渲染。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BudgetRenewalCard, BUDGET_RENEWAL_MESSAGE } from './BudgetRenewalCard';
import { useSessionStore } from '../../stores/session.store';
import { ipc } from '../../ipc/client';

const sendMock = vi.hoisted(() => vi.fn());
const updateSessionMock = vi.hoisted(() => vi.fn());

vi.mock('../../stores/session.store', () => ({
  useSessionStore: {
    getState: () => ({ sendMessage: sendMock }),
  },
}));

vi.mock('../../ipc/client', () => ({
  ipc: { settings: { updateSession: updateSessionMock } },
}));

describe('BudgetRenewalCard 三动作', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMock.mockResolvedValue(undefined);
    updateSessionMock.mockResolvedValue(undefined);
  });

  function card(): ReturnType<typeof render> {
    return render(<BudgetRenewalCard sessionId="s-1" toolCallsUsed={50} />);
  }

  it('初始渲染：标题含已用次数与三按钮', () => {
    card();
    expect(screen.getByText(/本回合 50 次调用/)).toBeDefined();
    expect(screen.getByRole('button', { name: /继续任务/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /本会话无限制/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /就此停止/ })).toBeDefined();
  });

  it('继续任务：发送续作指令并定格已发送', async () => {
    card();
    fireEvent.click(screen.getByRole('button', { name: /继续任务/ }));
    await waitFor(() => {
      expect(screen.getByText(/已发送续作指令/)).toBeDefined();
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(BUDGET_RENEWAL_MESSAGE);
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  it('本会话无限制：先写 -1 再续作（顺序）', async () => {
    card();
    fireEvent.click(screen.getByRole('button', { name: /本会话无限制/ }));
    await waitFor(() => {
      expect(screen.getByText(/已切换为无限制/)).toBeDefined();
    });
    expect(updateSessionMock).toHaveBeenCalledWith('s-1', { maxToolCalls: -1 });
    expect(sendMock).toHaveBeenCalledTimes(1);
    // 顺序锁：写库必须先于发送（否则续作回合仍受旧上限）
    const updateOrder = updateSessionMock.mock.invocationCallOrder[0]!;
    const sendOrder = sendMock.mock.invocationCallOrder[0]!;
    expect(updateOrder).toBeLessThan(sendOrder);
  });

  it('就此停止：零发送零写库，定格已停止', () => {
    card();
    fireEvent.click(screen.getByRole('button', { name: /就此停止/ }));
    expect(screen.getByText(/已停止/)).toBeDefined();
    expect(sendMock).not.toHaveBeenCalled();
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  it('发送失败：错误可见且按钮可重试', async () => {
    sendMock.mockRejectedValueOnce(new Error('会话已失效'));
    card();
    fireEvent.click(screen.getByRole('button', { name: /继续任务/ }));
    await waitFor(() => {
      expect(screen.getByText(/会话已失效/)).toBeDefined();
    });
    // 卡片未定格——重试成功后定格
    sendMock.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: /继续任务/ }));
    await waitFor(() => {
      expect(screen.getByText(/已发送续作指令/)).toBeDefined();
    });
  });
});
