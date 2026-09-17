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
//   9. @/ 文件分组（Task 8）：@/ 触发文件搜索菜单（ipc.file.searchNames，
//      debounce 200ms / 仅文件 / 限 8 条）、选择插入 @/路径 标记 + chip、
//      chip 可移除、发送失败恢复、会话切换 chips 清空（正文草稿保留）
//   10. 既有 @ 成员菜单 / #T 任务菜单用例全部保留（回归锁——文件分组
//      不得破坏成员分支的触发正则与行为）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ResourceItem, SessionMemberInfo, TaskRow } from '../../ipc/types';

// vi.hoisted：mock store 状态在 vi.mock 工厂注册前完成初始化
const { sessionState, taskState, workspaceState } = vi.hoisted(() => ({
  sessionState: {
    activeSessionId: 'sess-1' as string | null,
    members: [] as SessionMemberInfo[],
    sendMessage: vi.fn(),
    loadSessions: vi.fn(),
    activeSessionReadOnly: false,
    inputFocusTick: 0,
    fileTriggerTick: 0,
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

// window.api mock：@ 菜单文件分组数据源（Task 8）+ / 菜单两组数据源（Task 9）。
// 组件经 ipc Proxy 直读 window.api（Task 8 file.searchNames / Task 9
// session.listCommands + resource.list 均为直调形态，不经 store）——不设置时
// 组件内对应 ipc 命名空间访问即抛错。
const mockApi = {
  file: {
    searchNames: vi.fn().mockResolvedValue([]),
  },
  session: {
    // 默认值仿真主进程 commands.ts SESSION_COMMANDS 真实注册表（单一真相源）
    listCommands: vi.fn().mockResolvedValue([{ name: 'compact', description: '压缩会话历史，释放上下文窗口' }]),
  },
  resource: {
    // 默认值仿真 resource:list({ type: 'skill' }) 真实形状：builtin skill
    // （catalog.json 的 code-review-workflow）+ 一个未安装项（锁 installed 过滤）
    list: vi.fn().mockResolvedValue([] as ResourceItem[]),
  },
};

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
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

/** 构造技能资源项（默认 builtin + 已安装，形状对齐 catalog.json 的 code-review-workflow） */
function makeSkillResource(overrides: Partial<ResourceItem> & { slug: string }): ResourceItem {
  return {
    id: `builtin-skill-${overrides.slug}`,
    type: 'skill',
    source: 'builtin',
    name: overrides.slug,
    description: '',
    installed: true,
    installable: false,
    removable: false,
    ...overrides,
  };
}

function resetState(): void {
  // 仅设置 api，不替换整个 window（保留 jsdom Window 的其它属性与方法，避免破坏 react-dom）
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  mockApi.file.searchNames.mockClear();
  mockApi.file.searchNames.mockResolvedValue([]);
  mockApi.session.listCommands.mockClear();
  mockApi.session.listCommands.mockResolvedValue([
    { name: 'compact', description: '压缩会话历史，释放上下文窗口' },
  ]);
  mockApi.resource.list.mockClear();
  mockApi.resource.list.mockResolvedValue([
    makeSkillResource({ slug: 'code-review-workflow', name: '代码审查工作流' }),
    makeSkillResource({ slug: 'not-installed-flow', name: '未安装技能', installed: false }),
  ]);
  sessionState.activeSessionId = 'sess-1';
  sessionState.members = [];
  sessionState.sendMessage = vi.fn().mockResolvedValue(undefined);
  sessionState.loadSessions = vi.fn().mockResolvedValue(undefined);
  sessionState.activeSessionReadOnly = false;
  sessionState.inputFocusTick = 0;
  sessionState.fileTriggerTick = 0;
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
    expect(screen.getByRole('button', { name: '移除 @PM-agent' })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: '移除 @PM-agent' }));
    expect(screen.queryByRole('button', { name: '移除 @PM-agent' })).not.toBeInTheDocument();
  });
});

