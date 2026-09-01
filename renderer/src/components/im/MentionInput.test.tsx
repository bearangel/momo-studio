// renderer/src/components/im/MentionInput.test.tsx
//
// MentionInput 现役化测试（P3 Task 3：@ + # 双语法输入框替换 MessageInput）：
//   1. 空态 parity：无激活会话 → 禁用 + 「请先选择房间」placeholder
//   2. 挂载接线：workspace 存在时拉取 task.store（IM 视图此前无人加载任务）
//   3. 输入 @ 弹出在线成员菜单（数据源 session.store.members，仅 lastRunning）
//   4. 输入 #T 弹出待处理任务菜单（仅 draft/pending/assigned）
//   5. 选择后正文插入标记（@agentName / #T-xxx，尾随空格）
//   6. 发送载荷：sendMessage(body, mentionedAssignmentIds)——@ 走 assignmentId，
//      #T 任务标记只进正文（主进程 conflict-detector 从正文解析）
//   7. 菜单激活时 Enter 不发送；Escape 关菜单（原 MessageInput 行为 parity）
//   8. 发送失败恢复正文与 mentions（原 MessageInput 行为 parity）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SessionMemberInfo, TaskRow } from '../../ipc/types';

// vi.hoisted：mock store 状态在 vi.mock 工厂注册前完成初始化
const { sessionState, taskState, workspaceState } = vi.hoisted(() => ({
  sessionState: {
    activeSessionId: 'sess-1' as string | null,
    members: [] as SessionMemberInfo[],
    sendMessage: vi.fn(),
    loadSessions: vi.fn(),
    activeSessionReadOnly: false,
    inputFocusTick: 0,
  },
  taskState: {
    tasks: [] as TaskRow[],
    load: vi.fn(),
  },
  workspaceState: {
    getActive: () => ({ id: 'ws-1', name: 'ws' }),
  },
}));

vi.mock('../../stores/session.store', () => ({
  useSessionStore: (selector: (s: typeof sessionState) => unknown) => selector(sessionState),
}));
vi.mock('../../stores/task.store', () => ({
  useTaskStore: (selector?: (s: typeof taskState) => unknown) =>
    selector ? selector(taskState) : taskState,
}));
vi.mock('../../stores/workspace.store', () => ({
  useWorkspaceStore: (selector: (s: typeof workspaceState) => unknown) => selector(workspaceState),
}));

import { MentionInput } from './MentionInput';

/** 构造会话成员（默认在线） */
function makeMember(overrides: Partial<SessionMemberInfo>): SessionMemberInfo {
  return {
    instanceId: 'inst-1',
    agentName: 'PM-agent',
    iconEmoji: '🤖',
    lastRunning: true,
    isLeader: false,
    ...overrides,
  };
}

