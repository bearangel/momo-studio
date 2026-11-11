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
//   9. 工具条触发（2026-11-05 mentionTrigger；当日实测修订为零文本侵入）：
//      聚焦 + 直开限定菜单，输入框不插入任何触发符（放弃零残留 / 不跳行）；
//      mentionScope 锁单组 / 空态行 / scope 生命周期；📎 直接导入按钮 + importFile
//  10. F3 容器：pill 在编辑器内（pills-in-editor）、📎 仍在 .rounded-lg 容器框内
//  11. 菜单键盘导航（2026-09-26 可用性 P0）：↑↓ 循环高亮 / Enter·Tab 选中 /
//      Esc 关闭 / 零命中 Enter 照发 / IME compositionend 提交补偿（过滤立即生效）
//  12. 图片输入（2026-09-26 多模态 spec §5/§10）：粘贴/拖入 → downscale →
//      asset:saveImage → image pill → context.images 序列化；@ 菜单图片扩展名
//      分流（lucide-image 图标 + 选中进 images 通道，2048 哨兵尺寸）；
//      上限 6 拦截 + 失败不插 pill；全员 vision=false 时能力提示行
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ResourceItem, SessionMemberInfo, SessionSummary, TaskRow } from '../../ipc/types';

// 图片管线 canvas 边界 mock（jsdom 无 createImageBitmap/canvas.toBlob）：
// 仅替换 downscaleImage——纯函数与常量经 importOriginal 保真（momo-test-rules：mock 收窄到边界）
const { downscaleMock } = vi.hoisted(() => ({ downscaleMock: vi.fn() }));
vi.mock('../../lib/image-downscale', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/image-downscale')>();
  return { ...actual, downscaleImage: downscaleMock };
});

