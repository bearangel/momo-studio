// electron/tests/agent/runtime-entry-turn-reconcile.test.ts
//
// 任务回合对账门禁回归锁（spec docs/specs/2026-09-28-task-turn-reconciliation.md，
// T-060 故障：委派回合正常结束但 todo pending 未清 + complete_task 0 次调用）。
// 契约：
//   1. F1 扩展触发：任务宿主回合（hostTaskId）&& 任务仍 in_progress &&
//      （user-source 未清项 或 本回合未调用 complete_task/fail_task）→ 终文前
//      注入一次性「[系统] 回合收尾核对」合成条（spec §3.1/§3.2 措辞）
//   2. 一次性门：同流第二次终文不重复注入（防循环，拒绝硬续跑）
//   3. 闭合言语行为追踪：complete_task/fail_task 且 taskId 指向宿主任务才算
//      闭合；指向他任务不算
//   4. sweep 门控（spec §3.4）：任务 open → completeInProgressTodos 跳过机械清；
//      任务 closed / 非任务回合照旧；强停路径不经钩子
//   5. 入场闭合契约（spec §3.3）：委派简报（buildKickoffBody 单点）含闭合义务段
//   6. 接线锁：routeUserChat 把 sourceTaskId 织入 TaskConfig.hostTaskId
//      （taskId 通道保持 null——agent-runner 的 task-driven 生命周期语义不可触发）
//
// mock 收窄（momo-test-rules）：只 mock LLM provider 与 tasks repo（DB 边界）；
// 工具链用真实 buildToolRegistry。transitionTaskStatus mock 仿真状态机语义
// （写入即时反映到 getTask 读值），防「mock 与生产语义漂移」。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LLMMessage, StreamDelta } from '../../src/main/agent/llm-provider';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';
import type { TodoItem } from '../../src/main/agent/tools/todo-types';
import type { TaskRow } from '../../src/main/storage/tasks/repo';

vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

vi.mock('../../src/main/storage/tasks/repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/storage/tasks/repo')>();
  return {
    ...actual,
    getTask: vi.fn(),
    transitionTaskStatus: vi.fn(),
    // complete_task 执行链的终态钩子（真实实现触调度器/executor，测试环境无运行时）
    spawnNextInstanceIfRecurring: vi.fn(),
    notifyExecutor: vi.fn(),
  };
});

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import {
  runChatLoop,
  buildTurnReconcileNotice,
  TURN_RECONCILE_NOTICE_PREFIX,
  type RuntimeContext,
} from '../../src/main/agent/runtime-entry';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';
import { buildToolRegistry } from '../../src/main/agent/tools';
import {
  __setTodosForTest,
  getTodosForSession,
} from '../../src/main/agent/tools/todo-tools';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';
import { getTask, transitionTaskStatus } from '../../src/main/storage/tasks/repo';
import {
  buildKickoffBody,
  KICKOFF_CLOSURE_MANDATE,
} from '../../src/main/task/executor';
import { RouterService } from '../../src/main/agent/router-service';
import type { AgentRunner, TaskConfig as AgentTaskConfig } from '../../src/main/agent/agent-runner';
import { __clearLaneForTest } from '../../src/main/agent/session-lane';

interface SentChunk {
  type: string;
  finishReason?: string;
  todos?: TodoItem[];
}

const SSI = 'turn-reconcile-ssi';
const ROOM = '!room:turn-reconcile';
const sentChunks: unknown[] = [];
/** 每次 chatStream 调用捕获的 messages（断言合成条注入形态） */
const capturedCalls: LLMMessage[][] = [];

/** 任务行状态仿真存储：transitionTaskStatus 写入 → getTask 读出（单一真相） */
const taskStatuses = new Map<string, TaskRow['status']>();