/** 构造任务行（默认 pending 态） */
function makeTask(overrides: Partial<TaskRow> & { id: string }): TaskRow {
  return {
    workspaceId: 'ws-1',
    title: '任务',
    description: '',
    status: 'pending',
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'owner',
    executionSessionId: null,
    assigneeAgentId: null,
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
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function resetState(): void {
  sessionState.activeSessionId = 'sess-1';
  sessionState.members = [];
  sessionState.sendMessage = vi.fn().mockResolvedValue(undefined);
  sessionState.loadSessions = vi.fn().mockResolvedValue(undefined);
  sessionState.activeSessionReadOnly = false;
  sessionState.inputFocusTick = 0;
  taskState.tasks = [];
  taskState.load = vi.fn().mockResolvedValue(undefined);
}

beforeEach(() => {
  resetState();
});

describe('MentionInput 空态与挂载接线', () => {
  it('无激活会话时输入框禁用 + 提示先选房间', () => {
    sessionState.activeSessionId = null;
    render(<MentionInput />);
    const textarea = screen.getByPlaceholderText('请先选择房间');
    expect(textarea).toBeDisabled();
  });

  it('有激活会话时输入框启用', () => {
    render(<MentionInput />);
    expect(screen.getByPlaceholderText(/输入消息/)).toBeEnabled();
  });

  it('挂载时拉取当前 workspace 的任务列表（# 菜单数据源）', () => {
    render(<MentionInput />);
    expect(taskState.load).toHaveBeenCalledWith('ws-1');
  });
});

describe('MentionInput 只读态（v25 spec §7「会话只读」）', () => {
  it('activeSessionReadOnly=true → 输入框禁用 + 只读提示可见', () => {
    sessionState.activeSessionReadOnly = true;
    render(<MentionInput />);
    const textarea = screen.getByPlaceholderText(/输入消息|只读/) as HTMLTextAreaElement;
    expect(textarea).toBeDisabled();
    expect(screen.getByText(/会话只读/)).toBeInTheDocument();
  });

  it('activeSessionReadOnly=false → 输入框启用、无只读提示', () => {
    render(<MentionInput />);
    expect(screen.getByPlaceholderText(/输入消息/)).toBeEnabled();
    expect(screen.queryByText(/会话只读/)).not.toBeInTheDocument();
  });
});

describe('MentionInput 聚焦信号（新建会话后聚焦输入框，spec §6.2 ⚡ 免弹窗直达）', () => {
  it('inputFocusTick 递增 → textarea 获得焦点', () => {
    const { rerender } = render(<MentionInput />);
    const textarea = screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
    expect(document.activeElement).not.toBe(textarea);

    sessionState.inputFocusTick = 1;
    rerender(<MentionInput />);
    expect(document.activeElement).toBe(textarea);
  });

  it('tick 为 0（初始）不抢焦点', () => {
    render(<MentionInput />);
    const textarea = screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
    expect(document.activeElement).not.toBe(textarea);
  });
});

describe('MentionInput @ 菜单（在线成员）', () => {
  it('输入 @ 弹出在线成员菜单，离线成员不显示', () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-pm', agentName: 'PM-agent', lastRunning: true }),
      makeMember({ instanceId: 'inst-qa', agentName: 'QA-agent', lastRunning: false }),
    ];
    render(<MentionInput />);
    fireEvent.change(screen.getByPlaceholderText(/输入消息/), { target: { value: '@' } });
    expect(screen.getByText('选择要 @ 的 agent')).toBeInTheDocument();
    expect(screen.getByText('PM-agent')).toBeInTheDocument();
    expect(screen.queryByText('QA-agent')).not.toBeInTheDocument();
  });

  it('输入 @qa 时离线成员被过滤，菜单不渲染', () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-qa', agentName: 'QA-agent', lastRunning: false }),
    ];
    render(<MentionInput />);
    fireEvent.change(screen.getByPlaceholderText(/输入消息/), { target: { value: '@qa' } });
    expect(screen.queryByText('选择要 @ 的 agent')).not.toBeInTheDocument();
  });

  it('点击成员菜单项插入 @标记（尾随空格）并显示可删除 chip', () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-pm', agentName: 'PM-agent', lastRunning: true }),
    ];
    render(<MentionInput />);
    const input = screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@' } });
    fireEvent.click(screen.getByText('PM-agent'));
    expect(input.value).toContain('@PM-agent ');
    expect(screen.getByText('@PM-agent ×')).toBeInTheDocument();
    // 菜单关闭
    expect(screen.queryByText('选择要 @ 的 agent')).not.toBeInTheDocument();
  });

  it('点击 chip 移除对应 mention', () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-pm', agentName: 'PM-agent', lastRunning: true }),
    ];
    render(<MentionInput />);
    const input = screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@' } });
    fireEvent.click(screen.getByText('PM-agent'));
    fireEvent.click(screen.getByText('@PM-agent ×'));
    expect(screen.queryByText('@PM-agent ×')).not.toBeInTheDocument();
  });
});

describe('MentionInput #T 菜单（待处理任务）', () => {
  it('输入 #T 弹出待处理任务菜单，完结任务不显示', () => {
    taskState.tasks = [
      makeTask({ id: 'T-001', title: '修复登录', status: 'pending' }),
      makeTask({ id: 'T-002', title: '已完成任务', status: 'completed' }),
    ];
    render(<MentionInput />);
    fireEvent.change(screen.getByPlaceholderText(/输入消息/), { target: { value: '#T' } });
    expect(screen.getByText('选择要引用的任务')).toBeInTheDocument();
    expect(screen.getByText('#T-001 · 修复登录')).toBeInTheDocument();
    expect(screen.queryByText(/已完成任务/)).not.toBeInTheDocument();
  });

  it('点击任务菜单项插入 #T 标记（尾随空格）', () => {
    taskState.tasks = [makeTask({ id: 'T-001', title: '修复登录' })];
    render(<MentionInput />);
    const input = screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '#T' } });
    fireEvent.click(screen.getByText('#T-001 · 修复登录'));
    expect(input.value).toContain('#T-001 ');
  });
});