// vi.hoisted：mock store 状态在 vi.mock 工厂注册前完成初始化
const { sessionState, taskState, workspaceState } = vi.hoisted(() => ({
  sessionState: {
    activeSessionId: 'sess-1' as string | null,
    members: [] as SessionMemberInfo[],
    // 跨会话引用（spec 2026-09-30 §5）：@ 菜单会话组数据源——已加载会话列表
    // （含当前会话），MentionInput 侧过滤排除 activeSessionId。组件消费
    // s.sessions 字段，注入同 store 既有 setter 形态（直接赋值）。
    sessions: [] as SessionSummary[],
    sendMessage: vi.fn(),
    loadSessions: vi.fn(),
    activeSessionReadOnly: false,
    inputFocusTick: 0,
    // 工具条选择按钮触发信号 + 限定组（2026-11-05；仿真真实 store 语义：
    // bump 同步置位 scope，close 置 null）
    mentionTrigger: null as { kind: 'agent' | 'skill' | 'file' | 'session' | 'task'; tick: number } | null,
    mentionScope: null as string | null,
    // 斜杠命令提示 + 命令执行中键控 Map（仿真真实 store 字段形状）
    commandHint: null as string | null,
    commandPendingBySession: new Map<string, string>(),
    // 箭头体在调用时才执行，sessionState 届时已初始化
    bumpMentionTrigger: vi.fn((kind: 'agent' | 'skill' | 'file' | 'session' | 'task') => {
      sessionState.mentionTrigger = {
        kind,
        tick: (sessionState.mentionTrigger?.tick ?? 0) + 1,
      };
      sessionState.mentionScope = kind;
    }),
    closeMentionScope: vi.fn(() => {
      sessionState.mentionScope = null;
    }),
    consumeMentionTrigger: vi.fn(() => {
      sessionState.mentionTrigger = null;
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
  asset: {
    // Task 4 契约：saveImage(workspaceId, data, ext) → { path }
    saveImage: vi.fn(),
    // 2026-11-05 导入管线契约：importFile(workspaceId, data, name) → { path }
    importFile: vi.fn(),
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
    groupId: null,
    pinnedAt: null,
    archivedAt: null,
    routing: { mode: 'local' }, delegationId: null, origin: 'user', parentTaskId: null,
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
  mockApi.file.searchNames.mockResolvedValue({ hits: [], truncated: false });
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
  mockApi.asset.saveImage.mockReset();
  mockApi.asset.saveImage.mockResolvedValue({ path: '.momo/assets/abc123def456.png' });
  mockApi.asset.importFile.mockReset();
  mockApi.asset.importFile.mockImplementation(
    async (_ws: string, _data: Uint8Array, name: string) => ({ path: `imports/${name}` }),
  );
  // downscale 真实产物形状：降采样后字节 + 目标尺寸 + 扩展名
  downscaleMock.mockReset();
  downscaleMock.mockResolvedValue({ data: new Uint8Array([1, 2, 3]), w: 800, h: 600, ext: 'png' as const });
  // 跨用例残留归位：终审 M1 用例会把 getActive 改成 ws-2、Once 队列若不
  // mockReset 会压过后续 mockRejectedValue——两处不还原会让后置用例拿到
  // 错误 workspace / 假 resolve（mockClear 保留 Once 实现，这里必须 Reset）
  workspaceState.getActive = () => ({ id: 'ws-1', name: 'ws' });
  sessionState.activeSessionId = 'sess-1';
  sessionState.members = [];
  sessionState.sessions = [];
  sessionState.sendMessage = vi.fn().mockResolvedValue(undefined);
  sessionState.loadSessions = vi.fn().mockResolvedValue(undefined);
  sessionState.activeSessionReadOnly = false;
  sessionState.inputFocusTick = 0;
  sessionState.mentionTrigger = null;
  sessionState.mentionScope = null;
  sessionState.commandHint = null;
  sessionState.commandPendingBySession = new Map();
  // 每用例还原 bump/close 实现——防上个用例替换实现或跨用例残留影响递增语义
  sessionState.bumpMentionTrigger = vi.fn((kind: 'agent' | 'skill' | 'file' | 'session' | 'task') => {
    sessionState.mentionTrigger = {
      kind,
      tick: (sessionState.mentionTrigger?.tick ?? 0) + 1,
    };
    sessionState.mentionScope = kind;
  });
  sessionState.closeMentionScope = vi.fn(() => {
    sessionState.mentionScope = null;
  });
  sessionState.consumeMentionTrigger = vi.fn(() => {
    sessionState.mentionTrigger = null;
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
    expect(el).toHaveAttribute('data-placeholder', '输入消息，Enter 发送。也可以点上方按钮选择引用');
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
    mockApi.file.searchNames.mockResolvedValue({
      hits: [{ path: 'package.json', isDirectory: false }],
      truncated: false,
    });
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
    // store 侧语义：纯命令形态 /^\/([A-Za-z0-9-]+)\s*$/ 才拦截，混排体按普通
    // 消息发送（spec §3 命令行「混排则当普通消息发送」）。本测试 mock 了
    // store.sendMessage，此处只断言三参调用形状
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
    mockApi.file.searchNames.mockResolvedValue({
      hits: [{ path: 'package.json', isDirectory: false }],
      truncated: false,
    });
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
    mockApi.file.searchNames.mockResolvedValue({
      hits: [
        { path: 'coder-notes.md', isDirectory: false },
        { path: 'src/', isDirectory: true },
      ],
      truncated: false,
    });
    render(<MentionInput />);
    typeInEditor(editor(), '@coder');
    await waitFor(() => expect(screen.getByText('选择要 @ 的 agent')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('coder-notes.md')).toBeTruthy());
    // 目录命中保留（2026-11-11 B 方案：可钻入；旧实现整类过滤导致输入目录名空列表）
    expect(screen.getByText('src/')).toBeInTheDocument();
  });

  it('选择文件 → 编辑器内 file pill（data-id=路径）；不再有「移除文件」chip', async () => {
    mockApi.file.searchNames.mockResolvedValue({
      hits: [{ path: 'package.json', isDirectory: false }],
      truncated: false,
    });
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

  it('工具条 file 触发 → 直开文件限定菜单：全量递归列表 + 固定导入条目，编辑器零侵入', async () => {
    sessionState.mentionTrigger = { kind: 'file', tick: 1 };
    sessionState.mentionScope = 'file';
    mockApi.file.searchNames.mockResolvedValue({
      hits: [{ path: 'README.md', isDirectory: false }],
      truncated: false,
    });
    render(<MentionInput />);
    await waitFor(() => expect(mockApi.file.searchNames).toHaveBeenCalledWith('ws-1', ''));
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy());
    expect(screen.getByText('从电脑导入…')).toBeTruthy();
    // 零文本侵入（2026-11-05 实测 bug 1/2 回归锁）：不插 @、不产生换行
    expect(visibleText(editor())).toBe('');
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
    mockApi.file.searchNames.mockResolvedValue({
      hits: [{ path: 'a.ts', isDirectory: false }],
      truncated: false,
    });
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '@a');
    fireEvent.click(await screen.findByText('a.ts'));
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    expect(hasPill(el, 'file', 'a.ts')).toBe(true);
  });
});

// === @ 菜单会话组（跨会话引用 spec 2026-09-30 §5）：
//   第三组「引用会话」——已加载会话列表排除当前会话，标题子串过滤，
//   选中走 selectWithPill({ kind:'session', id, label })，context.sessions 透传。
//   数据源 store.sessions（与 IPC 解耦——切会话已 loadSessions 拉过即可）。
//   GROUP_LABEL '引用会话'，菜单图标 lucide-messages-square 12px / stroke 1.75。
//   键盘导航跨组扁平序列：会话条目追加在 file 组之后（spec agent → file → session 顺序）。
describe('MentionInput @ 菜单会话组（跨会话引用）', () => {
  beforeEach(() => {
    // 当前激活会话 sess-2 必须出现在 sessions 中（真实 store 行为）但渲染侧
    // 排除——选择自身无意义（spec §5）；会话标题含「设计讨论」/「当前会话标题」
    sessionState.sessions = [
      { id: 'sess-1', title: '设计讨论' } as unknown as SessionSummary,
      { id: 'sess-2', title: '当前会话标题' } as unknown as SessionSummary,
      { id: 'sess-3', title: '实现笔记' } as unknown as SessionSummary,
    ];
    sessionState.activeSessionId = 'sess-2';
  });

  it('打 @ 出现「引用会话」组；当前会话不在列表；标题子串过滤', () => {
    render(<MentionInput />);
    typeInEditor(editor(), '@');
    // 组标签（className 含 .text-tertiary 是渲染契约：<div className="px-3 py-1 text-xs text-tertiary">）
    expect(screen.getByText('引用会话', { selector: '.text-tertiary' })).toBeInTheDocument();
    // 会话条目（排除 sess-2 当前会话）
    expect(screen.getByText('设计讨论')).toBeInTheDocument();
    expect(screen.getByText('实现笔记')).toBeInTheDocument();
    expect(screen.queryByText('当前会话标题')).not.toBeInTheDocument();

    // 标题子串过滤：@设计 → 仅「设计讨论」命中
    typeInEditor(editor(), '@设计');
    expect(screen.getByText('设计讨论')).toBeInTheDocument();
    expect(screen.queryByText('实现笔记')).not.toBeInTheDocument();
  });

  it('会话组在 agent + file 组之后渲染（spec agent → file → session 顺序）', async () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-1', agentName: 'PM-agent', lastRunning: true }),
    ];
    mockApi.file.list.mockResolvedValue([{ name: 'a.ts', isDirectory: false, size: 1 }]);
    render(<MentionInput />);
    typeInEditor(editor(), '@');
    // 文件组需 file.list 异步返回——waitFor 等渲染
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());
    // 三组标签按出现顺序断言：group label 在渲染序列的相对位置即文档顺序
    const labels = Array.from(document.querySelectorAll('.text-tertiary'))
      .map((n) => n.textContent)
      .filter((t): t is string => t !== null);
    const agentIdx = labels.indexOf('选择要 @ 的 agent');
    const fileIdx = labels.indexOf('引用文件');
    const sessionIdx = labels.indexOf('引用会话');
    expect(agentIdx).toBeGreaterThanOrEqual(0);
    expect(fileIdx).toBeGreaterThan(agentIdx);
    expect(sessionIdx).toBeGreaterThan(fileIdx);
  });

  it('选中会话 → session pill（data-id=会话 id）+ 发送载荷 context.sessions', async () => {
    render(<MentionInput />);
    const el = editor();
    // 跨会话引用常见形态：先有正文，再 @ 引用会话（spec §6 真实使用）。
    // @ 触发需空白前缀锚定（spec `(?:^|\s)@`）——先整段建「参考」，再 append「 @设计」
    typeInEditor(el, '参考');
    typeAtEnd(el, ' @设计');
    fireEvent.click(screen.getByText('设计讨论'));
    expect(hasPill(el, 'session', 'sess-1')).toBe(true);
    // 菜单关闭 + 显示文本含会话标题（pill 显示语义对齐其他五类）
    expect(screen.queryByText('引用会话')).not.toBeInTheDocument();
    expect(visibleText(el)).toContain('参考');
    expect(visibleText(el)).toContain('设计讨论');

    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    // composer-segments serializeSessions 收口：body 内 @label，context.sessions 含去重 sessionId + title
    expect(sessionState.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('参考'),
      undefined,
      expect.objectContaining({
        sessions: [{ sessionId: 'sess-1', title: '设计讨论' }],
      }),
    );
  });

  it('无其他会话时（仅当前会话）→ 会话组不渲染、不报错', () => {
    sessionState.sessions = [
      { id: 'sess-2', title: '当前会话标题' } as unknown as SessionSummary,
    ];
    sessionState.activeSessionId = 'sess-2';
    // 菜单开需要至少一个非空组——seed 一名在线成员让 @ 菜单可渲染
    sessionState.members = [
      makeMember({ instanceId: 'inst-1', agentName: 'PM-agent', lastRunning: true }),
    ];
    render(<MentionInput />);
    typeInEditor(editor(), '@');
    // agent 组仍渲染（双源契约不变），会话组因排除后为空不出现
    expect(screen.getByText('选择要 @ 的 agent')).toBeInTheDocument();
    expect(screen.queryByText('引用会话')).not.toBeInTheDocument();
  });

  it('sessions 列表为空 → 会话组不渲染；其它组不受影响', async () => {
    sessionState.sessions = [];
    // seed 文件列表让文件组可渲染——验证会话组缺席不污染其它组
    mockApi.file.list.mockResolvedValue([{ name: 'a.ts', isDirectory: false, size: 1 }]);
    render(<MentionInput />);
    typeInEditor(editor(), '@');
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());
    // 等待文件组实际渲染后再断言——避免 file.list 异步未到前假阴性
    expect(screen.queryByText('引用会话')).not.toBeInTheDocument();
    expect(screen.getByText('引用文件')).toBeInTheDocument();
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
    mockApi.file.searchNames.mockResolvedValue({
      hits: [{ path: 'src/a.ts', isDirectory: false }],
      truncated: false,
    });
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

describe('MentionInput 工具条触发（mentionTrigger，2026-11-05 零文本侵入）', () => {
  it('mentionTrigger 变更 → 聚焦 + 直开菜单；输入框零文本侵入（残留/跳行回归锁）', async () => {
    mockApi.file.searchNames.mockResolvedValue({
      hits: [
        { path: 'README.md', isDirectory: false },
        { path: 'src/a.ts', isDirectory: false },
      ],
      truncated: false,
    });
    const { rerender } = render(<MentionInput />);
    const el = editor();
    expect(document.activeElement).not.toBe(el);

    sessionState.mentionTrigger = { kind: 'file', tick: 1 };
    sessionState.mentionScope = 'file';
    rerender(<MentionInput />);
    // 焦点落菜单内搜索框（编辑器不抢焦）；零文本侵入：不插 @、不产生换行——
    // 实测 bug 1/2 回归锁
    expect(document.activeElement).not.toBe(el);
    expect(visibleText(el)).toBe('');
    expect(el.querySelector('br')).toBeNull();
    await waitFor(() => expect(screen.getByText('引用文件')).toBeInTheDocument());
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('skill 触发 → 直开技能组菜单（命令组隐藏，预览 ② 卡6），编辑器零侵入', async () => {
    sessionState.mentionTrigger = { kind: 'skill', tick: 1 };
    sessionState.mentionScope = 'skill';
    const { rerender } = render(<MentionInput />);
    rerender(<MentionInput />);
    expect(visibleText(editor())).toBe('');
    // waitFor 内重查（findByText 的元素引用会被数据到达后的重渲染替换成陈旧节点）
    await waitFor(() => expect(screen.getByText('技能')).toBeInTheDocument());
    expect(screen.getByText('代码审查工作流')).toBeInTheDocument();
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
    expect(screen.queryByText('compact')).not.toBeInTheDocument();
  });

  it('命令菜单打开时点 Agent 按钮 → 跨类型 bump 直接覆盖 menuType，旧菜单让位', async () => {
    const { rerender } = render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '/');
    expect(await screen.findByText('命令')).toBeInTheDocument();

    sessionState.mentionTrigger = { kind: 'agent', tick: 1 };
    sessionState.mentionScope = 'agent';
    rerender(<MentionInput />);
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
    // agent 组空（无在线成员）→ 空态行可感知（手输的 '/' 是用户自己的正文，保留）
    expect(await screen.findByText('暂无在线 agent')).toBeInTheDocument();
    expect(visibleText(el)).toBe('/');
  });

  it('限定菜单打开时键入任意字符 → 菜单关闭、字符留作正文（无触发符残留）', async () => {
    sessionState.mentionTrigger = { kind: 'skill', tick: 1 };
    sessionState.mentionScope = 'skill';
    const { rerender } = render(<MentionInput />);
    rerender(<MentionInput />);
    await waitFor(() => expect(screen.getByText('技能')).toBeInTheDocument());

    typeInEditor(editor(), '好');
    await waitFor(() => expect(screen.queryByText('技能')).toBeNull());
    expect(sessionState.mentionScope).toBeNull();
    expect(visibleText(editor())).toBe('好');
  });

  it('mentionTrigger=null（初始）不开菜单也不抢焦点', () => {
    render(<MentionInput />);
    expect(visibleText(editor())).toBe('');
    expect(document.activeElement).not.toBe(editor());
  });

  it('面板切换重挂载不回放旧菜单（实测 bug 3 回归锁）：信号一次性 + 卸载清 scope', async () => {
    mockApi.file.searchNames.mockResolvedValue({
      hits: [{ path: 'README.md', isDirectory: false }],
      truncated: false,
    });
    sessionState.mentionTrigger = { kind: 'file', tick: 1 };
    sessionState.mentionScope = 'file';
    const { unmount } = render(<MentionInput />);
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy());
    // 触发信号已消费（一次性语义——滞留即重挂载回放）
    expect(sessionState.mentionTrigger).toBeNull();
    // 面板切走（组件卸载，菜单未选择未关闭）→ scope 随卸载清空（工具条高亮不残留）
    unmount();
    expect(sessionState.mentionScope).toBeNull();
    // 切回会话（重挂载）→ 菜单不自动弹出、不抢焦点、输入框干净
    render(<MentionInput />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.queryByText('引用文件')).toBeNull();
    expect(visibleText(editor())).toBe('');
    expect(document.activeElement).not.toBe(editor());
  });
});

// === 按钮限定菜单（mentionScope）生命周期与空态（2026-11-05 预览 ② 卡2/卡3）===
describe('MentionInput 按钮限定菜单（mentionScope）', () => {
  it('agent 限定 + 无在线成员 → 空态行（主行 + 引导副行），菜单可感知', async () => {
    sessionState.members = [];
    sessionState.mentionTrigger = { kind: 'agent', tick: 1 };
    sessionState.mentionScope = 'agent';
    const { rerender } = render(<MentionInput />);
    rerender(<MentionInput />);
    expect(await screen.findByText('暂无在线 agent')).toBeInTheDocument();
    expect(screen.getByText('在「成员」面板启动 agent 后即可引用')).toBeInTheDocument();
    // 空态期间限定不显示文件组（统一菜单被锁到 agent 单组）
    expect(screen.queryByText('引用文件')).not.toBeInTheDocument();
  });

  it('file 限定 + 空工作空间 → 空态行 + 固定导入条目仍可见', async () => {
    mockApi.file.list.mockResolvedValue([]);
    sessionState.mentionTrigger = { kind: 'file', tick: 1 };
    sessionState.mentionScope = 'file';
    const { rerender } = render(<MentionInput />);
    rerender(<MentionInput />);
    expect(await screen.findByText('工作空间暂无文件')).toBeInTheDocument();
    expect(screen.getByText('从电脑导入…')).toBeInTheDocument();
  });

  it('选中条目 → closeMentionScope；pill 追加到末尾且无触发符残留', async () => {
    sessionState.members = [makeMember({ instanceId: 'inst-1', agentName: '程序员' })];
    sessionState.mentionTrigger = { kind: 'agent', tick: 1 };
    sessionState.mentionScope = 'agent';
    const { rerender } = render(<MentionInput />);
    rerender(<MentionInput />);
    fireEvent.click(await screen.findByText('程序员'));
    expect(sessionState.closeMentionScope).toHaveBeenCalled();
    expect(editor().querySelector('[data-kind="agent"][data-id="inst-1"]')).not.toBeNull();
    // 零残留：编辑器内容恰为 pill 显示文本（@程序员），无游离触发符
    expect(visibleText(editor())).toBe('@程序员');
  });

  it('触发符失配（scope=agent 却键入 #）→ scope 清空、回统一任务菜单', async () => {
    taskState.tasks = [makeTask({ id: 'T-9', title: '修复登录' })];
    sessionState.mentionTrigger = { kind: 'agent', tick: 1 };
    sessionState.mentionScope = 'agent';
    const { rerender } = render(<MentionInput />);
    rerender(<MentionInput />);
    // 键入 #（scope 生命周期：菜单类型与 scope 失配即结束限定）
    typeInEditor(editor(), '#');
    await waitFor(() => expect(sessionState.closeMentionScope).toHaveBeenCalled());
    expect(sessionState.mentionScope).toBeNull();
    // scope 已清空 → 手动 # 的统一任务菜单（非 agent 空态）
    await waitFor(() => expect(screen.getByText('选择要引用的任务')).toBeInTheDocument());
  });

  it('Esc → 菜单关闭且 scope 清空；输入框零残留（实测 bug 1 回归锁）', async () => {
    sessionState.mentionTrigger = { kind: 'skill', tick: 1 };
    sessionState.mentionScope = 'skill';
    const { rerender } = render(<MentionInput />);
    rerender(<MentionInput />);
    await waitFor(() => expect(screen.getByText('技能')).toBeInTheDocument());
    fireEvent.keyDown(editor(), { key: 'Escape' });
    expect(sessionState.closeMentionScope).toHaveBeenCalled();
    expect(sessionState.mentionScope).toBeNull();
    expect(visibleText(editor())).toBe('');
  });

  it('手动键入（scope=null）@ 仍出统一菜单：agent+文件+会话三组（回归锁）', async () => {
    sessionState.members = [makeMember({ instanceId: 'inst-1', agentName: '程序员' })];
    sessionState.sessions = [
      { id: 'sess-2', title: '别的会话' } as SessionSummary,
    ];
    mockApi.file.list.mockResolvedValue([{ name: 'a.md', isDirectory: false, size: 1 }]);
    render(<MentionInput />);
    typeInEditor(editor(), '@');
    expect(await screen.findByText('选择要 @ 的 agent')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('a.md')).toBeTruthy());
    expect(screen.getByText('引用会话')).toBeInTheDocument();
  });
});

// === 按钮限定菜单数据完整性（2026-11-05 实测修订）：按钮流 = 完整浏览器，
//     不受手动过滤菜单的 8/10 条截断；文件限定空 query 走全量递归 ===
describe('MentionInput 按钮限定菜单数据完整性', () => {
  /** 按钮触发并等待菜单打开的公共前奏 */
  async function openScoped(kind: 'agent' | 'skill' | 'file' | 'session' | 'task'): Promise<void> {
    sessionState.mentionTrigger = { kind, tick: 1 };
    sessionState.mentionScope = kind;
    const { rerender } = render(<MentionInput />);
    rerender(<MentionInput />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }

  it('file 限定空 query → searchNames("") 全量递归（非根目录默认列表），>8 条全显', async () => {
    mockApi.file.searchNames.mockResolvedValue({
      hits: Array.from({ length: 12 }, (_, i) => ({ path: `src/deep/f${i}.ts`, isDirectory: false })),
      truncated: false,
    });
    await openScoped('file');
    await waitFor(() => expect(mockApi.file.searchNames).toHaveBeenCalledWith('ws-1', ''));
    expect(mockApi.file.list).not.toHaveBeenCalled();
    // 第 12 条可见 = 不受 FILE_MENU_LIMIT=8 截断
    await waitFor(() => expect(screen.getByText('src/deep/f11.ts')).toBeInTheDocument());
  });

  it('agent 限定：12 个在线成员全显（不受 MENU_LIMIT=10 截断）', async () => {
    sessionState.members = Array.from({ length: 12 }, (_, i) =>
      makeMember({ instanceId: `inst-${i}`, agentName: `成员${i}` }),
    );
    await openScoped('agent');
    await waitFor(() => expect(screen.getByText('成员0')).toBeInTheDocument());
    expect(screen.getByText('成员11')).toBeInTheDocument();
  });

  it('skill 限定：10 个已装技能全显（不受 COMMAND_MENU_LIMIT=8 截断）', async () => {
    mockApi.resource.list.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => makeSkillResource({ slug: `skill-${i}`, name: `技能${i}` })),
    );
    await openScoped('skill');
    await waitFor(() => expect(screen.getByText('技能0')).toBeInTheDocument());
    expect(screen.getByText('技能9')).toBeInTheDocument();
  });

  it('session 限定：10 个其他会话全显（不受 SESSION_MENU_LIMIT=8 截断）', async () => {
    sessionState.sessions = Array.from({ length: 10 }, (_, i) =>
      ({ id: `sess-x${i}`, title: `历史会话${i}` }) as SessionSummary,
    );
    await openScoped('session');
    await waitFor(() => expect(screen.getByText('历史会话0')).toBeInTheDocument());
    expect(screen.getByText('历史会话9')).toBeInTheDocument();
  });

  it('task 限定：12 条可激活任务全显（不受 MENU_LIMIT=10 截断）', async () => {
    taskState.tasks = Array.from({ length: 12 }, (_, i) =>
      makeTask({ id: `T-${100 + i}`, title: `任务${i}`, status: 'pending' }),
    );
    await openScoped('task');
    await waitFor(() => expect(screen.getByText(/任务0/)).toBeInTheDocument());
    expect(screen.getByText(/任务11/)).toBeInTheDocument();
  });
});

// === 菜单内搜索框（2026-11-05 用户定案）：按钮限定菜单顶部独立搜索框——
//     输入即过滤（不经会话框）、键盘闭环（↑↓/Enter/Tab/Esc）、无匹配空态 ===
describe('MentionInput 限定菜单内搜索框', () => {
  /** 打开 agent 限定菜单（两个成员）并等列表就绪 */
  async function openAgentMenuWithMembers(): Promise<HTMLInputElement> {
    sessionState.members = [
      makeMember({ instanceId: 'inst-甲', agentName: '成员甲' }),
      makeMember({ instanceId: 'inst-乙', agentName: '成员乙' }),
    ];
    sessionState.mentionTrigger = { kind: 'agent', tick: 1 };
    sessionState.mentionScope = 'agent';
    const { rerender } = render(<MentionInput />);
    rerender(<MentionInput />);
    const input = (await screen.findByTestId('scope-search')) as HTMLInputElement;
    await waitFor(() => expect(screen.getByText('成员甲')).toBeInTheDocument());
    return input;
  }

  it('菜单打开即有搜索框并承接焦点（编辑器不被抢焦）', async () => {
    const input = await openAgentMenuWithMembers();
    expect(input.placeholder).toBe('搜索 agent');
    expect(document.activeElement).toBe(input);
    expect(document.activeElement).not.toBe(editor());
  });

  it('搜索框输入即过滤列表（不经会话框——编辑器零残留）', async () => {
    const input = await openAgentMenuWithMembers();
    fireEvent.change(input, { target: { value: '甲' } });
    await waitFor(() => expect(screen.queryByText('成员乙')).toBeNull());
    expect(screen.getByText('成员甲')).toBeInTheDocument();
    expect(visibleText(editor())).toBe('');
  });

  it('Enter 选中当前高亮条目 → pill 插入、菜单关闭、焦点交还编辑器', async () => {
    const input = await openAgentMenuWithMembers();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    // 高亮第 2 条（成员乙）被选中
    await waitFor(() =>
      expect(editor().querySelector('[data-kind="agent"][data-id="inst-乙"]')).not.toBeNull(),
    );
    expect(screen.queryByTestId('scope-search')).toBeNull();
    expect(document.activeElement).toBe(editor());
  });

  it('Esc 关闭菜单 + 输入框零残留 + 焦点交还编辑器', async () => {
    const input = await openAgentMenuWithMembers();
    fireEvent.change(input, { target: { value: '甲' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('scope-search')).toBeNull();
    expect(visibleText(editor())).toBe('');
    expect(document.activeElement).toBe(editor());
    expect(sessionState.mentionScope).toBeNull();
  });

  it('清空残留 <br> 的脏编辑器上选中 → 复位纯净再插 pill，不跳行（实测 bug 4 回归锁）', async () => {
    sessionState.members = [makeMember({ instanceId: 'inst-1', agentName: '程序员' })];
    sessionState.mentionTrigger = { kind: 'agent', tick: 1 };
    sessionState.mentionScope = 'agent';
    const { rerender } = render(<MentionInput />);
    rerender(<MentionInput />);
    // 仿真 Chromium「输入过再全选删除」残留 <br> 的脏 DOM（jsdom 不自然产生）
    const el = editor();
    el.appendChild(document.createElement('br'));
    fireEvent.click(await screen.findByText('程序员'));
    const pill = el.querySelector('[data-kind="agent"][data-id="inst-1"]');
    expect(pill).not.toBeNull();
    // 残留 <br> 已被复位清除——pill 为首个子节点，无跳行
    expect(el.querySelector('br')).toBeNull();
    expect(el.firstChild).toBe(pill);
  });

  it('搜索无命中 → 「无匹配」空态（与组空态区分）', async () => {
    const input = await openAgentMenuWithMembers();
    fireEvent.change(input, { target: { value: '不存在的名字' } });
    await waitFor(() => expect(screen.getByText(/无匹配「不存在的名字」/)).toBeInTheDocument());
    expect(screen.queryByText('成员甲')).toBeNull();
  });

  it('文件限定：搜索框输入走 debounce searchNames（会话框 query 不参与）', async () => {
    mockApi.file.searchNames.mockResolvedValue({
      hits: [{ path: 'src/a.ts', isDirectory: false }],
      truncated: false,
    });
    sessionState.mentionTrigger = { kind: 'file', tick: 1 };
    sessionState.mentionScope = 'file';
    const { rerender } = render(<MentionInput />);
    rerender(<MentionInput />);
    await waitFor(() => expect(mockApi.file.searchNames).toHaveBeenCalledWith('ws-1', ''));
    const input = (await screen.findByTestId('scope-search')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'a.t' } });
    // debounce 200ms（真实时钟等待——fake timers 会冻结 waitFor 轮询导致挂起）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(mockApi.file.searchNames).toHaveBeenLastCalledWith('ws-1', 'a.t');
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
  });

  it('文件限定：truncated=true → 结果列表底部示警「扫描已达上限」（方案 C）', async () => {
    mockApi.file.searchNames.mockResolvedValue({
      hits: [{ path: 'src/a.ts', isDirectory: false }],
      truncated: true,
    });
    sessionState.mentionTrigger = { kind: 'file', tick: 1 };
    sessionState.mentionScope = 'file';
    const { rerender } = render(<MentionInput />);
    rerender(<MentionInput />);
    await waitFor(() => expect(screen.getByText('src/a.ts')).toBeInTheDocument());
    expect(screen.getByText(/扫描已达上限/)).toBeInTheDocument();
  });

  it('文件限定：truncated=false → 不显示扫描上限示警', async () => {
    mockApi.file.searchNames.mockResolvedValue({
      hits: [{ path: 'src/a.ts', isDirectory: false }],
      truncated: false,
    });
    sessionState.mentionTrigger = { kind: 'file', tick: 1 };
    sessionState.mentionScope = 'file';
    const { rerender } = render(<MentionInput />);
    rerender(<MentionInput />);
    await waitFor(() => expect(screen.getByText('src/a.ts')).toBeInTheDocument());
    expect(screen.queryByText(/扫描已达上限/)).toBeNull();
  });

  it('文件限定：零命中 + truncated=true → 空态改口「未在已扫描范围内找到」（不宣称没有）', async () => {
    mockApi.file.searchNames.mockResolvedValue({ hits: [], truncated: true });
    sessionState.mentionTrigger = { kind: 'file', tick: 1 };
    sessionState.mentionScope = 'file';
    const { rerender } = render(<MentionInput />);
    rerender(<MentionInput />);
    const input = (await screen.findByTestId('scope-search')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'zzz' } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(screen.getByText('未在已扫描范围内找到「zzz」')).toBeInTheDocument();
    expect(screen.queryByText('无匹配「zzz」')).toBeNull();
  });

  it('手动路径无搜索框（@ 统一菜单保持原形态）', async () => {
    sessionState.members = [makeMember({ instanceId: 'inst-1', agentName: '成员甲' })];
    render(<MentionInput />);
    typeInEditor(editor(), '@');
    expect(await screen.findByText('成员甲')).toBeInTheDocument();
    expect(screen.queryByTestId('scope-search')).toBeNull();
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

  it('语义保持：无空白前导的 / 不触发（路径/分数）、// 转义不触发、正文后 @ 不弹成员菜单', () => {
    render(<MentionInput />);
    typeInEditor(editor(), '看下 src/文件');
    expect(screen.queryByText('命令')).toBeNull();
    typeInEditor(editor(), '//');
    expect(screen.queryByText('命令')).toBeNull();
    typeInEditor(editor(), '邮箱a@b.com不发菜单');
    expect(screen.queryByText('选择要 @ 的 agent')).toBeNull();
  });
});

// === v3.1 主机反馈：句中 /（空白前导）触发命令+技能菜单——与 @/# 对称 ===
// 语义变更：v2.11 整串锚定（仅空 body 以 / 开头）→ 空白前缀锚定
// `(?:^|\s)\/`。噪声守卫：无空白前导的 /（路径 src/文件、24/7、and/or、
// URL）仍不触发；'//' 转义仍不触发（第二个 / 不在字符集）。
describe('MentionInput 句中 / 触发（v3.1：与 @/# 对称）', () => {
  it('句中空格后的 / 触发命令+技能两组菜单（帮我执行 /）', async () => {
    render(<MentionInput />);
    typeInEditor(editor(), '帮我执行 /');
    await waitFor(() => expect(screen.getByText('命令')).toBeTruthy());
    expect(screen.getByText('技能')).toBeTruthy();
  });

  it('句中 /xxx 过滤命令组（query 接管）', async () => {
    render(<MentionInput />);
    typeInEditor(editor(), '帮我执行 /compact');
    await waitFor(() => expect(screen.getByText('/compact')).toBeTruthy());
  });

  it('pill 之后的 / 同样触发（pill 折叠空格作空白前导）', async () => {
    sessionState.members = [makeMember({ instanceId: 'i-1', agentName: 'coder' })];
    render(<MentionInput />);
    typeInEditor(editor(), '@');
    fireEvent.click(await screen.findByText('coder'));
    // pill 就位（ZWSP 末节点），追加 ' /' —— beforeCaret 为 ' @coder折叠空格/'
    typeAtEnd(editor(), ' /');
    await waitFor(() => expect(screen.getByText('命令')).toBeTruthy());
  });

  it('噪声守卫：24/7、and/or、https://x 的 / 不触发', () => {
    render(<MentionInput />);
    typeInEditor(editor(), '24/7 天假');
    expect(screen.queryByText('命令')).toBeNull();
    typeInEditor(editor(), 'and/or 与 https://x/y');
    expect(screen.queryByText('命令')).toBeNull();
  });

  it('句中选择技能 pill：replaceLen 只吞 /局部，正文保留、context 照常下发', async () => {
    render(<MentionInput />);
    typeInEditor(editor(), '帮我执行 /');
    const skillItem = await screen.findByText('代码审查工作流');
    fireEvent.click(skillItem);
    // 菜单关闭 + Enter 发送：body='帮我执行'（skill 不进正文 + /局部被吞），context 透传
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() =>
      expect(sessionState.sendMessage).toHaveBeenCalledWith(
        '帮我执行',
        undefined,
        expect.objectContaining({
          skills: [expect.objectContaining({ slug: 'code-review-workflow' })],
        }),
      ),
    );
  });
});

// === Kimi 式单一容器（v2.11.1 F3→v3 pill 形态）：pills-in-editor + 📎 框内 ===
describe('MentionInput Kimi 式容器（pill 时代形态）', () => {
  it('选文件后 pill 渲染在编辑器内（pills-in-editor）；📎 仍在 .rounded-lg 容器框内', async () => {
    mockApi.file.searchNames.mockResolvedValue({
      hits: [{ path: 'a.ts', isDirectory: false }],
      truncated: false,
    });
    render(<MentionInput />);
    typeInEditor(editor(), '@a');
    fireEvent.click(await screen.findByText('a.ts'));
    expect(editor().querySelector('[data-kind="file"]')).not.toBeNull();
    expect(screen.getByLabelText('从电脑导入').closest('.rounded-lg')).toBeTruthy();
  });

  it('📎（从电脑导入）点击打开系统文件选择器（hidden input），不再走菜单触发', () => {
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    render(<MentionInput />);
    const btn = screen.getByLabelText('从电脑导入');
    expect(btn.closest('.rounded-lg')).toBeTruthy();
    fireEvent.click(btn);
    // 语义转换（2026-11-05 预览）：直接开文件选择器，不 bump 菜单触发
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(sessionState.bumpMentionTrigger).not.toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it('readOnly → 📎 禁用；chip 行退役后底行仅 📎', () => {
    sessionState.activeSessionReadOnly = true;
    render(<MentionInput />);
    expect((screen.getByLabelText('从电脑导入') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText(/移除/)).toBeNull();
  });
});

// === 外部文件导入管线（2026-11-05 预览方案 A/C）：📎 / 文件菜单固定条目 / 拖拽
//     三入口同管线——图片扩展名走 image pill 通道，其余 importFile 复制进
//     imports/ 后插 file pill（id=路径进序列化、label=文件名显示）===
describe('MentionInput 文件导入（importFile 管线）', () => {
  /**
   * 模拟文件选择：jsdom 的 input.files 是只读 getter——fireEvent 的
   * target 普通赋值静默失败（handler 拿到空 FileList），必须 defineProperty。
   */
  function pickFiles(input: HTMLInputElement, files: File[]): void {
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    fireEvent.change(input);
  }

  /**
   * jsdom 的 Blob 无 arrayBuffer（生产为真浏览器 API）——实例级 polyfill：
   * bytes.slice() 取独占 buffer，与真实 arrayBuffer 字节语义一致。
   */
  function makeFile(bytes: Uint8Array<ArrayBuffer>, name: string, type?: string): File {
    const f = new File([bytes], name, type !== undefined ? { type } : undefined);
    if (typeof f.arrayBuffer !== 'function') {
      Object.defineProperty(f, 'arrayBuffer', {
        value: async (): Promise<ArrayBuffer> => bytes.slice().buffer as ArrayBuffer,
        configurable: true,
      });
    }
    return f;
  }

  it('选择非图片文件 → importFile(ws, data, name) → file pill（id=imports 路径、label=文件名）', async () => {
    render(<MentionInput />);
    const input = screen.getByTestId('import-file-input') as HTMLInputElement;
    pickFiles(input, [makeFile(new Uint8Array([1, 2, 3]), '需求文档 v2.docx')]);
    await waitFor(() => {
      expect(mockApi.asset.importFile).toHaveBeenCalledWith(
        'ws-1',
        expect.any(Uint8Array),
        '需求文档 v2.docx',
      );
    });
    await waitFor(() => {
      const pill = editor().querySelector('[data-kind="file"]');
      expect(pill).not.toBeNull();
      expect(pill?.getAttribute('data-id')).toBe('imports/需求文档 v2.docx');
      expect(pill?.getAttribute('data-label')).toBe('需求文档 v2.docx');
    });
  });

  it('图片扩展名分流：走降采样 + saveImage 的 image pill 通道，不经 importFile', async () => {
    render(<MentionInput />);
    const input = screen.getByTestId('import-file-input') as HTMLInputElement;
    const file = new File([new Uint8Array([1])], '截图.png', { type: 'image/png' });
    pickFiles(input, [file]);
    await waitFor(() => {
      expect(mockApi.asset.saveImage).toHaveBeenCalledWith('ws-1', expect.any(Uint8Array), 'png');
    });
    await waitFor(() => {
      expect(editor().querySelector('[data-kind="image"]')).not.toBeNull();
    });
    expect(mockApi.asset.importFile).not.toHaveBeenCalled();
  });

  it('拖入悬停 → 容器虚线强调框 + 居中提示（预览 ③ 卡B）；离开/放下复位', async () => {
    render(<MentionInput />);
    const wrap = editor().parentElement as HTMLElement;
    expect(wrap.className).toContain('border-subtle');
    fireEvent.dragEnter(wrap, { dataTransfer: { types: ['Files'] } });
    expect(wrap.className).toContain('border-dashed');
    const hint = screen.getByTestId('drop-hint');
    expect(hint.textContent).toContain('松开鼠标 · 文件将复制到工作空间 imports/');
    // overlay 不挡事件（drop 仍落在编辑器）
    expect(hint.className).toContain('pointer-events-none');
    fireEvent.dragLeave(wrap, { dataTransfer: { types: ['Files'] } });
    await waitFor(() => expect(screen.queryByTestId('drop-hint')).toBeNull());
    expect(wrap.className).toContain('border-subtle');
  });

  it('拖拽非图片文件到编辑器（方案 C）→ 同管线导入并插 file pill', async () => {
    render(<MentionInput />);
    const file = makeFile(new Uint8Array([9]), '报表.xlsx');
    fireEvent.drop(editor(), { dataTransfer: { files: [file] } });
    await waitFor(() => {
      expect(mockApi.asset.importFile).toHaveBeenCalledWith('ws-1', expect.any(Uint8Array), '报表.xlsx');
    });
    await waitFor(() => {
      expect(editor().querySelector('[data-kind="file"][data-id="imports/报表.xlsx"]')).not.toBeNull();
    });
  });

  it('importFile 失败 → 内联错误提示 + 不插 pill，输入不受影响（错误路径）', async () => {
    mockApi.asset.importFile.mockRejectedValueOnce(new Error('磁盘已满'));
    render(<MentionInput />);
    const input = screen.getByTestId('import-file-input') as HTMLInputElement;
    pickFiles(input, [makeFile(new Uint8Array([1]), 'a.pdf')]);
    await waitFor(() => expect(screen.getByText(/导入失败：磁盘已满/)).toBeTruthy());
    expect(editor().querySelector('[data-kind="file"]')).toBeNull();
    expect(visibleText(editor())).toBe('');
  });

  it('超过 64MB → 拦截提示且不调 importFile（守门前置）', async () => {
    render(<MentionInput />);
    const input = screen.getByTestId('import-file-input') as HTMLInputElement;
    const file = new File([new Uint8Array([1])], '大视频.mov');
    Object.defineProperty(file, 'size', { value: 64 * 1024 * 1024 + 1 });
    pickFiles(input, [file]);
    await waitFor(() => expect(screen.getByText(/超过 64MB 上限/)).toBeTruthy());
    expect(mockApi.asset.importFile).not.toHaveBeenCalled();
  });

  it('空文件列表（取消选择）→ 无 IPC 无 pill（空输入路径）', () => {
    render(<MentionInput />);
    const input = screen.getByTestId('import-file-input') as HTMLInputElement;
    pickFiles(input, []);
    expect(mockApi.asset.importFile).not.toHaveBeenCalled();
    expect(mockApi.asset.saveImage).not.toHaveBeenCalled();
  });
});

// === 终审修复回归锁（I1 焦点恢复 / I2 点编辑器=放弃菜单）===
// I1：菜单 button 的 mousedown 在真实浏览器中偷走焦点（选完 pill 焦点落
// body → 键盘输入落空）；v2.11.1 insertMention 有显式 focus 恢复，v3
// selectWithPill 迁移时遗失。jsdom 的 fireEvent.click 不仿真 mousedown
// 焦点转移——手动 focus 菜单按钮仿真「偷焦点后」状态，断言选择后编辑器
// 重新持有焦点（spy + activeElement 双断言）。
// I2：菜单激活时点击编辑器文字区 = 放弃菜单（RichComposer.handleMouseDown
// 文字区分支同步 onEscape，与「点文字区清除选中态」对称）。防御：菜单开着
// 移动光标（点击 / 方向键均无 input 事件，menuType/query 不变）后再点菜单
// 项，insertPill 的 replaceLen 与光标实况失联，会无条件删新光标前字符——
// 正常文字被静默吞掉；菜单在点击编辑器时即关闭，「移动光标后选择」无从发生。
describe('MentionInput 终审修复（I1 焦点恢复 / I2 点编辑器关菜单）', () => {
  it('I1：菜单选择后编辑器获得焦点（selectWithPill 显式恢复——菜单按钮偷焦点后键盘不落空）', () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-pm', agentName: 'PM-agent', lastRunning: true }),
    ];
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '@');
    // jsdom 的 click 不做焦点转移——手动 focus 菜单按钮，仿真真实浏览器
    // 「菜单 button 的 mousedown 偷走焦点」后的状态
    const menuBtn = screen.getByText('PM-agent').closest('button') as HTMLElement;
    menuBtn.focus();
    expect(document.activeElement).not.toBe(el);
    const focusSpy = vi.spyOn(el, 'focus');
    fireEvent.click(menuBtn);
    expect(hasPill(el, 'agent', 'inst-pm')).toBe(true);
    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(el);
  });

  it('I2：菜单激活时点击编辑器文字区 → 菜单关闭（移动光标即放弃，无从吞字）', () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-pm', agentName: 'PM-agent', lastRunning: true }),
    ];
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '@');
    expect(screen.getByText('选择要 @ 的 agent')).toBeInTheDocument();
    fireEvent.mouseDown(el);
    expect(screen.queryByText('选择要 @ 的 agent')).not.toBeInTheDocument();
  });

  it('I2 反向锁：菜单激活时点击 pill → pill 选中且菜单保持（pill 路径不触发放弃语义）', () => {
    sessionState.members = [
      makeMember({ instanceId: 'inst-pm', agentName: 'PM-agent', lastRunning: true }),
    ];
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '@');
    fireEvent.click(screen.getByText('PM-agent'));
    // pill 后继续敲 @ 再开菜单（折叠空格仍可触发）
    typeAtEnd(el, ' @');
    expect(screen.getByText('选择要 @ 的 agent')).toBeInTheDocument();
    const pill = el.querySelector('span[data-kind="agent"]') as HTMLSpanElement;
    fireEvent.mouseDown(pill);
    expect(pill.dataset.selected).toBe('1');
    // 菜单保持——点 pill 是选中操作，不是放弃菜单
    expect(screen.getByText('选择要 @ 的 agent')).toBeInTheDocument();
  });
});