function mkTaskRow(id: string, status: TaskRow['status']): TaskRow {
  return {
    id,
    workspaceId: 'ws-1',
    title: '委派任务',
    description: '',
    status,
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'u-1',
    executionSessionId: ROOM,
    assigneeAgentId: null,
    targetTeamId: null,
    targetSessionId: ROOM,
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
    boardPosition: null,
    archivedAt: null,
  };
}

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-bot',
    agentUserId: '@bot:localhost',
    systemPrompt: 'You are a test bot.',
    modelName: 'test-model',
    llmApiKey: 'test-key',
    workspaceDir: '/tmp/test',
    workspaceId: 'ws-1',
    role: 'standalone',
    contextWindow: 0,
    outputTokens: 0,
    subAgents: [],
    skills: [],
    mcpNames: [],
    allowedTools: [],
    deniedTools: [],
    isLeader: false,
    devMode: false,
    maxToolCalls: 10,
    ...overrides,
  };
}

function makeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  const mockWsFs = {
    readFile: vi.fn().mockResolvedValue(Buffer.from('mock')),
    writeFile: vi.fn().mockResolvedValue(undefined),
    listDir: vi.fn().mockResolvedValue([]),
  } as unknown as WorkspaceFS;
  const mockSkillRegistry = {
    list: () => [],
    getIndex: () => '',
  } as unknown as RuntimeContext['skillRegistry'];
  return {
    wsFs: mockWsFs,
    skillRegistry: mockSkillRegistry,
    tools: [],
    systemPrompt: 'You are a helpful assistant.',
    workspaceId: 'ws-1',
    workspaceDir: '/tmp/test',
    creatorUserId: '@owner:test',
    roomId: ROOM,
    streamSessionId: SSI,
    sendStreamChunk: () => {},
    toolModules: buildToolRegistry({
      wsFs: mockWsFs,
      workspaceId: 'ws-1',
      workspaceDir: '/tmp/test',
      skillRegistry: mockSkillRegistry,
      streamSessionId: SSI,
      roomId: ROOM,
      sendStreamChunk: () => {},
      creatorUserId: '@owner:test',
      permissionConfig: { allowedTools: [], deniedTools: [] },
    }),
    ...overrides,
  };
}

const stubProvider: MemoryProvider = {
  getTaskContext: async () => null,
  getConversationContext: async () => ({ messages: [] }),
  getAgentContext: async () => ({ preferences: [], learnedPatterns: [] }),
  getUserContext: async () => ({ preferences: [] }),
  getWorkspaceContext: async () => null,
  getPinnedContext: async () => ({ hint: '', truncatedCount: 0, pinnedIds: [] }),
  searchMemories: async () => { throw new Error('测试 stub 不落库'); },
  saveMemory: async () => { throw new Error('测试 stub 不落库'); },
  deleteMemory: async () => { throw new Error('测试 stub 不落库'); },
};

/** 脚本化 provider：每次调用弹出下一个生成器；同时捕获当次 messages */
function scriptProvider(scripts: Array<() => AsyncGenerator<StreamDelta>>): ReturnType<typeof vi.fn> {
  let call = 0;
  return vi.fn(async function* (messages: LLMMessage[]): AsyncGenerator<StreamDelta> {
    capturedCalls.push(messages.map((m) => ({ ...m })));
    const gen = scripts[Math.min(call, scripts.length - 1)]!;
    call++;
    yield* gen();
  }) as never;
}

const finalText = (t: string) => async function* (): AsyncGenerator<StreamDelta> {
  yield { type: 'text', content: t };
  yield { type: 'done', finishReason: 'stop' };
};

const toolRound = (name: string, args: Record<string, unknown>) =>
  async function* (): AsyncGenerator<StreamDelta> {
    yield { type: 'tool_use', toolCall: { id: `tc-${name}`, name, arguments: args } };
    yield { type: 'done', finishReason: 'tool_use' };
  };

/** 全部合成条出现次数（跨全部 chatStream 调用） */
const countNotices = (prefix: string): number =>
  capturedCalls.filter((msgs) =>
    msgs.some((m) => m.role === 'user' && m.content.startsWith(prefix)),
  ).length;

