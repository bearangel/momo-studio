// renderer/src/components/im/MentionInput.test.tsx
//
// MentionInput 现役化测试（v3 Task 3：RichComposer 内联 pill 集成）：
//   1. 空态 parity：无激活会话 / 只读 → contenteditable=false + data-placeholder 提示
//   2. 挂载接线：workspace 存在时拉取 task.store（# 菜单数据源）
//   3. 菜单触发（@ 双源 / #T 任务 / / 命令+技能）：输入经 typeInEditor 模拟
//      contentEditable 输入（设 textContent + 光标 + input 事件），断言对象是
//      菜单渲染与过滤（含中文过滤、默认列表、错误路径）——textarea 时代语义保持
//   4. 选择类：五类 selectX → 编辑器内原子 pill（span[data-kind][data-id] 是
//      getSegments 反向提取契约）；底部 chip 行退役（无「移除 xxx」按钮）
//   5. 发送载荷：sendMessage(body, mentions, context) 三参由 serializeSegments
//      产生——命令 pill 单独恰为 '/name'（整串拦截形态保持）、命令 pill 混排按
//      普通消息发送、重复 pill 结构化数组去重、空 body + 仅技能 pill 合法发送
//   6. 失败恢复：发送失败 → setSegments 快照，pill 原位恢复
//   7. 会话草稿：segments JSON 往返（切走清空、切回 pill 与正文不丢）
//   8. IME 组字期 Enter 不发送（守卫在 RichComposer 内，此处锁集成层不误发）
//   9. 📎 fileTriggerTick：focus + insertTextAtEnd('@') 直开菜单 + 防粘连空格
//  10. F3 容器：pill 在编辑器内（pills-in-editor）、📎 仍在 .rounded-lg 容器框内
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
    // 仿真真实 store 的 bumpFileTrigger 语义（fileTriggerTick +1）；
    // 箭头体在调用时才执行，sessionState 届时已初始化
    bumpFileTrigger: vi.fn(() => {
      sessionState.fileTriggerTick += 1;
    }),
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
  // 📎 onClick 经 useSessionStore.getState().bumpFileTrigger() 触发——真实
  // zustand store 的 getState 挂在 hook 函数自身，mock 同形（Object.assign
  // 保留函数可调用性并追加属性，不改模块导出形状）
  useSessionStore: Object.assign(
    (selector: (s: typeof sessionState) => unknown) => selector(sessionState),
    { getState: () => sessionState },
  ),
}));
vi.mock('../../stores/task.store', () => ({
  useTaskStore: (selector?: (s: typeof taskState) => unknown) =>
    selector ? selector(taskState) : taskState,
}));
vi.mock('../../stores/workspace.store', () => ({
  useWorkspaceStore: (selector: (s: typeof workspaceState) => unknown) => selector(workspaceState),
}));