describe('MentionInput 菜单键盘导航（2026-09-26 可用性 P0：↑↓/Enter/Tab/Esc）', () => {
  /** 当前高亮菜单按钮（data-active="1" 是渲染契约） */
  function activeButton(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>('button[data-active="1"]');
  }

  it('↑↓ 循环移动高亮；Enter 选中高亮项落 pill 且不发送消息', () => {
    // given：两名在线成员，@ 菜单开
    sessionState.members = [
      makeMember({ instanceId: 'inst-a', agentName: 'Alpha' }),
      makeMember({ instanceId: 'inst-b', agentName: 'Beta' }),
    ];
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '@');
    expect(activeButton()?.textContent).toContain('Alpha');
    // when：ArrowDown → 高亮第二条
    fireEvent.keyDown(el, { key: 'ArrowDown' });
    expect(activeButton()?.textContent).toContain('Beta');
    // when：再 ArrowDown → 两条循环回顶
    fireEvent.keyDown(el, { key: 'ArrowDown' });
    expect(activeButton()?.textContent).toContain('Alpha');
    // when：ArrowUp → 逆向循环到底
    fireEvent.keyDown(el, { key: 'ArrowUp' });
    expect(activeButton()?.textContent).toContain('Beta');
    // then：Enter 选中 Beta——agent pill 就位、菜单关闭、消息不发送
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(hasPill(el, 'agent', 'inst-b')).toBe(true);
    expect(activeButton()).toBeNull();
    expect(sessionState.sendMessage).not.toHaveBeenCalled();
  });

  it('Tab 选中高亮条目（/ 菜单命令组，异步数据源 waitFor 后）', async () => {
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '/');
    await waitFor(() => expect(screen.getByText('/compact')).toBeInTheDocument());
    expect(activeButton()?.textContent).toContain('/compact');
    fireEvent.keyDown(el, { key: 'Tab' });
    expect(hasPill(el, 'command', 'compact')).toBe(true);
    expect(sessionState.sendMessage).not.toHaveBeenCalled();
  });

  it('Esc 关闭菜单（正文保留，后续 Enter 恢复发送语义）', async () => {
    sessionState.members = [makeMember({ instanceId: 'inst-a', agentName: 'Alpha' })];
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '@');
    expect(screen.getByText('选择要 @ 的 agent')).toBeInTheDocument();
    fireEvent.keyDown(el, { key: 'Escape' });
    expect(screen.queryByText('选择要 @ 的 agent')).not.toBeInTheDocument();
    expect(visibleText(el)).toBe('@');
    // 菜单关后 Enter = 正常发送
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalledWith('@', undefined, undefined));
  });

  it('@ 零命中（菜单无条目）时 Enter 照常发送——不再静默吞 Enter', async () => {
    sessionState.members = [];
    mockApi.file.searchNames.mockResolvedValue({ hits: [], truncated: false });
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '@zzz');
    expect(activeButton()).toBeNull();
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalledWith('@zzz', undefined, undefined));
  });

  it('IME 提交补偿（P0 回归锁）：compositionend 后过滤立即生效，无需再敲一个字符', () => {
    // given：Alpha/Beta 两成员，@ 菜单已开（query 空，双条目可见）
    sessionState.members = [
      makeMember({ instanceId: 'inst-a', agentName: 'Alpha' }),
      makeMember({ instanceId: 'inst-b', agentName: 'Beta' }),
    ];
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '@');
    expect(screen.getByText('Beta')).toBeInTheDocument();
    // when：中文 IME 组合输入 Al——组合期 input 被守卫跳过（Beta 仍在 = 检测未跑）
    fireEvent.compositionStart(el);
    el.textContent = '@Al';
    setCaret(el.lastChild!, 3);
    fireEvent.input(el);
    expect(screen.getByText('Beta')).toBeInTheDocument();
    // then：compositionend 提交 → 补发检测 → query='Al' 过滤掉 Beta
    fireEvent.compositionEnd(el);
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(activeButton()?.textContent).toContain('Alpha');
  });
});