beforeEach(() => {
  sentChunks.length = 0;
  capturedCalls.length = 0;
  taskStatuses.clear();
  vi.mocked(createLLMProvider).mockReset();
  __setMemoryProviderForTest(stubProvider);
  __clearLaneForTest();
  // 状态机语义仿真：getTask 读 Map；transitionTaskStatus 写 Map 并返回新行
  vi.mocked(getTask).mockReset().mockImplementation((id: string) =>
    taskStatuses.has(id) ? mkTaskRow(id, taskStatuses.get(id)!) : null,
  );
  vi.mocked(transitionTaskStatus)
    .mockReset()
    .mockImplementation((id: string, to: TaskRow['status']) => {
      if (!taskStatuses.has(id)) throw new Error(`task ${id} 不存在`);
      taskStatuses.set(id, to);
      return mkTaskRow(id, to);
    });
  process.send = ((msg: unknown): boolean => {
    sentChunks.push(msg);
    return true;
  }) as NonNullable<typeof process.send>;
});

afterEach(() => {
  __resetMemoryProviderForTest();
  __setTodosForTest(SSI, []);
});

describe('任务回合对账门禁（F1 扩展，spec §3.1）', () => {
  const originalSend = process.send;

  afterEach(() => {
    process.send = originalSend;
  });

  it('pending 未清 + 任务 open → 注入收尾核对合成条（含任务 id 与未清项状态）', async () => {
    taskStatuses.set('T-060', 'in_progress');
    __setTodosForTest(SSI, [
      { id: 't1', subject: '调研方案', status: 'completed', source: 'user' },
      { id: 't2', subject: '落地实现', status: 'pending', source: 'user' },
    ]);
    const chatStream = scriptProvider([finalText('第一段'), finalText('最终总结')]);
    vi.mocked(createLLMProvider).mockReturnValue({ chat: vi.fn(), chatStream } as never);

    await runChatLoop(
      ROOM,
      '【任务启动】#T-060 · 委派任务',
      makeConfig({ hostTaskId: 'T-060' }),
      makeContext(),
      undefined,
      undefined,
      undefined,
      SSI,
    );

    expect(chatStream).toHaveBeenCalledTimes(2);
    const notice = capturedCalls[1]!.find(
      (m) => m.role === 'user' && m.content.startsWith(TURN_RECONCILE_NOTICE_PREFIX),
    );
    expect(notice).toBeDefined();
    // spec §3.2 措辞要素：任务 id / 未清项 + 当前状态 / 双逃生门 / 防重复执行
    expect(notice!.content).toContain('任务 T-060 仍处于 in_progress');
    expect(notice!.content).toContain('落地实现（待处理）');
    expect(notice!.content).not.toContain('调研方案');
    expect(notice!.content).toContain('complete_task 关闭任务');
    expect(notice!.content).toContain('严禁重复执行已完成的事项');
    expect((sentChunks as SentChunk[]).find((c) => c.type === 'end')!.finishReason).toBe('stop');
  });

  it('任务已 closed → 不注入核对合成条', async () => {
    taskStatuses.set('T-060', 'completed');
    __setTodosForTest(SSI, [
      { id: 't2', subject: '落地实现', status: 'pending', source: 'user' },
    ]);
    const chatStream = scriptProvider([finalText('总结')]);
    vi.mocked(createLLMProvider).mockReturnValue({ chat: vi.fn(), chatStream } as never);

    await runChatLoop(ROOM, '测试', makeConfig({ hostTaskId: 'T-060' }), makeContext(), undefined, undefined, undefined, SSI);

    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(countNotices(TURN_RECONCILE_NOTICE_PREFIX)).toBe(0);
  });

  it('非任务回合（无 hostTaskId）→ 不注入核对合成条', async () => {
    __setTodosForTest(SSI, [
      { id: 't2', subject: '落地实现', status: 'pending', source: 'user' },
    ]);
    const chatStream = scriptProvider([finalText('总结')]);
    vi.mocked(createLLMProvider).mockReturnValue({ chat: vi.fn(), chatStream } as never);

    await runChatLoop(ROOM, '测试', makeConfig(), makeContext(), undefined, undefined, undefined, SSI);

    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(countNotices(TURN_RECONCILE_NOTICE_PREFIX)).toBe(0);
  });

  it('一次性门：模型不修正也只注入一次（同流第二次终文不重复）', async () => {
    taskStatuses.set('T-060', 'in_progress');
    __setTodosForTest(SSI, [
      { id: 't2', subject: '落地实现', status: 'pending', source: 'user' },
    ]);
    const chatStream = scriptProvider([finalText('总结'), finalText('补充总结')]);
    vi.mocked(createLLMProvider).mockReturnValue({ chat: vi.fn(), chatStream } as never);

    await runChatLoop(ROOM, '测试', makeConfig({ hostTaskId: 'T-060' }), makeContext(), undefined, undefined, undefined, SSI);

    expect(chatStream).toHaveBeenCalledTimes(2);
    expect(countNotices(TURN_RECONCILE_NOTICE_PREFIX)).toBe(1);
  });

  it('闭合缺失单独触发：待办全 completed + 任务 open + 未调闭合工具 → 注入（占位列表）', async () => {
    taskStatuses.set('T-060', 'in_progress');
    __setTodosForTest(SSI, [
      { id: 't1', subject: '调研方案', status: 'completed', source: 'user' },
    ]);
    const chatStream = scriptProvider([finalText('总结'), finalText('补充总结')]);
    vi.mocked(createLLMProvider).mockReturnValue({ chat: vi.fn(), chatStream } as never);

    await runChatLoop(ROOM, '测试', makeConfig({ hostTaskId: 'T-060' }), makeContext(), undefined, undefined, undefined, SSI);

    expect(chatStream).toHaveBeenCalledTimes(2);
    const notice = capturedCalls[1]!.find(
      (m) => m.role === 'user' && m.content.startsWith(TURN_RECONCILE_NOTICE_PREFIX),
    );
    expect(notice).toBeDefined();
    expect(notice!.content).toContain('无未清待办');
  });

  it('调用过 complete_task（指向宿主任务）且待办全清 → 不注入，任务行终态生效', async () => {
    taskStatuses.set('T-060', 'in_progress');
    __setTodosForTest(SSI, [
      { id: 't1', subject: '调研方案', status: 'completed', source: 'user' },
    ]);
    const chatStream = scriptProvider([
      toolRound('complete_task', { taskId: 'T-060' }),
      finalText('任务完成总结'),
    ]);
    vi.mocked(createLLMProvider).mockReturnValue({ chat: vi.fn(), chatStream } as never);

    await runChatLoop(ROOM, '测试', makeConfig({ hostTaskId: 'T-060' }), makeContext(), undefined, undefined, undefined, SSI);

    expect(chatStream).toHaveBeenCalledTimes(2);
    expect(countNotices(TURN_RECONCILE_NOTICE_PREFIX)).toBe(0);
    // 真实 TaskTools 执行链打通 mock 状态机：任务行已转终态
    expect(taskStatuses.get('T-060')).toBe('completed');
  });

  it('complete_task 指向他任务 → 闭合不算（宿主任务仍 open，继续注入）', async () => {
    taskStatuses.set('T-060', 'in_progress');
    taskStatuses.set('T-OTHER', 'in_progress');
    __setTodosForTest(SSI, [
      { id: 't2', subject: '落地实现', status: 'pending', source: 'user' },
    ]);
    const chatStream = scriptProvider([
      toolRound('complete_task', { taskId: 'T-OTHER' }),
      finalText('总结'),
      finalText('补充总结'),
    ]);
    vi.mocked(createLLMProvider).mockReturnValue({ chat: vi.fn(), chatStream } as never);

    await runChatLoop(ROOM, '测试', makeConfig({ hostTaskId: 'T-060' }), makeContext(), undefined, undefined, undefined, SSI);

    expect(chatStream).toHaveBeenCalledTimes(3);
    expect(countNotices(TURN_RECONCILE_NOTICE_PREFIX)).toBe(1);
    // 工具轮后第 1 次终文触发注入 → 合成条出现在第 3 次请求的 messages 里
    expect(noticeIn(capturedCalls[2]!, TURN_RECONCILE_NOTICE_PREFIX)).toContain('任务 T-060');
    expect(taskStatuses.get('T-060')).toBe('in_progress');
    expect(taskStatuses.get('T-OTHER')).toBe('completed');
  });
});