describe('MentionInput #T 菜单（可激活任务）', () => {
  it('输入 #T 弹出可激活任务菜单（仅 draft/pending/assigned）——store 全量拉取后此为唯一过滤点', () => {
    // v2.3：task.store 现拉全生命周期任务，菜单只放行可激活三态；
    // in_progress/paused（活跃但已启动/暂停）与 completed 等终态一律不进菜单
    taskState.tasks = [
      makeTask({ id: 'T-001', title: '修复登录', status: 'pending' }),
      makeTask({ id: 'T-002', title: '已完成任务', status: 'completed' }),
      makeTask({ id: 'T-003', title: '执行中任务', status: 'in_progress' }),
      makeTask({ id: 'T-004', title: '已暂停任务', status: 'paused' }),
      makeTask({ id: 'T-005', title: '草稿任务', status: 'draft' }),
    ];
    render(<MentionInput />);
    fireEvent.change(screen.getByPlaceholderText(/输入消息/), { target: { value: '#T' } });
    expect(screen.getByText('选择要引用的任务')).toBeInTheDocument();
    expect(screen.getByText('#T-001 · 修复登录')).toBeInTheDocument();
    expect(screen.getByText('#T-005 · 草稿任务')).toBeInTheDocument();
    expect(screen.queryByText(/已完成任务/)).not.toBeInTheDocument();
    expect(screen.queryByText(/执行中任务/)).not.toBeInTheDocument();
    expect(screen.queryByText(/已暂停任务/)).not.toBeInTheDocument();
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
    expect(sessionState.sendMessage).toHaveBeenCalledWith('@PM-agent #T-001 请跟进', ['inst-pm'], undefined);
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
    expect(sessionState.sendMessage).toHaveBeenCalledWith('普通消息', undefined, undefined);
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
    expect(sessionState.sendMessage).toHaveBeenCalledWith('@PM-agent 你好', undefined, undefined);
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
    expect(screen.getByRole('button', { name: '移除 @PM-agent' })).toBeInTheDocument();
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
    expect(sessionState.sendMessage).toHaveBeenCalledWith('hello', undefined, undefined);
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

describe('MentionInput @ 菜单文件分组（@/ 路径引用，Task 8）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 推进防抖窗口（200ms）并冲刷微任务，让 searchNames 结果落进渲染 */
  const advanceDebounce = async (): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
  };

  it('输入 @/ 触发文件菜单并展示搜索结果', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockResolvedValue([
      { path: 'src/a.ts', isDirectory: false },
      { path: 'src/b.ts', isDirectory: false },
    ]);
    render(<MentionInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@/a' } });
    await advanceDebounce();
    expect(mockApi.file.searchNames).toHaveBeenCalledWith('ws-1', 'a');
    expect(screen.getByText(/选择要引用的文件/)).toBeInTheDocument();
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('src/b.ts')).toBeInTheDocument();
  });

  it('选择文件插入 @/路径 标记并登记 chip', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockResolvedValue([
      { path: 'src/a.ts', isDirectory: false },
      { path: 'src/b.ts', isDirectory: false },
    ]);
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '@/a' } });
    await advanceDebounce();
    fireEvent.click(screen.getByText('src/a.ts'));
    expect(ta.value).toMatch(/@\/src\/a\.ts\s$/);
    expect(screen.getByLabelText('移除文件 src/a.ts')).toBeInTheDocument();
    // 选择后菜单关闭
    expect(screen.queryByText(/选择要引用的文件/)).not.toBeInTheDocument();
  });

  it('chip 可移除', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockResolvedValue([
      { path: 'src/a.ts', isDirectory: false },
      { path: 'src/b.ts', isDirectory: false },
    ]);
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '@/a' } });
    await advanceDebounce();
    fireEvent.click(screen.getByText('src/a.ts'));
    fireEvent.click(screen.getByLabelText('移除文件 src/a.ts'));
    expect(screen.queryByLabelText('移除文件 src/a.ts')).not.toBeInTheDocument();
  });

  it('发送失败恢复文件 chips 与正文', async () => {
    vi.useFakeTimers();
    // brief 原文 vi.spyOn(ipc.session, 'send') 在 store 层 mock 架构下不可达
    // （组件消费 mocked sessionState.sendMessage）——照抄本文件既有失败注入形态
    sessionState.sendMessage = vi.fn().mockRejectedValue(new Error('boom'));
    mockApi.file.searchNames.mockResolvedValue([
      { path: 'src/a.ts', isDirectory: false },
      { path: 'src/b.ts', isDirectory: false },
    ]);
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '@/a' } });
    await advanceDebounce();
    fireEvent.click(screen.getByText('src/a.ts'));
    fireEvent.change(ta, { target: { value: '@/src/a.ts 看看这个' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(ta.value).toMatch(/@\/src\/a\.ts/);
    expect(screen.getByLabelText('移除文件 src/a.ts')).toBeInTheDocument();
  });

  it('仅输入 @/（空 query）不搜索——防抖窗口过后也不发 IPC', async () => {
    vi.useFakeTimers();
    render(<MentionInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@/' } });
    await advanceDebounce();
    expect(mockApi.file.searchNames).not.toHaveBeenCalled();
    // 无结果不渲染文件组
    expect(screen.queryByText(/选择要引用的文件/)).not.toBeInTheDocument();
  });

  it('目录命中被过滤、仅文件进菜单且限 8 条', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockResolvedValue([
      { path: 'docs', isDirectory: true },
      ...Array.from({ length: 10 }, (_, i) => ({
        path: `src/f${i}.ts`,
        isDirectory: false,
      })),
    ]);
    render(<MentionInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@/f' } });
    await advanceDebounce();
    expect(screen.queryByText('docs')).not.toBeInTheDocument();
    expect(screen.getByText('src/f0.ts')).toBeInTheDocument();
    expect(screen.getByText('src/f7.ts')).toBeInTheDocument();
    expect(screen.queryByText('src/f8.ts')).not.toBeInTheDocument();
    expect(screen.queryByText('src/f9.ts')).not.toBeInTheDocument();
  });

  it('searchNames 失败 → 不渲染文件组且不崩（错误路径）', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockRejectedValue(new Error('boom'));
    render(<MentionInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@/a' } });
    await advanceDebounce();
    expect(screen.queryByText(/选择要引用的文件/)).not.toBeInTheDocument();
    expect(screen.queryByText('src/a.ts')).not.toBeInTheDocument();
  });

  it('会话切换清空文件 chips，正文里的 @/路径 文本随草稿保留', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockResolvedValue([
      { path: 'src/a.ts', isDirectory: false },
      { path: 'src/b.ts', isDirectory: false },
    ]);
    const { rerender } = render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '@/a' } });
    await advanceDebounce();
    fireEvent.click(screen.getByText('src/a.ts'));
    expect(screen.getByLabelText('移除文件 src/a.ts')).toBeInTheDocument();

    // 切走：chips 清空（MVP 取舍：不按正文标记重建，实现注释已标注）
    sessionState.activeSessionId = 'sess-2';
    rerender(<MentionInput />);
    expect(screen.queryByLabelText('移除文件 src/a.ts')).not.toBeInTheDocument();

    // 切回：正文草稿（含 @/ 路径文本）恢复，chips 不恢复
    sessionState.activeSessionId = 'sess-1';
    rerender(<MentionInput />);
    expect(ta.value).toMatch(/@\/src\/a\.ts/);
    expect(screen.queryByLabelText('移除文件 src/a.ts')).not.toBeInTheDocument();
  });
});