// === 图片输入管线（2026-09-26 多模态 spec §5/§10）===
describe('MentionInput 粘贴/拖入图片管线', () => {
  /** 模拟一次单图粘贴事件（RichComposer onPaste 已拦截上抛，此处从事件起全链路） */
  function pasteImage(el: HTMLElement, name = 'shot.png'): void {
    fireEvent.paste(el, {
      clipboardData: { files: [new File([new Uint8Array([1])], name, { type: 'image/png' })] },
    });
  }

  it('粘贴图片 → downscale → saveImage → image pill；Enter 发送 context.images 透传', async () => {
    render(<MentionInput />);
    const el = editor();
    pasteImage(el);
    await waitFor(() =>
      expect(el.querySelector('span[data-kind="image"][data-id=".momo/assets/abc123def456.png"]')).not.toBeNull(),
    );
    expect(downscaleMock).toHaveBeenCalledTimes(1);
    expect(mockApi.asset.saveImage).toHaveBeenCalledWith('ws-1', expect.any(Uint8Array), 'png');
    // pill 显示文件名（label）+ 图标 svg
    const pill = el.querySelector('span[data-kind="image"]') as HTMLElement;
    expect(pill.dataset.label).toBe('shot.png');
    expect(pill.querySelector('svg')).not.toBeNull();
    typeAtEnd(el, '看下这张');
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    expect(sessionState.sendMessage).toHaveBeenCalledWith('[图片: shot.png] 看下这张', undefined, {
      skills: [],
      files: [],
      images: [{ path: '.momo/assets/abc123def456.png', w: 800, h: 600 }],
    });
  });

  it('拖入图片走同一管线（drop 事件 → image pill）', async () => {
    render(<MentionInput />);
    const el = editor();
    fireEvent.drop(el, {
      dataTransfer: { files: [new File([new Uint8Array([1])], 'drop.png', { type: 'image/png' })] },
    });
    await waitFor(() => expect(el.querySelector('span[data-kind="image"]')).not.toBeNull());
    expect(mockApi.asset.saveImage).toHaveBeenCalledWith('ws-1', expect.any(Uint8Array), 'png');
  });

  it('第 7 张被拒：仅 6 pill + 「最多 6 张图片」提示（拒绝发生在 downscale 之前）', async () => {
    render(<MentionInput />);
    const el = editor();
    for (let i = 0; i < 7; i++) {
      mockApi.asset.saveImage.mockResolvedValueOnce({ path: `.momo/assets/p${i}.png` });
      pasteImage(el, `s${i}.png`);
      await waitFor(() =>
        expect(el.querySelectorAll('span[data-kind="image"]')).toHaveLength(Math.min(i + 1, 6)),
      );
    }
    expect(el.querySelectorAll('span[data-kind="image"]')).toHaveLength(6);
    expect(downscaleMock).toHaveBeenCalledTimes(6);
    expect(mockApi.asset.saveImage).toHaveBeenCalledTimes(6);
    expect(screen.getByText('最多 6 张图片')).toBeInTheDocument();
  });

  it('saveImage 失败 → 不插 pill + 内联错误提示（spec §11：输入不受影响）', async () => {
    mockApi.asset.saveImage.mockRejectedValue(new Error('磁盘空间不足'));
    render(<MentionInput />);
    const el = editor();
    pasteImage(el);
    await waitFor(() => expect(screen.getByText(/磁盘空间不足/)).toBeInTheDocument());
    expect(el.querySelector('span[data-kind="image"]')).toBeNull();
    // 编辑器仍可正常输入
    typeInEditor(el, '正常输入');
    expect(visibleText(el)).toBe('正常输入');
  });

  it('downscale 失败（>20MB）→ 不调 saveImage + 中文错误提示', async () => {
    downscaleMock.mockRejectedValue(new Error('图片超过 20MB 上限，已忽略：huge.png'));
    render(<MentionInput />);
    const el = editor();
    pasteImage(el, 'huge.png');
    await waitFor(() => expect(screen.getByText(/图片超过 20MB/)).toBeInTheDocument());
    expect(mockApi.asset.saveImage).not.toHaveBeenCalled();
    expect(el.querySelector('span[data-kind="image"]')).toBeNull();
  });

  it('多张同批粘贴超限：批次内截断（已有 4 张 + 一次贴 3 张 → 只收 2 张 + 提示）', async () => {
    render(<MentionInput />);
    const el = editor();
    for (let i = 0; i < 4; i++) {
      mockApi.asset.saveImage.mockResolvedValueOnce({ path: `.momo/assets/p${i}.png` });
      pasteImage(el, `s${i}.png`);
      await waitFor(() => expect(el.querySelectorAll('span[data-kind="image"]')).toHaveLength(i + 1));
    }
    const three = ['a.png', 'b.png', 'c.png'].map(
      (n) => new File([new Uint8Array([1])], n, { type: 'image/png' }),
    );
    mockApi.asset.saveImage
      .mockResolvedValueOnce({ path: '.momo/assets/x1.png' })
      .mockResolvedValueOnce({ path: '.momo/assets/x2.png' });
    fireEvent.paste(el, { clipboardData: { files: three } });
    await waitFor(() => expect(el.querySelectorAll('span[data-kind="image"]')).toHaveLength(6));
    expect(mockApi.asset.saveImage).toHaveBeenCalledTimes(6);
    expect(screen.getByText('最多 6 张图片')).toBeInTheDocument();
  });

  it('并发双批次上限（Task 9 fold-in b）：已有 5 张 + 两批 2 张在途 → 第 7 张跨批被拒', async () => {
    render(<MentionInput />);
    const el = editor();
    for (let i = 0; i < 5; i++) {
      mockApi.asset.saveImage.mockResolvedValueOnce({ path: `.momo/assets/p${i}.png` });
      pasteImage(el, `s${i}.png`);
      await waitFor(() => expect(el.querySelectorAll('span[data-kind="image"]')).toHaveLength(i + 1));
    }
    // 两批并发在途：旧实现 room 在批次开始时快照（各算 1）→ 5+1+1=7 超限；
    // 修复后 insertPill 前权威现值复查 → 跨批第 7 张被拒（输家已付出的
    // downscale/saveImage 不回收——pill 不落编辑器即用户可见语义正确）
    const batch = (prefix: string): File[] =>
      [`${prefix}1.png`, `${prefix}2.png`].map(
        (n) => new File([new Uint8Array([1])], n, { type: 'image/png' }),
      );
    mockApi.asset.saveImage.mockResolvedValue({ path: '.momo/assets/x.png' });
    fireEvent.paste(el, { clipboardData: { files: batch('a') } });
    fireEvent.paste(el, { clipboardData: { files: batch('b') } });
    await waitFor(() => expect(screen.getByText('最多 6 张图片')).toBeInTheDocument());
    expect(el.querySelectorAll('span[data-kind="image"]')).toHaveLength(6);
    // 两个批次的首张都完成 downscale/saveImage（6 种子 + 输家 1 次），
    // 但只有先到者落 pill
    expect(downscaleMock).toHaveBeenCalledTimes(7);
    expect(mockApi.asset.saveImage).toHaveBeenCalledTimes(7);
  });
});