/** 在指定次调用的 messages 里找合成条（countNotices 的单次调用变体） */
function noticeIn(messages: LLMMessage[], prefix: string): string {
  const m = messages.find((x) => x.role === 'user' && x.content.startsWith(prefix));
  expect(m).toBeDefined();
  return m!.content;
}

describe('sweep 门控（spec §3.4）', () => {
  const originalSend = process.send;

  afterEach(() => {
    process.send = originalSend;
  });

  it('任务 open → in_progress 不被机械清（无 todo_update，保持原状）', async () => {
    taskStatuses.set('T-060', 'in_progress');
    __setTodosForTest(SSI, [
      { id: 't2', subject: '落地实现', status: 'in_progress', source: 'user' },
    ]);
    const chatStream = scriptProvider([finalText('总结'), finalText('补充总结')]);
    vi.mocked(createLLMProvider).mockReturnValue({ chat: vi.fn(), chatStream } as never);

    await runChatLoop(ROOM, '测试', makeConfig({ hostTaskId: 'T-060' }), makeContext(), undefined, undefined, undefined, SSI);

    // 门禁注入一次（未清项），模型不修正 → 终局 sweep 被门控跳过
    expect(countNotices(TURN_RECONCILE_NOTICE_PREFIX)).toBe(1);
    const all = sentChunks as SentChunk[];
    expect(all.filter((c) => c.type === 'todo_update')).toHaveLength(0);
    expect(getTodosForSession(SSI).find((t) => t.id === 't2')!.status).toBe('in_progress');
  });

  it('任务 closed → 照旧机械清 in_progress', async () => {
    taskStatuses.set('T-060', 'completed');
    // agent-source in_progress：两个门禁都不触发，直落 sweep（机械清不分 source）
    __setTodosForTest(SSI, [
      { id: 't3', subject: '扩展备忘', status: 'in_progress', source: 'agent' },
    ]);
    const chatStream = scriptProvider([finalText('总结')]);
    vi.mocked(createLLMProvider).mockReturnValue({ chat: vi.fn(), chatStream } as never);

    await runChatLoop(ROOM, '测试', makeConfig({ hostTaskId: 'T-060' }), makeContext(), undefined, undefined, undefined, SSI);

    expect(chatStream).toHaveBeenCalledTimes(1);
    const all = sentChunks as SentChunk[];
    expect(all.some((c) => c.type === 'todo_update')).toBe(true);
    expect(getTodosForSession(SSI)[0]!.status).toBe('completed');
  });

  it('强停路径（abort）不跑钩子照旧：无注入、无机械清、in_progress 保持原状', async () => {
    taskStatuses.set('T-060', 'in_progress');
    __setTodosForTest(SSI, [
      { id: 't2', subject: '落地实现', status: 'in_progress', source: 'user' },
    ]);
    const chatStream = vi.fn(async function* (): AsyncGenerator<StreamDelta> {
      capturedCalls.push([]);
      yield { type: 'text', content: '半截输出' };
      throw Object.assign(new Error('用户中止'), { name: 'AbortError' });
    });
    vi.mocked(createLLMProvider).mockReturnValue({ chat: vi.fn(), chatStream: chatStream as never } as never);

    await runChatLoop(ROOM, '测试', makeConfig({ hostTaskId: 'T-060' }), makeContext(), undefined, undefined, undefined, SSI);

    const all = sentChunks as SentChunk[];
    expect(all.find((c) => c.type === 'end')!.finishReason).toBe('interrupted');
    expect(capturedCalls.filter((msgs) =>
      msgs.some((m) => m.role === 'user' && m.content.startsWith(TURN_RECONCILE_NOTICE_PREFIX)),
    )).toHaveLength(0);
    expect(all.filter((c) => c.type === 'todo_update')).toHaveLength(0);
    expect(getTodosForSession(SSI)[0]!.status).toBe('in_progress');
  });
});

