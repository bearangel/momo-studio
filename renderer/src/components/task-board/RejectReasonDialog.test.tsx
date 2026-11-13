// renderer/src/components/task-board/RejectReasonDialog.test.tsx
//
// 打回理由弹框测试（v2 生命周期 Task 21，预览定值清单 #17）：
//   - 理由必填语义：空/纯空白 → 确认钮禁用；输入后激活
//   - 确认 → onConfirm 收 trim 后理由；取消 → onClose 且 onConfirm 零调用
//   - 标题「打回返工」+ 任务副文案（#短ID · 标题 → 排队中（新 run））
// 纯 props 组件（无 ipc 依赖），无需 mock window.api。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RejectReasonDialog } from './RejectReasonDialog';
import type { TaskRow } from '../../ipc/types';

const task: TaskRow = {
  id: '9e4d1a2b', workspaceId: 'ws1', title: '订单超时自动取消', description: '', status: 'submitted',
  sourceSessionId: null, sourceMessageId: null, creatorUserId: 'owner', executionSessionId: null,
  assigneeAgentId: null, targetTeamId: null, targetSessionId: null, recurrenceParentId: null,
  priority: 5, scheduledAt: null, recurrenceRule: null, deadlineAt: null, queuePosition: null,
  runtimeInstanceId: null, estimatedTokens: null, actualTokens: null, toolCallsUsed: 0,
  errorMessage: null, sourceNodeId: null, createdAt: 0, updatedAt: 0, startedAt: null, completedAt: null,
  currentRunId: 'run-1', submittedAt: 1000, acceptedAt: null, delegationRole: null, autoAccept: false,
  groupId: null, pinnedAt: null, archivedAt: null, routing: { mode: 'local' }, delegationId: null,
  origin: 'user', parentTaskId: null,
};

function setup() {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(<RejectReasonDialog task={task} onConfirm={onConfirm} onClose={onClose} />);
  const textarea = screen.getByRole('textbox', { name: '打回理由' });
  const confirmBtn = screen.getByRole('button', { name: '确认打回' });
  const cancelBtn = screen.getByRole('button', { name: '取消' });
  return { onConfirm, onClose, textarea, confirmBtn, cancelBtn };
}

describe('RejectReasonDialog 打回理由弹框', () => {
  it('标题「打回返工」+ 任务副文案（#短ID · 标题 → 排队中（新 run））', () => {
    setup();
    expect(screen.getByRole('dialog', { name: '打回返工' })).toBeInTheDocument();
    expect(screen.getByText('#9e4d1a · 订单超时自动取消 → 排队中（新 run）')).toBeInTheDocument();
  });

  it('空理由 → 确认钮禁用；纯空白同禁用（trim 判定）', () => {
    const { textarea, confirmBtn } = setup();
    expect(confirmBtn).toBeDisabled();
    fireEvent.change(textarea, { target: { value: '   ' } });
    expect(confirmBtn).toBeDisabled();
  });

  it('输入理由 → 确认激活；确认 → onConfirm 收 trim 后理由', () => {
    const { onConfirm, onClose, textarea, confirmBtn } = setup();
    fireEvent.change(textarea, { target: { value: '  缺回滚语句，补上再提交  ' } });
    expect(confirmBtn).toBeEnabled();
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledWith('缺回滚语句，补上再提交');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('取消 → onClose 且 onConfirm 零调用（卡片归位零副作用）', () => {
    const { onConfirm, onClose, textarea, cancelBtn } = setup();
    fireEvent.change(textarea, { target: { value: '已填理由' } });
    fireEvent.click(cancelBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