describe('MentionInput @ 菜单图片分流（spec §5）', () => {
  it('图片扩展名条目 lucide-image 图标差异；选中插 image pill（2048 哨兵尺寸）+ images 通道', async () => {
    mockApi.file.searchNames.mockResolvedValue({
      hits: [
        { path: 'docs/diagram.png', isDirectory: false },
        { path: 'docs/readme.md', isDirectory: false },
      ],
      truncated: false,
    });
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '@diagram');
    const imgBtn = (await screen.findByText('docs/diagram.png')).closest('button') as HTMLElement;
    // 图标分流：图片条目 lucide-image，普通文件条目 lucide-file-text
    expect(imgBtn.querySelector('svg.lucide-image')).not.toBeNull();
    const mdBtn = screen.getByText('docs/readme.md').closest('button') as HTMLElement;
    expect(mdBtn.querySelector('svg.lucide-file-text')).not.toBeNull();
    fireEvent.click(imgBtn);
    expect(hasPill(el, 'image', 'docs/diagram.png')).toBe(true);
    // 哨兵尺寸（@ 选择时无 File 可解码——主进程 expand 拿真图，token 估算按上界）
    const pill = el.querySelector('span[data-kind="image"]') as HTMLElement;
    expect(pill.dataset.w).toBe('2048');
    expect(pill.dataset.h).toBe('2048');
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    expect(sessionState.sendMessage).toHaveBeenCalledWith('[图片: docs/diagram.png]', undefined, {
      skills: [],
      files: [],
      images: [{ path: 'docs/diagram.png', w: 2048, h: 2048 }],
    });
  });

  it('非图片扩展名条目照旧进 file 通道（回归锁——分流不误伤普通文件）', async () => {
    mockApi.file.searchNames.mockResolvedValue({
      hits: [{ path: 'docs/readme.md', isDirectory: false }],
      truncated: false,
    });
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '@readme');
    fireEvent.click(await screen.findByText('docs/readme.md'));
    expect(hasPill(el, 'file', 'docs/readme.md')).toBe(true);
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    expect(sessionState.sendMessage).toHaveBeenCalledWith('@docs/readme.md', undefined, {
      skills: [],
      files: [{ path: 'docs/readme.md' }],
    });
  });

  it('@ 图片选择同样受上限 6 拦截（第 7 个图片条目点击 → 无 pill + 提示）', async () => {
    mockApi.file.searchNames.mockResolvedValue({
      hits: [{ path: 'docs/d7.png', isDirectory: false }],
      truncated: false,
    });
    render(<MentionInput />);
    const el = editor();
    // 先经粘贴灌满 6 张
    for (let i = 0; i < 6; i++) {
      mockApi.asset.saveImage.mockResolvedValueOnce({ path: `.momo/assets/p${i}.png` });
      fireEvent.paste(el, {
        clipboardData: {
          files: [new File([new Uint8Array([1])], `s${i}.png`, { type: 'image/png' })],
        },
      });
      await waitFor(() => expect(el.querySelectorAll('span[data-kind="image"]')).toHaveLength(i + 1));
    }
    typeAtEnd(el, ' @d7');
    fireEvent.click(await screen.findByText('docs/d7.png'));
    expect(el.querySelectorAll('span[data-kind="image"]')).toHaveLength(6);
    expect(hasPill(el, 'image', 'docs/d7.png')).toBe(false);
    expect(screen.getByText('最多 6 张图片')).toBeInTheDocument();
    // 菜单已关（放弃语义与选择一致）
    expect(screen.queryByText('引用文件')).not.toBeInTheDocument();
  });
});