describe('入场闭合契约（spec §3.3）', () => {
  it('委派简报含闭合义务段（buildKickoffBody 单点，措辞齐备）', () => {
    const body = buildKickoffBody(mkTaskRow('T-060', 'in_progress'));
    expect(body).toContain('【任务启动】#T-060');
    expect(body).toContain(KICKOFF_CLOSURE_MANDATE);
    // 义务段三要素：触发声明 / 两条闭合通道 / 兜底说明
    expect(KICKOFF_CLOSURE_MANDATE).toContain('本回合由任务简报触发');
    expect(KICKOFF_CLOSURE_MANDATE).toContain('complete_task');
    expect(KICKOFF_CLOSURE_MANDATE).toContain('fail_task');
    expect(KICKOFF_CLOSURE_MANDATE).toContain('关闭任务');
    expect(KICKOFF_CLOSURE_MANDATE).toContain('说明原因');
  });

  it('模板全文与 spec §3.2 措辞一致（双逃生门 + 一次性声明 + 前缀登记形态）', () => {
    const text = buildTurnReconcileNotice('T-001', [
      { subject: '甲项', status: 'in_progress' },
      { subject: '乙项', status: 'pending' },
    ]);
    expect(text.startsWith('[系统] 回合收尾核对（非新任务请求）：任务 T-001 仍处于 in_progress，待办存在未清项：')).toBe(true);
    expect(text).toContain('甲项（进行中）');
    expect(text).toContain('乙项（待处理）');
    expect(text).toContain('(a) 完成剩余项，调用 todowrite 如实更新，并调用 complete_task 关闭任务；');
    expect(text).toContain('任务保持 in_progress 留待用户处理。');
    expect(text.endsWith('严禁重复执行已完成的事项。本提醒一次性，不会再触发。')).toBe(true);
  });
});