describe('MentionInput 发送', () => {
  it('Enter 发送：载荷 = (正文, [assignmentId])，#T 标记只进正文', async () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-pm', agentName: 'PM-agent', lastRunning: true }),
    ];
    taskState.tasks = [makeTask({ id: 'T-001', title: '修复登录' })];
    render(<MentionInput />);
    const input = screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
    // 选 agent + 选任务 + 补正文
    fireEvent.change(input, { target: { value: '@' } });
    fireEvent.click(screen.getByText('PM-agent'));
    fireEvent.change(input, { target: { value: '@PM-agent #T' } });
    fireEvent.click(screen.getByText('#T-001 · 修复登录'));
    fireEvent.change(input, { target: { value: '@PM-agent #T-001 请跟进' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    expect(sessionState.sendMessage).toHaveBeenCalledWith('@PM-agent #T-001 请跟进', ['inst-pm']);
    // 发送后清空 + 刷新会话列表
    expect(input.value).toBe('');
    expect(sessionState.loadSessions).toHaveBeenCalled();
  });

  it('无 mention 时第二参为 undefined', async () => {
    render(<MentionInput />);
    const input = screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '普通消息' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    expect(sessionState.sendMessage).toHaveBeenCalledWith('普通消息', undefined);
  });

  it('空正文 Enter 不发送', () => {
    render(<MentionInput />);
    const input = screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sessionState.sendMessage).not.toHaveBeenCalled();
  });

  it('菜单激活时 Enter 不发送，Escape 关菜单后可发送', () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-pm', agentName: 'PM-agent', lastRunning: true }),
    ];
    render(<MentionInput />);
    const input = screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sessionState.sendMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByText('选择要 @ 的 agent')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '@PM-agent 你好' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sessionState.sendMessage).toHaveBeenCalledWith('@PM-agent 你好', undefined);
  });

  it('发送失败恢复正文与 mentions', async () => {
    sessionState.sendMessage = vi.fn().mockRejectedValue(new Error('send failed'));
    sessionState.members = [
      makeMember({ instanceId: 'inst-pm', agentName: 'PM-agent', lastRunning: true }),
    ];
    render(<MentionInput />);
    const input = screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@' } });
    fireEvent.click(screen.getByText('PM-agent'));
    fireEvent.change(input, { target: { value: '@PM-agent 请处理' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe('@PM-agent 请处理'));
    expect(screen.getByText('@PM-agent ×')).toBeInTheDocument();
  });
});

describe('MentionInput 输入法组合期 Enter（中文拼音选字不误发）', () => {
  it('isComposing=true 的 Enter 不发送（拼音选字确认）', () => {
    resetState();
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '你好' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false, isComposing: true } as unknown as Parameters<typeof fireEvent.keyDown>[1]);
    expect(sessionState.sendMessage).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('你好');
  });

  it('keyCode 229（IME 事件）的 Enter 不发送', () => {
    resetState();
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'nihao' } });
    fireEvent.keyDown(ta, { key: 'Enter', keyCode: 229 } as unknown as Parameters<typeof fireEvent.keyDown>[1]);
    expect(sessionState.sendMessage).not.toHaveBeenCalled();
  });

  it('非组合期 Enter 正常发送（回归保护）', () => {
    resetState();
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'hello' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false, isComposing: false } as unknown as Parameters<typeof fireEvent.keyDown>[1]);
    expect(sessionState.sendMessage).toHaveBeenCalledWith('hello', undefined);
  });
});

describe('MentionInput 会话草稿（切换会话内容隔离）', () => {
  it('切换会话后输入框显示目标会话的草稿（无则空）', () => {
    resetState();
    const { rerender } = render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '会话A的草稿' } });

    sessionState.activeSessionId = 'sess-2';
    rerender(<MentionInput />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');

    sessionState.activeSessionId = 'sess-1';
    rerender(<MentionInput />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('会话A的草稿');
  });
});