describe('MentionInput / 菜单（命令 + 技能两组，Task 9）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const advanceDebounce = async (): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
  };

  it('空 body 输入 / 触发命令+技能两组菜单；未安装技能不出现', async () => {
    render(<MentionInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/' } });
    expect(await screen.findByText('命令')).toBeInTheDocument();
    expect(screen.getByText('技能')).toBeInTheDocument();
    expect(screen.getByText('/compact')).toBeInTheDocument();
    expect(screen.getByText(/压缩会话历史/)).toBeInTheDocument();
    expect(screen.getByText('代码审查工作流')).toBeInTheDocument();
    expect(screen.queryByText('未安装技能')).not.toBeInTheDocument();
  });

  it('选择命令插入 /name 文本（尾随空格）并关闭菜单', async () => {
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '/com' } });
    fireEvent.click(await screen.findByText('/compact'));
    expect(ta.value).toBe('/compact ');
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
  });

  it('选择技能登记 chip 且 body 不插文本', async () => {
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '/code' } });
    fireEvent.click(await screen.findByText('代码审查工作流'));
    expect(ta.value).toBe('');
    expect(screen.getByLabelText('移除技能 代码审查工作流')).toBeInTheDocument();
    expect(screen.queryByText('技能')).not.toBeInTheDocument();
  });

  it('技能 chip 可移除；重复选择同一技能去重', async () => {
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '/code' } });
    fireEvent.click(await screen.findByText('代码审查工作流'));
    fireEvent.change(ta, { target: { value: '/' } });
    // 菜单行按钮可访问名 = 裸名，chip 按钮 = aria-label「移除技能 …」——精确名唯一定位菜单行
    fireEvent.click(screen.getByRole('button', { name: '代码审查工作流' }));
    expect(screen.getAllByLabelText('移除技能 代码审查工作流')).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('移除技能 代码审查工作流'));
    expect(screen.queryByLabelText('移除技能 代码审查工作流')).not.toBeInTheDocument();
  });

  it('query 过滤：/comp 仅命中命令组，/zzz 无匹配整菜单收起', async () => {
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '/' } });
    await screen.findByText('命令');
    fireEvent.change(ta, { target: { value: '/comp' } });
    expect(screen.getByText('命令')).toBeInTheDocument();
    expect(screen.queryByText('技能')).not.toBeInTheDocument();
    fireEvent.change(ta, { target: { value: '/zzz' } });
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
    expect(screen.queryByText('技能')).not.toBeInTheDocument();
  });

  it('菜单激活时 Enter 不发送（命令菜单）', async () => {
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '/' } });
    await screen.findByText('命令');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(sessionState.sendMessage).not.toHaveBeenCalled();
  });

  it('Escape 关命令菜单', async () => {
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '/' } });
    await screen.findByText('命令');
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
  });

  it('空 body + 技能 chip 可发送（context 透传，技能正文即 prompt）', async () => {
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '/code' } });
    fireEvent.click(await screen.findByText('代码审查工作流'));
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    expect(sessionState.sendMessage).toHaveBeenCalledWith(
      '',
      undefined,
      { skills: [{ slug: 'code-review-workflow', name: '代码审查工作流' }], files: [] },
    );
    expect(screen.queryByLabelText('移除技能 代码审查工作流')).not.toBeInTheDocument();
    expect(sessionState.loadSessions).toHaveBeenCalled();
  });

  it('技能 + 文件 chip 组装完整 context 发送', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockResolvedValue([
      { path: 'src/a.ts', isDirectory: false },
    ]);
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '/code' } });
    await advanceDebounce();
    fireEvent.click(screen.getByText('代码审查工作流'));
    fireEvent.change(ta, { target: { value: '@/a' } });
    await advanceDebounce();
    fireEvent.click(screen.getByText('src/a.ts'));
    fireEvent.change(ta, { target: { value: '@/src/a.ts 帮我看看' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(sessionState.sendMessage).toHaveBeenCalledWith(
      '@/src/a.ts 帮我看看',
      undefined,
      {
        skills: [{ slug: 'code-review-workflow', name: '代码审查工作流' }],
        files: [{ path: 'src/a.ts' }],
      },
    );
  });

  it('body 非空时不触发 / 菜单（回归锁——句中 / 不属于命令命名空间）', async () => {
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    // 等挂载数据就绪并确认菜单可开，排除「数据未到」假阴性
    fireEvent.change(ta, { target: { value: '/' } });
    await screen.findByText('命令');
    fireEvent.change(ta, { target: { value: '看下' } });
    fireEvent.change(ta, { target: { value: '看下/' } });
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
    expect(screen.queryByText('技能')).not.toBeInTheDocument();
  });

  it('// 转义路径：第二个 / 即关菜单，Enter 原样发送 //（strip 在 session.store）', async () => {
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '/' } });
    await screen.findByText('命令');
    // 第二个 / 不在命令字符集 [A-Za-z0-9-] 内：命令正则不命中，菜单关闭
    fireEvent.change(ta, { target: { value: '//' } });
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
    fireEvent.change(ta, { target: { value: '//not-a-command' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    expect(sessionState.sendMessage).toHaveBeenCalledWith('//not-a-command', undefined, undefined);
  });

  it('发送失败恢复技能 chips 与正文', async () => {
    sessionState.sendMessage = vi.fn().mockRejectedValue(new Error('boom'));
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '/code' } });
    fireEvent.click(await screen.findByText('代码审查工作流'));
    fireEvent.change(ta, { target: { value: '帮我审查这段逻辑' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(ta.value).toBe('帮我审查这段逻辑'));
    expect(screen.getByLabelText('移除技能 代码审查工作流')).toBeInTheDocument();
  });

  it('会话切换清空技能 chips（与 pendingMentions/files 同生命周期）', async () => {
    const { rerender } = render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '/code' } });
    fireEvent.click(await screen.findByText('代码审查工作流'));
    expect(screen.getByLabelText('移除技能 代码审查工作流')).toBeInTheDocument();
    sessionState.activeSessionId = 'sess-2';
    rerender(<MentionInput />);
    expect(screen.queryByLabelText('移除技能 代码审查工作流')).not.toBeInTheDocument();
  });

  it('listCommands 失败 → 菜单不渲染且不崩（错误路径静默）', async () => {
    mockApi.session.listCommands.mockRejectedValue(new Error('boom'));
    render(<MentionInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/' } });
    await act(async () => {});
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeEnabled();
  });

  it('resource.list 失败 → 技能组缺席，命令组不受影响（错误路径静默）', async () => {
    mockApi.resource.list.mockRejectedValue(new Error('boom'));
    render(<MentionInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/' } });
    expect(await screen.findByText('命令')).toBeInTheDocument();
    expect(screen.queryByText('代码审查工作流')).not.toBeInTheDocument();
  });
});