describe('routeUserChat hostTaskId 接线锁（spec §6 前置小改）', () => {
  it('kickoff（sourceTaskId 非空）→ TaskConfig.hostTaskId 透传且 taskId 保持 null', async () => {
    const executeTask = vi.fn(async (_task: AgentTaskConfig): Promise<{ streamSessionId: string }> => ({
      streamSessionId: 'ssi-x',
    }));
    const router = new RouterService({
      runners: new Map([['asg-1', { executeTask } as unknown as AgentRunner]]),
    });

    await router.routeUserChat({
      sessionId: 'sess-1',
      assignmentId: 'asg-1',
      body: '【任务启动】#T-060 · 委派任务',
      systemKickoff: true,
      sourceTaskId: 'T-060',
    });

    expect(executeTask).toHaveBeenCalledTimes(1);
    const cfg = executeTask.mock.calls[0]![0]!;
    expect(cfg.hostTaskId).toBe('T-060');
    // taskId 通道必须保持 null——非空会触发 agent-runner task-driven 生命周期
    //（task-end 终态自动转换），kickoff 流刻意 ephemeral
    expect(cfg.taskId).toBeNull();
  });

  it('手输消息（sourceTaskId null）→ hostTaskId 不附带（行为不变）', async () => {
    const executeTask = vi.fn(async (_task: AgentTaskConfig): Promise<{ streamSessionId: string }> => ({
      streamSessionId: 'ssi-x',
    }));
    const router = new RouterService({
      runners: new Map([['asg-1', { executeTask } as unknown as AgentRunner]]),
    });

    await router.routeUserChat({
      sessionId: 'sess-1',
      assignmentId: 'asg-1',
      body: '普通消息',
      sourceTaskId: null,
    });

    const cfg = executeTask.mock.calls[0]![0]!;
    expect(cfg.hostTaskId).toBeUndefined();
    expect(cfg.taskId).toBeNull();
  });
});