// window.api mock：@ 菜单文件分组数据源 + / 菜单两组数据源。组件经 ipc Proxy
// 直读 window.api（直调形态不经 store）——不设置时组件内对应 ipc 命名空间
// 访问即抛错。
const mockApi = {
  file: {
    searchNames: vi.fn().mockResolvedValue([]),
    // @ 统一菜单空 query 默认列表数据源（根目录 ipc.file.list）
    list: vi.fn().mockResolvedValue([]),
  },
  session: {
    // 默认值仿真主进程 commands.ts SESSION_COMMANDS 真实注册表（单一真相源）
    listCommands: vi.fn().mockResolvedValue([{ name: 'compact', description: '压缩会话历史，释放上下文窗口' }]),
  },
  resource: {
    // 默认值仿真 resource:list({ type: 'skill' }) 真实形状：builtin skill
    // + 一个未安装项（锁 installed 过滤）
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

/** 定位 RichComposer 编辑面（aria-label「消息输入框」——contentEditable div） */
function editor(): HTMLElement {
  return screen.getByRole('textbox', { name: '消息输入框' }) as HTMLElement;
}

/** 设光标到指定节点 offset（jsdom 手动建 Range——与 RichComposer.test 既有辅助同法） */
function setCaret(node: Node, offset: number): void {
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * 整串输入（textarea 时代 fireEvent.change 的 contentEditable 对等）：
 * 设 textContent + 光标移末 + 派发 input 事件（onInputText 依赖光标位置，
 * setCaret 必须在 fireEvent.input 之前）。适用从零输入 / 纯文本重输场景——
 * 会清掉已有 pill；pill 就位后继续输入用 typeAtEnd。
 */
function typeInEditor(el: HTMLElement, text: string): void {
  el.textContent = text;
  const last = el.lastChild;
  if (last !== null) {
    setCaret(
      last,
      last.nodeType === Node.TEXT_NODE ? (last as Text).length : last.childNodes.length,
    );
  }
  fireEvent.input(el);
}

/**
 * 末尾追加输入（pill 就位后继续敲的保真模拟）：append 到末文本节点
 * （协议下 pill 后必有 ZWSP 文本节点即 lastChild），不重置编辑器、
 * 不破坏已有 pill——与真实浏览器在光标处打字等价。
 */
function typeAtEnd(el: HTMLElement, text: string): void {
  let last = el.lastChild;
  if (last === null || last.nodeType !== Node.TEXT_NODE) {
    const node = document.createTextNode('');
    el.appendChild(node);
    last = node;
  }
  const t = last as Text;
  t.appendData(text);
  setCaret(t, t.length);
  fireEvent.input(el);
}

/** 编辑器可见文本（textContent 剥 ZWSP——含 pill 显示文本，断言输入形态用） */
function visibleText(el: HTMLElement): string {
  return (el.textContent ?? '').replaceAll('\u200b', '');
}

/** 编辑器内是否存在指定 pill（data-kind + data-id 是 getSegments 反向提取契约） */
function hasPill(el: HTMLElement, kind: string, id: string): boolean {
  return el.querySelector(`span[data-kind="${kind}"][data-id="${id}"]`) !== null;
}

function resetState(): void {
  // 仅设置 api，不替换整个 window（保留 jsdom Window 的其它属性与方法，避免破坏 react-dom）
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  mockApi.file.searchNames.mockClear();
  mockApi.file.searchNames.mockResolvedValue([]);
  mockApi.file.list.mockClear();
  mockApi.file.list.mockResolvedValue([]);
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
  // 每用例还原 bumpFileTrigger 实现——防上个用例替换实现或跨用例残留影响递增语义
  sessionState.bumpFileTrigger = vi.fn(() => {
    sessionState.fileTriggerTick += 1;
  });
  taskState.tasks = [];
  taskState.load = vi.fn().mockResolvedValue(undefined);
}

beforeEach(() => {
  resetState();
});

describe('MentionInput 空态与挂载接线', () => {
  it('无激活会话时编辑面禁用（contenteditable=false）+ 提示先选房间', () => {
    sessionState.activeSessionId = null;
    render(<MentionInput />);
    const el = editor();
    expect(el).toHaveAttribute('data-placeholder', '请先选择房间');
    expect(el).toHaveAttribute('contenteditable', 'false');
  });

  it('有激活会话时编辑面可用（contenteditable=true）', () => {
    render(<MentionInput />);
    const el = editor();
    expect(el).toHaveAttribute('contenteditable', 'true');
    expect(el).toHaveAttribute('data-placeholder', '输入消息，Enter 发送。@ 引用 agent 或文件，# 引用任务');
  });

  it('挂载时拉取当前 workspace 的任务列表（# 菜单数据源）', () => {
    render(<MentionInput />);
    expect(taskState.load).toHaveBeenCalledWith('ws-1');
  });
});

describe('MentionInput 只读态（v25 spec §7「会话只读」）', () => {
  it('activeSessionReadOnly=true → 编辑面禁用 + 只读提示可见', () => {
    sessionState.activeSessionReadOnly = true;
    render(<MentionInput />);
    const el = editor();
    expect(el).toHaveAttribute('contenteditable', 'false');
    expect(el).toHaveAttribute('data-placeholder', '会话只读');
    expect(screen.getByText(/会话只读/)).toBeInTheDocument();
  });

  it('activeSessionReadOnly=false → 编辑面可用、无只读提示', () => {
    render(<MentionInput />);
    expect(editor()).toHaveAttribute('contenteditable', 'true');
    expect(screen.queryByText(/会话只读/)).not.toBeInTheDocument();
  });
});

describe('MentionInput 聚焦信号（新建会话后聚焦输入框，spec §6.2 ⚡ 免弹窗直达）', () => {
  it('inputFocusTick 递增 → 编辑面获得焦点', () => {
    const { rerender } = render(<MentionInput />);
    const el = editor();
    expect(document.activeElement).not.toBe(el);

    sessionState.inputFocusTick = 1;
    rerender(<MentionInput />);
    expect(document.activeElement).toBe(el);
  });

  it('tick 为 0（初始）不抢焦点', () => {
    render(<MentionInput />);
    expect(document.activeElement).not.toBe(editor());
  });
});

describe('MentionInput @ 菜单（在线成员）', () => {
  it('输入 @ 弹出在线成员菜单，离线成员不显示', () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-pm', agentName: 'PM-agent', lastRunning: true }),
      makeMember({ instanceId: 'inst-qa', agentName: 'QA-agent', lastRunning: false }),
    ];
    render(<MentionInput />);
    typeInEditor(editor(), '@');
    expect(screen.getByText('选择要 @ 的 agent')).toBeInTheDocument();
    expect(screen.getByText('PM-agent')).toBeInTheDocument();
    expect(screen.queryByText('QA-agent')).not.toBeInTheDocument();
  });

  it('输入 @qa 时离线成员被过滤，菜单不渲染', () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-qa', agentName: 'QA-agent', lastRunning: false }),
    ];
    render(<MentionInput />);
    typeInEditor(editor(), '@qa');
    expect(screen.queryByText('选择要 @ 的 agent')).not.toBeInTheDocument();
  });

  it('点击成员菜单项 → 编辑器内 agent pill（data-id=instanceId）；菜单关闭；chip 行退役', () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-pm', agentName: 'PM-agent', lastRunning: true }),
    ];
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '@');
    fireEvent.click(screen.getByText('PM-agent'));
    expect(hasPill(el, 'agent', 'inst-pm')).toBe(true);
    const pill = el.querySelector('span[data-kind="agent"]') as HTMLSpanElement;
    expect(pill.textContent).toBe('@PM-agent');
    // 菜单关闭
    expect(screen.queryByText('选择要 @ 的 agent')).not.toBeInTheDocument();
    // chip 行已退役——不再有「移除 @xxx」按钮（回归锁）
    expect(screen.queryByLabelText(/移除/)).toBeNull();
  });

  it('重复选择同一 agent → 两个 pill 并存（body 保留全部出现），mentions 序列化去重', async () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-pm', agentName: 'PM-agent', lastRunning: true }),
    ];
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '@');
    fireEvent.click(screen.getByText('PM-agent'));
    // pill 后继续敲 @ 再选同一成员（pill 折叠空格使 (?:^|\s)@ 局部仍可触发）
    typeAtEnd(el, ' @');
    fireEvent.click(screen.getByText('PM-agent'));
    expect(el.querySelectorAll('span[data-kind="agent"]')).toHaveLength(2);
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    expect(sessionState.sendMessage).toHaveBeenCalledWith('@PM-agent @PM-agent', ['inst-pm'], undefined);
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
    typeInEditor(editor(), '#T');
    expect(screen.getByText('选择要引用的任务')).toBeInTheDocument();
    expect(screen.getByText('#T-001 · 修复登录')).toBeInTheDocument();
    expect(screen.getByText('#T-005 · 草稿任务')).toBeInTheDocument();
    expect(screen.queryByText(/已完成任务/)).not.toBeInTheDocument();
    expect(screen.queryByText(/执行中任务/)).not.toBeInTheDocument();
    expect(screen.queryByText(/已暂停任务/)).not.toBeInTheDocument();
  });

  it('点击任务菜单项 → 编辑器内 task pill（data-id=任务 id）', () => {
    taskState.tasks = [makeTask({ id: 'T-001', title: '修复登录' })];
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '#T');
    fireEvent.click(screen.getByText('#T-001 · 修复登录'));
    expect(hasPill(el, 'task', 'T-001')).toBe(true);
  });
});