describe('MentionInput 能力提示行（spec §8 场景 1）', () => {
  function pasteOne(el: HTMLElement): void {
    fireEvent.paste(el, {
      clipboardData: {
        files: [new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })],
      },
    });
  }

  it('全员 vision=false（含缺省）+ image pill → 提示行出现；删 pill → 消失', async () => {
    sessionState.members = [
      makeMember({ instanceId: 'i-1', agentName: 'coder', vision: false }),
      makeMember({ instanceId: 'i-2', agentName: 'writer' }), // 旧载荷缺省 → 按 false 消费
    ];
    render(<MentionInput />);
    const el = editor();
    // 无 image pill 时不显示
    expect(screen.queryByText(/不支持图片/)).toBeNull();
    pasteOne(el);
    await waitFor(() => expect(el.querySelector('span[data-kind="image"]')).not.toBeNull());
    expect(
      screen.getByText('当前 agent 的模型不支持图片，发送时图片将省略'),
    ).toBeInTheDocument();
    // Backspace 两段删除 pill → removePill 补发 onInputText → 提示即时消失
    const pill = el.querySelector('span[data-kind="image"]') as HTMLSpanElement;
    setCaret(pill.nextSibling as Text, 0);
    fireEvent.keyDown(el, { key: 'Backspace' });
    fireEvent.keyDown(el, { key: 'Backspace' });
    await waitFor(() => expect(screen.queryByText(/不支持图片/)).toBeNull());
  });

  it('任一成员 vision=true → 不显示提示', async () => {
    sessionState.members = [
      makeMember({ instanceId: 'i-1', agentName: 'coder', vision: true }),
    ];
    render(<MentionInput />);
    const el = editor();
    pasteOne(el);
    await waitFor(() => expect(el.querySelector('span[data-kind="image"]')).not.toBeNull());
    expect(screen.queryByText(/不支持图片/)).toBeNull();
  });