describe('MentionInput 📎 文件触发（fileTriggerTick，Task 10）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const advanceDebounce = async (): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
  };

  it('fileTriggerTick 递增 → 聚焦 + 空正文插入 @/；继续输入即出文件菜单', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockResolvedValue([{ path: 'src/a.ts', isDirectory: false }]);
    const { rerender } = render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(document.activeElement).not.toBe(ta);

    sessionState.fileTriggerTick = 1;
    rerender(<MentionInput />);
    expect(document.activeElement).toBe(ta);
    expect(ta.value).toBe('@/');
    // @/ 就位后用户继续输入查询词 → 文件菜单弹出（文件分支接管）
    fireEvent.change(ta, { target: { value: '@/a' } });
    await advanceDebounce();
    expect(screen.getByText(/选择要引用的文件/)).toBeInTheDocument();
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
  });

  it('已有正文以非空白收尾 → 追加空格防粘连（hello → hello @/）', () => {
    const { rerender } = render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'hello' } });
    sessionState.fileTriggerTick = 1;
    rerender(<MentionInput />);
    expect(ta.value).toBe('hello @/');
  });

  it('已有正文以空白收尾 → 直接追加不产生双空格（"hello " → "hello @/"）', () => {
    const { rerender } = render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'hello ' } });
    sessionState.fileTriggerTick = 1;
    rerender(<MentionInput />);
    expect(ta.value).toBe('hello @/');
  });

  it('effect 内直调 detectTrigger：命令菜单打开时触发 → 旧菜单立即关闭（文件态接管）', async () => {
    const { rerender } = render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '/' } });
    expect(await screen.findByText('命令')).toBeInTheDocument();

    sessionState.fileTriggerTick = 1;
    rerender(<MentionInput />);
    // '/' 以非空白收尾 → '/ @/'；detectTrigger 同步刷新菜单态：命令菜单让位
    expect(ta.value).toBe('/ @/');
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
  });

  it('tick=0（初始）不插入 @/ 也不抢焦点', () => {
    render(<MentionInput />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(ta.value).toBe('');
    expect(document.activeElement).not.toBe(ta);
  });
});