describe('MentionInput 发送（serializeSegments 三参契约）', () => {
  it('Enter 发送：agent pill + 任务 pill + 正文 → 载荷 = (body, mentions, undefined)，#T 标记只进正文', async () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-pm', agentName: 'PM-agent', lastRunning: true }),
    ];
    taskState.tasks = [makeTask({ id: 'T-001', title: '修复登录' })];
    render(<MentionInput />);
    const el = editor();
    // 选 agent + 选任务 + 补正文（pill 后继续输入——typeAtEnd 模拟光标处打字）
    typeInEditor(el, '@');
    fireEvent.click(screen.getByText('PM-agent'));
    typeAtEnd(el, ' #T');
    fireEvent.click(screen.getByText('#T-001 · 修复登录'));
    typeAtEnd(el, ' 请跟进');
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    expect(sessionState.sendMessage).toHaveBeenCalledWith('@PM-agent #T-001 请跟进', ['inst-pm'], undefined);
    // 发送后编辑器清空 + 刷新会话列表
    expect(visibleText(el)).toBe('');
    expect(sessionState.loadSessions).toHaveBeenCalled();
  });

  it('无 mention 时第二参为 undefined', async () => {
    render(<MentionInput />);
    typeInEditor(editor(), '普通消息');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    expect(sessionState.sendMessage).toHaveBeenCalledWith('普通消息', undefined, undefined);
  });

  it('空正文 Enter 不发送', () => {
    render(<MentionInput />);
    typeInEditor(editor(), '   ');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(sessionState.sendMessage).not.toHaveBeenCalled();
  });

  it('菜单激活时 Enter 不发送，Escape 关菜单后可发送', () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-pm', agentName: 'PM-agent', lastRunning: true }),
    ];
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '@');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(sessionState.sendMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(el, { key: 'Escape' });
    expect(screen.queryByText('选择要 @ 的 agent')).not.toBeInTheDocument();
    typeInEditor(el, '你好');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(sessionState.sendMessage).toHaveBeenCalledWith('你好', undefined, undefined);
  });

  it('发送失败恢复：pill 原位 + 正文保留（setSegments 快照恢复）', async () => {
    sessionState.sendMessage = vi.fn().mockRejectedValue(new Error('send failed'));
    sessionState.members = [
      makeMember({ instanceId: 'inst-pm', agentName: 'PM-agent', lastRunning: true }),
    ];
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '@');
    fireEvent.click(screen.getByText('PM-agent'));
    typeAtEnd(el, ' 请处理');
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    expect(hasPill(el, 'agent', 'inst-pm')).toBe(true);
    expect(visibleText(el)).toContain('请处理');
  });

  it('命令 pill 单独存在 → sendMessage body 恰为 /compact（整串拦截语义形态保持）', async () => {
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '/');
    fireEvent.click(await screen.findByText('/compact'));
    expect(hasPill(el, 'command', 'compact')).toBe(true);
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    expect(sessionState.sendMessage).toHaveBeenCalledWith('/compact', undefined, undefined);
  });

  it('命令 pill 领头混排（命令+agent+任务+文件+正文）→ 序列化对齐 spec §3：命令按普通消息发送', async () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-pm', agentName: 'PM-agent', lastRunning: true }),
    ];
    taskState.tasks = [makeTask({ id: 'T-001', title: '修复登录' })];
    mockApi.file.searchNames.mockResolvedValue([{ path: 'package.json', isDirectory: false }]);
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '/com');
    fireEvent.click(await screen.findByText('/compact'));
    typeAtEnd(el, ' @');
    fireEvent.click(screen.getByText('PM-agent'));
    typeAtEnd(el, ' #');
    fireEvent.click(screen.getByText('#T-001 · 修复登录'));
    typeAtEnd(el, ' @pack');
    fireEvent.click(await screen.findByText('package.json'));
    typeAtEnd(el, ' 请跟进');
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    // body 非整串命令（不匹配 /^\/[A-Za-z0-9-]+$/）→ session.store 不拦截，
    // 按普通消息发送（spec §3 命令行「混排则当普通消息发送」）
    expect(sessionState.sendMessage).toHaveBeenCalledWith(
      '/compact @PM-agent #T-001 @package.json 请跟进',
      ['inst-pm'],
      { skills: [], files: [{ path: 'package.json' }] },
    );
  });

  it('技能 pill 领头混排（技能+agent+任务+文件+正文）→ 技能不进正文，context 三参对齐 spec §3 表', async () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-pm', agentName: 'PM-agent', lastRunning: true }),
    ];
    taskState.tasks = [makeTask({ id: 'T-001', title: '修复登录' })];
    mockApi.file.searchNames.mockResolvedValue([{ path: 'package.json', isDirectory: false }]);
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '/code');
    fireEvent.click(await screen.findByText('代码审查工作流'));
    typeAtEnd(el, ' @');
    fireEvent.click(screen.getByText('PM-agent'));
    typeAtEnd(el, ' #');
    fireEvent.click(screen.getByText('#T-001 · 修复登录'));
    typeAtEnd(el, ' @pack');
    fireEvent.click(await screen.findByText('package.json'));
    typeAtEnd(el, ' 请跟进');
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    // 技能 pill 不进正文（展开块由主进程 <user-context> 注入）；trimmed 去掉
    // 技能 pill 后残留的引导空格
    expect(sessionState.sendMessage).toHaveBeenCalledWith(
      '@PM-agent #T-001 @package.json 请跟进',
      ['inst-pm'],
      {
        skills: [{ slug: 'code-review-workflow', name: '代码审查工作流' }],
        files: [{ path: 'package.json' }],
      },
    );
  });
});