it('发送后提示随 pill 清空消失', async () => {
    sessionState.members = [makeMember({ instanceId: 'i-1', agentName: 'coder' })];
    render(<MentionInput />);
    const el = editor();
    pasteOne(el);
    await waitFor(() => expect(el.querySelector('span[data-kind="image"]')).not.toBeNull());
    expect(screen.getByText(/不支持图片/)).toBeInTheDocument();
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/不支持图片/)).toBeNull());
  });

  // F-5：混合团队提示（spec §8 场景 2）——与场景 1 全员非 vision 分支互斥
  it('混合团队：leader 非 vision + 存在 vision 成员 + image pill → 列出 vision 成员名（场景 1 提示不出现）', async () => {
    sessionState.members = [
      makeMember({ instanceId: 'i-pm', agentName: 'pm-agent', isLeader: true, vision: false }),
      makeMember({ instanceId: 'i-vision', agentName: 'vision-bot', isLeader: false, vision: true }),
    ];
    render(<MentionInput />);
    const el = editor();
    pasteOne(el);
    await waitFor(() => expect(el.querySelector('span[data-kind="image"]')).not.toBeNull());
    // 场景 1 文案「发送时图片将省略」必须缺席（互斥分支）
    expect(screen.queryByText(/发送时图片将省略/)).toBeNull();
    // 混合提示行：含 vision 成员名「vision-bot」+ 团队措辞（精确匹配提示 span 文本）
    expect(
      screen.getByText(/团队成员.+vision-bot.+可识别图片/),
    ).toBeInTheDocument();
  });

  it('全员 vision=true（leader 也 vision）→ 混合提示与场景 1 提示均不出现', async () => {
    sessionState.members = [
      makeMember({ instanceId: 'i-pm', agentName: 'pm-agent', isLeader: true, vision: true }),
      makeMember({ instanceId: 'i-coder', agentName: 'coder', isLeader: false, vision: true }),
    ];
    render(<MentionInput />);
    const el = editor();
    pasteOne(el);
    await waitFor(() => expect(el.querySelector('span[data-kind="image"]')).not.toBeNull());
    // 场景 1 文案缺席
    expect(screen.queryByText(/不支持图片/)).toBeNull();
    expect(screen.queryByText(/发送时图片将省略/)).toBeNull();
    // 混合提示行缺席（无「团队成员」措辞）
    expect(screen.queryByText(/团队成员/)).toBeNull();
  });
});