// === v2.11.1 F1：触发正则放宽（中文过滤）——旧字符集 [A-Za-z0-9-] 不含中文，
// 敲中文名菜单即关（预置技能名恰是中文）===
describe('MentionInput 触发正则放宽（v2.11.1 F1：中文过滤）', () => {
  it('/代码 → 命令菜单技能组按中文名过滤（含中文名技能命中、其它排除）', async () => {
    mockApi.resource.list.mockResolvedValue([
      makeSkillResource({ slug: 'code-review', name: '代码审查' }),
      makeSkillResource({ slug: 'write-tests', name: '写测试' }),
    ]);
    render(<MentionInput />);
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: '/代码' } });
    await waitFor(() => expect(screen.getByText('代码审查')).toBeTruthy());
    expect(screen.queryByText('写测试')).toBeNull();
    // 命令组不被中文 query 误杀：compact 不含「代码」，整组不渲染即可（断言其不存在）
    expect(screen.queryByText('/compact')).toBeNull();
  });

  it('@中文名 → agent 菜单按中文 agentName 过滤', async () => {
    sessionState.members = [
      makeMember({ instanceId: 'i-1', agentName: '代码助手' }),
      makeMember({ instanceId: 'i-2', agentName: 'writer' }),
    ];
    render(<MentionInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@代码' } });
    await waitFor(() => expect(screen.getByText('代码助手')).toBeTruthy());
    expect(screen.queryByText('writer')).toBeNull();
  });

  it('#中文 → 任务菜单按中文标题过滤', async () => {
    taskState.tasks = [
      makeTask({ id: 'T-1', title: '修复登录' }),
      makeTask({ id: 'T-2', title: '写文档' }),
    ];
    render(<MentionInput />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '#登录' } });
    await waitFor(() => expect(screen.getByText(/修复登录/)).toBeTruthy());
    expect(screen.queryByText(/写文档/)).toBeNull();
  });

  it('语义保持：句中 / 不触发命令菜单、// 转义不触发、正文后 @ 不弹成员菜单', () => {
    render(<MentionInput />);
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: '看下 src/文件' } });
    expect(screen.queryByText('命令')).toBeNull();
    fireEvent.change(ta, { target: { value: '//' } });
    expect(screen.queryByText('命令')).toBeNull();
    fireEvent.change(ta, { target: { value: '邮箱a@b.com不发菜单' } });
    expect(screen.queryByText('选择要 @ 的 agent')).toBeNull();
  });
});