describe('MentionInput 输入法组合期 Enter（中文拼音选字不误发——守卫在 RichComposer）', () => {
  it('isComposing=true 的 Enter 不发送（拼音选字确认）', () => {
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '你好');
    fireEvent.keyDown(el, { key: 'Enter', shiftKey: false, isComposing: true } as unknown as Parameters<typeof fireEvent.keyDown>[1]);
    expect(sessionState.sendMessage).not.toHaveBeenCalled();
    expect(visibleText(el)).toBe('你好');
  });

  it('keyCode 229（IME 事件）的 Enter 不发送', () => {
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, 'nihao');
    fireEvent.keyDown(el, { key: 'Enter', keyCode: 229 } as unknown as Parameters<typeof fireEvent.keyDown>[1]);
    expect(sessionState.sendMessage).not.toHaveBeenCalled();
  });

  it('非组合期 Enter 正常发送（回归保护）', () => {
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, 'hello');
    fireEvent.keyDown(el, { key: 'Enter', shiftKey: false, isComposing: false } as unknown as Parameters<typeof fireEvent.keyDown>[1]);
    expect(sessionState.sendMessage).toHaveBeenCalledWith('hello', undefined, undefined);
  });
});

describe('MentionInput 会话草稿（segments JSON 往返，pill 不丢）', () => {
  it('纯文本草稿：切走清空、切回恢复', () => {
    const { rerender } = render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '会话A的草稿');

    sessionState.activeSessionId = 'sess-2';
    rerender(<MentionInput />);
    expect(visibleText(editor())).toBe('');

    sessionState.activeSessionId = 'sess-1';
    rerender(<MentionInput />);
    expect(visibleText(editor())).toBe('会话A的草稿');
  });

  it('pill 草稿：切走清空、切回 pill 与正文原样恢复', () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-pm', agentName: 'PM-agent', lastRunning: true }),
    ];
    const { rerender } = render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '@');
    fireEvent.click(screen.getByText('PM-agent'));
    typeAtEnd(el, ' 请跟进');

    sessionState.activeSessionId = 'sess-2';
    rerender(<MentionInput />);
    expect(visibleText(editor())).toBe('');
    expect(editor().querySelector('span[data-kind="agent"]')).toBeNull();

    sessionState.activeSessionId = 'sess-1';
    rerender(<MentionInput />);
    expect(hasPill(editor(), 'agent', 'inst-pm')).toBe(true);
    expect(visibleText(editor())).toContain('请跟进');
  });
});