// 13. 命令执行中（/compact B+C 档反馈）：pending 提示条渲染 + 键控隔离 + 禁发
describe('MentionInput 命令执行中（pending 反馈 + 禁发）', () => {
  it('pending 时渲染进度提示条（正在压缩文案）', () => {
    sessionState.commandPendingBySession = new Map([['sess-1', 'compact']]);
    render(<MentionInput />);
    const hint = screen.getByTestId('command-pending-hint');
    expect(hint).toHaveTextContent('正在压缩会话历史…');
  });

  it('pending 卡片含说明副行与耗时计时器（fake timers 推进后递增）', () => {
    vi.useFakeTimers();
    try {
      sessionState.commandPendingBySession = new Map([['sess-1', 'compact']]);
      render(<MentionInput />);
      const hint = screen.getByTestId('command-pending-hint');
      // 副行：耗时预期 + 发送暂停说明（用户曾反馈 pending 不易察觉——明细度回归锁）
      expect(hint).toHaveTextContent('通常需要数秒到几十秒');
      expect(hint).toHaveTextContent('期间发送已暂停');
      expect(hint).toHaveTextContent('已进行 0s');
      act(() => {
        vi.advanceTimersByTime(2300);
      });
      expect(hint).toHaveTextContent('已进行 2s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('其他会话 pending 不影响当前会话（按会话键控隔离）', () => {
    sessionState.commandPendingBySession = new Map([['sess-other', 'compact']]);
    render(<MentionInput />);
    expect(screen.queryByTestId('command-pending-hint')).toBeNull();
  });

  it('pending 时 Enter 不触发 sendMessage（禁发——防压缩中并发开新回合）', () => {
    sessionState.commandPendingBySession = new Map([['sess-1', 'compact']]);
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '压缩中补充一句');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(sessionState.sendMessage).not.toHaveBeenCalled();
  });

  it('pending 结束（Map 清空）后 Enter 恢复发送', async () => {
    const { rerender } = render(<MentionInput />);
    sessionState.commandPendingBySession = new Map([['sess-1', 'compact']]);
    rerender(<MentionInput />);
    const el = editor();
    typeInEditor(el, 'hello');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(sessionState.sendMessage).not.toHaveBeenCalled();
    // 压缩完成：pending 清除 → 重渲染后 Enter 恢复发送
    sessionState.commandPendingBySession = new Map();
    rerender(<MentionInput />);
    typeInEditor(el, 'hello');
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(sessionState.sendMessage).toHaveBeenCalled());
  });
});

describe('MentionInput / 菜单技能组 — 停用插件行过滤（矩阵 C4）', () => {
  it('pluginDisabled skill 不进 / 菜单；list 调用带 workspaceId', async () => {
    mockApi.resource.list.mockClear();
    mockApi.resource.list.mockResolvedValue([
      makeSkillResource({ slug: 'code-review-workflow', name: '代码审查工作流' }),
      makeSkillResource({ slug: 'cg-usage', name: 'cg-usage', source: 'plugin', pluginDisabled: true } as Partial<ResourceItem> & { slug: string }),
    ]);
    render(<MentionInput />);
    typeInEditor(editor(), '/');
    // 可用技能在（异步拉取——waitFor）；停用插件的 skill 不进菜单
    await waitFor(() => expect(screen.getByText('代码审查工作流')).toBeTruthy());
    expect(screen.queryByText('cg-usage')).toBeNull();
    // ws 上下文透传（ws-1 = mock store 默认）
    expect(mockApi.resource.list).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'skill', workspaceId: 'ws-1' }),
    );
  });
});

// === 文件目录钻入（2026-11-11 B 方案）：目录行可见 + 选中即展开其内容 ===
// 背景：主进程改路径匹配后目录本可命中，但旧 renderer 把目录条目过滤掉，
// 用户输入目录名（如 shell）看到空列表。钻入 = 把查询改写为 `dir/` 就地
// 展开，菜单保持打开，继续输入收窄到文件。
describe('MentionInput 文件目录钻入', () => {
  /** 首屏只给目录命中，查询含前缀后给子项——仿真主进程路径匹配的两级结果 */
  function mockDirThenChild(): void {
    mockApi.file.searchNames.mockImplementation((_ws: string, q: string) =>
      Promise.resolve(
        q === 'src/'
          ? { hits: [{ path: 'src/a.ts', isDirectory: false }], truncated: false }
          : {
              hits: [
                { path: 'src', isDirectory: true },
                { path: 'src/a.ts', isDirectory: false },
              ],
              truncated: false,
            },
      ),
    );
  }

  it('手动 @：点击目录行 → 编辑器文本改写为 @dir/、按前缀重搜、菜单保持打开', async () => {
    mockDirThenChild();
    render(<MentionInput />);
    const el = editor();
    typeInEditor(el, '@src');
    fireEvent.click(await screen.findByText('src'));

    await waitFor(() => expect(visibleText(el)).toBe('@src/'));
    await waitFor(() => expect(mockApi.file.searchNames).toHaveBeenCalledWith('ws-1', 'src/'));
    await waitFor(() => expect(screen.getByText('src/a.ts')).toBeInTheDocument());

    // 继续点文件 → 正常插 file pill（钻入不改选择语义）
    fireEvent.click(screen.getByText('src/a.ts'));
    expect(hasPill(el, 'file', 'src/a.ts')).toBe(true);
  });

  it('按钮文件弹层：点击目录行 → 菜单内搜索词变 dir/、子项可见、不插 pill', async () => {
    mockDirThenChild();
    sessionState.mentionTrigger = { kind: 'file', tick: 1 };
    sessionState.mentionScope = 'file';
    const { rerender } = render(<MentionInput />);
    rerender(<MentionInput />);

    const input = (await screen.findByTestId('scope-search')) as HTMLInputElement;
    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument());
    fireEvent.click(screen.getByText('src'));

    expect(input.value).toBe('src/');
    await waitFor(() => expect(mockApi.file.searchNames).toHaveBeenCalledWith('ws-1', 'src/'));
    await waitFor(() => expect(screen.getByText('src/a.ts')).toBeInTheDocument());
    expect(hasPill(editor(), 'file', 'src/a.ts')).toBe(false);
  });

  it('目录条目带 Folder 图标（与文件/图片图标分流）', async () => {
    mockDirThenChild();
    render(<MentionInput />);
    typeInEditor(editor(), '@src');
    const dirBtn = (await screen.findByText('src')).closest('button') as HTMLElement;
    expect(dirBtn.querySelector('svg.lucide-folder')).not.toBeNull();
  });
});