// === @ 统一菜单（v2.11.1 F2，opencode 式）——契约不变，输入方式改 typeInEditor ===
// 契约：@ 触发同一浮层 agent 组 + 文件组，同 query 双源；选文件插 file pill（与
// agent 同形）；空 query 文件组显示根目录默认列表（file.list，不发 searchNames）；
// 📎 直开菜单。
describe('MentionInput @ 统一菜单（v2.11.1 F2）', () => {
  it('输入 @ → agent 组与文件组同浮层渲染（双源同 query）', async () => {
    sessionState.members = [makeMember({ instanceId: 'i-1', agentName: 'coder' })];
    mockApi.file.searchNames.mockResolvedValue([
      { path: 'coder-notes.md', isDirectory: false },
      { path: 'src/', isDirectory: true },
    ]);
    render(<MentionInput />);
    typeInEditor(editor(), '@coder');
    await waitFor(() => expect(screen.getByText('选择要 @ 的 agent')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('coder-notes.md')).toBeTruthy());
    expect(screen.queryByText('src/')).toBeNull(); // 目录命中被过滤
  });

  it('选择文件 → 编辑器内 file pill（data-id=路径）；不再有「移除文件」chip', async () => {
    mockApi.file.searchNames.mockResolvedValue([{ path: 'package.json', isDirectory: false }]);
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '@pack');
    fireEvent.click(await screen.findByText('package.json'));
    expect(el.querySelector('[data-kind="file"][data-id="package.json"]')).not.toBeNull();
    expect(screen.queryByLabelText('移除文件 package.json')).toBeNull();
  });

  it('空 query → 根目录默认列表（file.list，不发 searchNames；仅文件截 8 条）', async () => {
    mockApi.file.list.mockResolvedValue([
      ...Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.ts`, isDirectory: false, size: 1 })),
      { name: 'src', isDirectory: true, size: 0 },
    ]);
    render(<MentionInput />);
    typeInEditor(editor(), '@');
    await waitFor(() => expect(screen.getByText('f7.ts')).toBeTruthy());
    expect(screen.queryByText('f8.ts')).toBeNull(); // 截 8（FILE_MENU_LIMIT）
    expect(screen.queryByText('src')).toBeNull();
    expect(mockApi.file.searchNames).not.toHaveBeenCalled();
  });

  it('📎 点击直开菜单：insertTextAtEnd 追加 @ + 默认列表可见', async () => {
    sessionState.fileTriggerTick = 1;
    mockApi.file.list.mockResolvedValue([{ name: 'README.md', isDirectory: false, size: 1 }]);
    render(<MentionInput />);
    await waitFor(() => expect(visibleText(editor())).toBe('@'));
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy());
  });

  it('searchNames 失败 → 文件组静默不渲染且不崩（错误路径）', async () => {
    mockApi.file.searchNames.mockRejectedValue(new Error('boom'));
    render(<MentionInput />);
    typeInEditor(editor(), '@zzz');
    await waitFor(() => expect(mockApi.file.searchNames).toHaveBeenCalled());
    // 无菜单渲染（agent 组也空）、编辑面仍在
    expect(screen.queryByText('引用文件')).toBeNull();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  // 终审 M1：会话切换清空陈旧 fileHits——跨 workspace 切会话后再敲 @ 不闪现
  // 旧文件命中。会话切换 effect 显式 setFileHits([])；新 ws 的 file.list 挂起
  // （pending Promise）期间断言同步完成。
  it('会话切换清空陈旧 fileHits——跨 workspace 切会话后再敲 @ 不闪现旧文件', async () => {
    mockApi.file.list.mockResolvedValueOnce([{ name: 'old-ws.md', isDirectory: false, size: 1 }]);
    const { rerender } = render(<MentionInput />);
    // 敲 @ 触发 ws-1 默认列表：fileHits 填入 old-ws.md，文件组渲染
    typeInEditor(editor(), '@');
    await waitFor(() => expect(screen.getByText('old-ws.md')).toBeTruthy());

    // 切到 ws-2 + sess-2：会话切换 effect 应清空 fileHits（终审 M1 行为补丁）
    sessionState.activeSessionId = 'sess-2';
    workspaceState.getActive = () => ({ id: 'ws-2', name: 'ws-2' });
    // 新 workspace file.list 永不 resolve——模拟 IPC 未返回期间
    mockApi.file.list.mockReturnValueOnce(new Promise(() => {}));
    rerender(<MentionInput />);

    // 再敲 @：触发 ws-2 默认列表请求（menuType='agent' + workspaceId='ws-2'），
    // 但 mock 挂起——若无会话切换清理，fileHits 残留 old-ws.md 导致菜单闪现
    typeInEditor(editor(), '@');

    // 断言：陈旧 fileHits 已清，菜单文件组不渲染（agent 组也空），旧文件不在
    expect(screen.queryByText('old-ws.md')).toBeNull();
    expect(screen.queryByText('引用文件')).toBeNull();
    // 新 ws 的 file.list 必须已被发起——证明 effect 链路正确，只是 await 未返回
    expect(mockApi.file.list).toHaveBeenCalledWith('ws-2', '.');
  });

  it('发送失败恢复文件 pill 原位（@路径 pill 形态）', async () => {
    sessionState.sendMessage.mockRejectedValue(new Error('net'));
    mockApi.file.searchNames.mockResolvedValue([{ path: 'a.ts', isDirectory: false }]);
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '@a');
    fireEvent.click(await screen.findByText('a.ts'));
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    expect(hasPill(el, 'file', 'a.ts')).toBe(true);
  });
});

describe('MentionInput / 菜单（命令 + 技能两组）', () => {
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
    typeInEditor(editor(), '/');
    expect(await screen.findByText('命令')).toBeInTheDocument();
    expect(screen.getByText('技能')).toBeInTheDocument();
    expect(screen.getByText('/compact')).toBeInTheDocument();
    expect(screen.getByText(/压缩会话历史/)).toBeInTheDocument();
    expect(screen.getByText('代码审查工作流')).toBeInTheDocument();
    expect(screen.queryByText('未安装技能')).not.toBeInTheDocument();
  });

  it('选择命令 → 编辑器内 command pill（data-id=命令名）；菜单关闭', async () => {
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '/com');
    fireEvent.click(await screen.findByText('/compact'));
    expect(hasPill(el, 'command', 'compact')).toBe(true);
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
  });

  it('选择技能 → 编辑器内 skill pill（data-id=slug），触发局部被替换清除', async () => {
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '/code');
    fireEvent.click(await screen.findByText('代码审查工作流'));
    expect(hasPill(el, 'skill', 'code-review-workflow')).toBe(true);
    // 编辑器可见文本恰为 pill 显示文本——'/code' 触发局部已被 insertPill 替换
    expect(visibleText(el)).toBe('代码审查工作流');
    expect(screen.queryByText('技能')).not.toBeInTheDocument();
  });

  it('query 过滤：/comp 仅命中命令组，/zzz 无匹配整菜单收起', async () => {
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '/');
    await screen.findByText('命令');
    typeInEditor(el, '/comp');
    expect(screen.getByText('命令')).toBeInTheDocument();
    expect(screen.queryByText('技能')).not.toBeInTheDocument();
    typeInEditor(el, '/zzz');
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
    expect(screen.queryByText('技能')).not.toBeInTheDocument();
  });

  it('菜单激活时 Enter 不发送（命令菜单）', async () => {
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '/');
    await screen.findByText('命令');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(sessionState.sendMessage).not.toHaveBeenCalled();
  });

  it('Escape 关命令菜单', async () => {
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '/');
    await screen.findByText('命令');
    fireEvent.keyDown(el, { key: 'Escape' });
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
  });

  it('空 body + 仅技能 pill 可发送（v2.11 §7.1——context 透传，技能正文即 prompt）', async () => {
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '/code');
    fireEvent.click(await screen.findByText('代码审查工作流'));
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    expect(sessionState.sendMessage).toHaveBeenCalledWith(
      '',
      undefined,
      { skills: [{ slug: 'code-review-workflow', name: '代码审查工作流' }], files: [] },
    );
    // 发送后编辑器清空（pill 随 clear 整体移除）
    expect(visibleText(el)).toBe('');
    expect(sessionState.loadSessions).toHaveBeenCalled();
  });

  it('技能 pill + 文件 pill 组装完整 context 发送', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockResolvedValue([
      { path: 'src/a.ts', isDirectory: false },
    ]);
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '/code');
    await advanceDebounce();
    fireEvent.click(screen.getByText('代码审查工作流'));
    typeAtEnd(el, '@/a');
    await advanceDebounce();
    fireEvent.click(screen.getByText('src/a.ts'));
    typeAtEnd(el, ' 帮我看看');
    fireEvent.keyDown(el, { key: 'Enter' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // 文件 pill 序列化 = '@' + path（searchNames 的 path 无前导 /——与 v2.11
    // 菜单选择的 insertMention(`@${f.path}`) 同形；旧用例的 '@/src/a.ts'
    // 是 textarea 手敲整串的产物，菜单选择路径从不产生）
    expect(sessionState.sendMessage).toHaveBeenCalledWith(
      '@src/a.ts 帮我看看',
      undefined,
      {
        skills: [{ slug: 'code-review-workflow', name: '代码审查工作流' }],
        files: [{ path: 'src/a.ts' }],
      },
    );
  });

  it('body 非空时不触发 / 菜单（回归锁——句中 / 不属于命令命名空间）', async () => {
    render(<MentionInput />);
    const el = editor();
    // 等挂载数据就绪并确认菜单可开，排除「数据未到」假阴性
    typeInEditor(el, '/');
    await screen.findByText('命令');
    typeInEditor(el, '看下');
    typeInEditor(el, '看下/');
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
    expect(screen.queryByText('技能')).not.toBeInTheDocument();
  });

  it('// 转义路径：第二个 / 即关菜单，Enter 原样发送 //（strip 在 session.store）', async () => {
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '/');
    await screen.findByText('命令');
    // 第二个 / 不在命令字符集 [^\s/] 内：命令正则不命中，菜单关闭
    typeInEditor(el, '//');
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
    typeInEditor(el, '//not-a-command');
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    expect(sessionState.sendMessage).toHaveBeenCalledWith('//not-a-command', undefined, undefined);
  });

  it('发送失败恢复技能 pill 原位与正文', async () => {
    sessionState.sendMessage = vi.fn().mockRejectedValue(new Error('boom'));
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '/code');
    fireEvent.click(await screen.findByText('代码审查工作流'));
    typeAtEnd(el, '帮我审查这段逻辑');
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    expect(hasPill(el, 'skill', 'code-review-workflow')).toBe(true);
    expect(visibleText(el)).toContain('帮我审查这段逻辑');
  });

  it('会话切换：技能 pill 随草稿保留，切回原样恢复（「切走清空 chips」语义随三数组退役）', async () => {
    const { rerender } = render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '/code');
    fireEvent.click(await screen.findByText('代码审查工作流'));
    sessionState.activeSessionId = 'sess-2';
    rerender(<MentionInput />);
    expect(visibleText(el)).toBe('');
    sessionState.activeSessionId = 'sess-1';
    rerender(<MentionInput />);
    expect(hasPill(el, 'skill', 'code-review-workflow')).toBe(true);
  });

  it('listCommands 失败 → 菜单不渲染且不崩（错误路径静默）', async () => {
    mockApi.session.listCommands.mockRejectedValue(new Error('boom'));
    render(<MentionInput />);
    typeInEditor(editor(), '/');
    await act(async () => {});
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
    expect(editor()).toHaveAttribute('contenteditable', 'true');
  });

  it('resource.list 失败 → 技能组缺席，命令组不受影响（错误路径静默）', async () => {
    mockApi.resource.list.mockRejectedValue(new Error('boom'));
    render(<MentionInput />);
    typeInEditor(editor(), '/');
    expect(await screen.findByText('命令')).toBeInTheDocument();
    expect(screen.queryByText('代码审查工作流')).not.toBeInTheDocument();
  });
});

describe('MentionInput 📎 文件触发（fileTriggerTick）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const advanceDebounce = async (): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
  };

  it('fileTriggerTick 递增 → 聚焦 + 空编辑器插入 @；继续输入即出文件菜单', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockResolvedValue([{ path: 'src/a.ts', isDirectory: false }]);
    const { rerender } = render(<MentionInput />);
    const el = editor();
    expect(document.activeElement).not.toBe(el);

    sessionState.fileTriggerTick = 1;
    rerender(<MentionInput />);
    expect(document.activeElement).toBe(el);
    expect(visibleText(el)).toBe('@');
    // @ 就位后用户继续输入查询词 → @ 统一菜单文件组接管（atMatch 包含 /）
    typeInEditor(el, '@/a');
    await advanceDebounce();
    expect(screen.getByText('引用文件')).toBeInTheDocument();
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
  });

  it('已有正文以非空白收尾 → 追加空格防粘连（hello → hello @）', () => {
    const { rerender } = render(<MentionInput />);
    const el = editor();
    typeInEditor(el, 'hello');
    sessionState.fileTriggerTick = 1;
    rerender(<MentionInput />);
    expect(visibleText(el)).toBe('hello @');
  });

  it('已有正文以空白收尾 → 直接追加不产生双空格（"hello " → "hello @"）', () => {
    const { rerender } = render(<MentionInput />);
    const el = editor();
    typeInEditor(el, 'hello ');
    sessionState.fileTriggerTick = 1;
    rerender(<MentionInput />);
    expect(visibleText(el)).toBe('hello @');
  });

  it('insertTextAtEnd 内部触发 detectTrigger：命令菜单打开时点 📎 → 旧菜单立即关闭（@ 菜单接管）', async () => {
    const { rerender } = render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '/');
    expect(await screen.findByText('命令')).toBeInTheDocument();

    sessionState.fileTriggerTick = 1;
    rerender(<MentionInput />);
    // '/' 以非空白收尾 → '/ @'；detectTrigger 同步刷新菜单态：命令菜单让位
    expect(visibleText(el)).toBe('/ @');
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
  });

  it('tick=0（初始）不插入 @ 也不抢焦点', () => {
    render(<MentionInput />);
    expect(visibleText(editor())).toBe('');
    expect(document.activeElement).not.toBe(editor());
  });
});

// === 触发正则放宽（v2.11.1 F1：中文过滤）——旧字符集 [A-Za-z0-9-] 不含中文，
// 敲中文名菜单即关（预置技能名恰是中文）===
describe('MentionInput 触发正则放宽（中文过滤）', () => {
  it('/代码 → 命令菜单技能组按中文名过滤（含中文名技能命中、其它排除）', async () => {
    mockApi.resource.list.mockResolvedValue([
      makeSkillResource({ slug: 'code-review', name: '代码审查' }),
      makeSkillResource({ slug: 'write-tests', name: '写测试' }),
    ]);
    render(<MentionInput />);
    typeInEditor(editor(), '/代码');
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
    typeInEditor(editor(), '@代码');
    await waitFor(() => expect(screen.getByText('代码助手')).toBeTruthy());
    expect(screen.queryByText('writer')).toBeNull();
  });

  it('#中文 → 任务菜单按中文标题过滤', async () => {
    taskState.tasks = [
      makeTask({ id: 'T-1', title: '修复登录' }),
      makeTask({ id: 'T-2', title: '写文档' }),
    ];
    render(<MentionInput />);
    typeInEditor(editor(), '#登录');
    await waitFor(() => expect(screen.getByText(/修复登录/)).toBeTruthy());
    expect(screen.queryByText(/写文档/)).toBeNull();
  });

  it('语义保持：句中 / 不触发命令菜单、// 转义不触发、正文后 @ 不弹成员菜单', () => {
    render(<MentionInput />);
    typeInEditor(editor(), '看下 src/文件');
    expect(screen.queryByText('命令')).toBeNull();
    typeInEditor(editor(), '//');
    expect(screen.queryByText('命令')).toBeNull();
    typeInEditor(editor(), '邮箱a@b.com不发菜单');
    expect(screen.queryByText('选择要 @ 的 agent')).toBeNull();
  });
});

// === Kimi 式单一容器（v2.11.1 F3→v3 pill 形态）：pills-in-editor + 📎 框内 ===
describe('MentionInput Kimi 式容器（pill 时代形态）', () => {
  it('选文件后 pill 渲染在编辑器内（pills-in-editor）；📎 仍在 .rounded-lg 容器框内', async () => {
    mockApi.file.searchNames.mockResolvedValue([{ path: 'a.ts', isDirectory: false }]);
    render(<MentionInput />);
    typeInEditor(editor(), '@a');
    fireEvent.click(await screen.findByText('a.ts'));
    expect(editor().querySelector('[data-kind="file"]')).not.toBeNull();
    expect(screen.getByLabelText('引用文件').closest('.rounded-lg')).toBeTruthy();
  });

  it('📎 在输入框容器内左下角且触发 bumpFileTrigger', () => {
    render(<MentionInput />);
    const btn = screen.getByLabelText('引用文件');
    expect(btn.closest('.rounded-lg')).toBeTruthy();
    fireEvent.click(btn);
    // bumpFileTrigger 经真实 store mock 生效（getState + tick 递增语义）
    expect(sessionState.fileTriggerTick).toBe(1);
  });

  it('readOnly → 📎 禁用；chip 行退役后底行仅 📎', () => {
    sessionState.activeSessionReadOnly = true;
    render(<MentionInput />);
    expect((screen.getByLabelText('引用文件') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText(/移除/)).toBeNull();
  });
});
