// electron/tests/integration/task-reply-return-chain.test.ts
//
// Task 13 A 线：task_reply 回传全链路集成测试（主子调度生产可用性的关键回归）。
//
// 覆盖完整链路（全部真实组件，仅 mock LLM / 子进程壳 / process.send）：
//   PM 侧                                        SUB 侧
//   ─────────────────────────────────────────────────────────────────
//   executeDispatch（真实）                        runTaskChatLoop（真实）
//     → sendDispatchEvent → process.send            → LLM mock 返回文本
//       → internal-event-bridge（真实）              → dispatchContext 设置
//         → RouterService.routeEvent（真实）           → sendTaskReplyEvent
//           → routeDispatch                           → process.send
//             → subRunner.executeTask（真实）            → bridge → routeTaskReply
//               → SUB mock child 收 task-config          → reply_to 精确路由
//                                                          → pmRunner.notifyTaskReply（真实）
//                                                          → PM mock child 收 task-reply
//                                                          → handleTaskReply（真实）
//                                                          → dispatch promise RESOLVE
//
// Task 13 之前链路在三处断裂（本测试的 RED 失败点）：
//   1. runTaskChatLoop 完成 dispatch 任务后不发 task_reply
//   2. AgentRunner.notifyTaskReply 按 active.taskId 匹配——PM 的活跃
//      ephemeral chat taskId=null，永不命中 → 回执静默丢弃
//   3. PM 侧 taskMessageListener 不处理 'task-reply' IPC
//
// 断言核心：PM 的 dispatch promise 在 sub 完成后及时 RESOLVE（而非 9 分钟
// 渐进式超时 reject），且回执携带正确的 task_id / body / status。

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { StreamDelta } from '../../src/main/agent/llm-provider';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';
import type { ChildProcess } from 'node:child_process';

// 必须在 import runtime-entry 之前 mock llm-provider（vi.mock 会被 hoist）
vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import {
  runTaskChatLoop,
  type RuntimeConfig,
  type RuntimeContext,
  type TaskConfig,
} from '../../src/main/agent/runtime-entry';
import { executeDispatch, handleTaskReply, handleTaskReplyIpc } from '../../src/main/agent/dispatch-wait';
import { AgentRunner } from '../../src/main/agent/agent-runner';
import { WarmPool } from '../../src/main/agent/warm-pool';
import { RouterService } from '../../src/main/agent/router-service';
import {
  setBridgeRouter,
  handleChildMessage,
} from '../../src/main/agent/internal-event-bridge';
import { INTERNAL_EVENT_MSG } from '../../src/main/agent/internal-event';
import { TASK_REPLY_EVENT_TYPE } from '../../src/main/agent/dispatch';
import { buildToolRegistry } from '../../src/main/agent/tools';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';

// === MemoryProvider stub（runChatLoop 拉 conversation/task 上下文用） ===

const stubMemoryProvider: MemoryProvider = {
  getTaskContext: async () => null,
  getConversationContext: async () => ({ messages: [] }),
  getAgentContext: async () => ({ preferences: [], learnedPatterns: [] }),
  getUserContext: async () => ({ preferences: [] }),
  getWorkspaceContext: async () => null,
};

// === 测试态 ===

/** process.send 捕获的内部事件（momo-internal-event 信封） */
const internalEvents: Array<{
  eventType: string;
  sessionId: string;
  sender: string;
  content: Record<string, unknown>;
}> = [];

/** mock 子进程壳：记录主进程发来的全部 IPC 消息 */
interface TestChild {
  child: ChildProcess;
  sent: Array<Record<string, unknown>>;
}

let dispatchResult: { body: string; toolCallsUsed: number } | null = null;
let dispatchError: Error | null = null;
/** 最近一次 dispatch 事件的 content（超时清理 pending 用） */
let lastDispatchContent: { task_id: string } | null = null;

const TEAM_SESSION = '!team:reply-chain';

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-pm',
    agentUserId: '@pm:localhost',
    teamSessionId: TEAM_SESSION,
    systemPrompt: 'You are the PM.',
    modelName: 'test-model',
    llmApiKey: 'test-key',
    workspaceDir: '/tmp/test',
    workspaceId: 'ws-1',
    role: 'main',
    subAgents: [{ slug: 'worker', assignmentId: 'inst-sub', description: '执行者' }],
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
    readFile: vi.fn().mockResolvedValue(Buffer.from('')),
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
    roomId: TEAM_SESSION,
    streamSessionId: 'test-session',
    sendStreamChunk: () => {},
    toolModules: buildToolRegistry({
      wsFs: mockWsFs,
      workspaceId: 'ws-1',
      workspaceDir: '/tmp/test',
      skillRegistry: mockSkillRegistry,
      streamSessionId: 'test-session',
      roomId: TEAM_SESSION,
      sendStreamChunk: () => {},
      permissionConfig: { allowedTools: [], deniedTools: [] },
    }),
    ...overrides,
  };
}

/** 构造 mock 子进程：send() 收到 task-config / task-reply 时执行测试编排逻辑 */
function mkPmChild(pmConfig: RuntimeConfig): TestChild {
  const sent: Array<Record<string, unknown>> = [];
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const child = {
    pid: 4201,
    on: vi.fn((event: string, h: (...args: unknown[]) => void) => {
      handlers[event] = h;
    }),
    off: vi.fn(),
    connected: true,
    kill: vi.fn(),
    send: vi.fn((msg: unknown): boolean => {
      sent.push(msg as Record<string, unknown>);
      const m = msg as { type?: string };
      if (m.type === 'task-config') {
        // 模拟 PM runtime：LLM 选中 dispatch:worker 工具 → 真实 executeDispatch
        void executeDispatch('worker', '写报告', pmConfig, 5, 'pm-stream-1')
          .then((r) => {
            dispatchResult = r;
          })
          .catch((e: unknown) => {
            dispatchError = e instanceof Error ? e : new Error(String(e));
          });
      } else if (m.type === 'task-reply') {
        // 模拟 PM runtime taskMessageListener 的 task-reply 分支：
        // camelCase 通知 → snake_case content → 真实 handleTaskReply
        const reply = (m as {
          reply: {
            taskId: string;
            status: string;
            body: string;
            toolCallsUsed?: number;
            progressPct?: number;
          };
        }).reply;
        handleTaskReply({
          task_id: reply.taskId,
          status: reply.status,
          body: reply.body,
          ...(reply.toolCallsUsed !== undefined ? { tool_calls_used: reply.toolCallsUsed } : {}),
          ...(reply.progressPct !== undefined ? { progress_pct: reply.progressPct } : {}),
        });
      }
      return true;
    }),
  } as unknown as ChildProcess;
  return { child, sent };
}

function mkSubChild(subConfig: RuntimeConfig, subCtx: RuntimeContext): TestChild {
  const sent: Array<Record<string, unknown>> = [];
  const child = {
    pid: 4202,
    on: vi.fn(),
    off: vi.fn(),
    connected: true,
    kill: vi.fn(),
    send: vi.fn((msg: unknown): boolean => {
      sent.push(msg as Record<string, unknown>);
      const m = msg as { type?: string };
      if (m.type === 'task-config') {
        // 模拟 SUB runtime：真实 runTaskChatLoop 跑 dispatch 任务
        void runTaskChatLoop(msg as TaskConfig, subConfig, subCtx);
      }
      return true;
    }),
  } as unknown as ChildProcess;
  return { child, sent };
}

describe('task_reply 回传全链路（PM dispatch → SUB 执行 → 回执 → PM resolve）', () => {
  let exitSpy: MockInstance<Parameters<typeof process.exit>, ReturnType<typeof process.exit>>;
  const originalSend = process.send;
  let pmChildRef: TestChild | null = null;

  beforeEach(() => {
    internalEvents.length = 0;
    dispatchResult = null;
    dispatchError = null;
    lastDispatchContent = null;
    pmChildRef = null;
    vi.mocked(createLLMProvider).mockReset();
    __setMemoryProviderForTest(stubMemoryProvider);

    // LLM mock：单轮纯文本回复（SUB 的最终答案）
    vi.mocked(createLLMProvider).mockReturnValue({
      chat: vi.fn(),
      chatStream: vi.fn(async function* (): AsyncGenerator<StreamDelta> {
        yield { type: 'text', content: '报告完成' };
        yield { type: 'done', finishReason: 'stop' };
      }),
    });

    // process.send：内部事件经真实 bridge 路由；callback 形式兼容 sendTaskEndAndExit
    process.send = ((
      msg: unknown,
      callback?: (err: Error | null) => void,
    ): boolean => {
      const m = msg as { type?: string };
      if (m?.type === INTERNAL_EVENT_MSG) {
        internalEvents.push(msg as typeof internalEvents[number]);
        // 真实内部事件桥 → RouterService.routeEvent
        handleChildMessage(msg);
        const evt = msg as { eventType?: string; content?: { task_id?: string } };
        if (evt.eventType === 'io.momo-studio.dispatch' && evt.content?.task_id) {
          lastDispatchContent = { task_id: evt.content.task_id };
        }
      }
      if (callback) callback(null);
      return true;
    }) as NonNullable<typeof process.send>;

    // mock process.exit：runTaskChatLoop 完成后会 exit(0)，不能真正退出测试进程
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    process.send = originalSend;
    __resetMemoryProviderForTest();
    exitSpy.mockRestore();
    setBridgeRouter(null);
    // 兜底清理 pending dispatch（RED 阶段 promise 未 resolve 时防止 3 分钟计时器悬挂）
    if (lastDispatchContent) {
      handleTaskReply({
        task_id: lastDispatchContent.task_id,
        status: 'failed',
        body: '测试清理',
      });
    }
  });

  it('sub 完成 → task_reply 经 RouterService 精确路由 → PM dispatch promise 及时 resolve', async () => {
    // ── 组装：真实 RouterService + 真实 AgentRunner × 2（PM + SUB） ──
    const pmConfig = makeConfig();
    const subConfig = makeConfig({
      agentAssignmentId: 'inst-sub',
      agentUserId: '@sub:localhost',
      role: 'sub',
      subAgents: [],
    });

    const pmChild = mkPmChild(pmConfig);
    const subChild = mkSubChild(subConfig, makeContext({ roomId: TEAM_SESSION }));
    pmChildRef = pmChild;

    const pmRunner = new AgentRunner({
      agentAssignmentId: 'inst-pm',
      agentUserId: '@pm:localhost',
      workspaceId: 'ws-1',
      warmPool: new WarmPool({ spawn: vi.fn().mockResolvedValue(pmChild.child) }),
    });
    const subRunner = new AgentRunner({
      agentAssignmentId: 'inst-sub',
      agentUserId: '@sub:localhost',
      workspaceId: 'ws-1',
      warmPool: new WarmPool({ spawn: vi.fn().mockResolvedValue(subChild.child) }),
    });

    const routerService = new RouterService({
      runners: new Map([
        ['inst-pm', pmRunner],
        ['inst-sub', subRunner],
      ]),
      dispatcher: { tryPickup: vi.fn() } as never,
    });
    setBridgeRouter(routerService);

    // ── 触发：用户消息 → PM 开跑 ephemeral chat（真实 executeTask） ──
    await pmRunner.executeTask({
      taskId: null,
      executionSessionId: TEAM_SESSION,
      body: '帮我写报告',
      streamSessionId: 'pm-stream-1',
    });

    // ── 断言 1：SUB 发出了 task_reply 内部事件（RED：永不出现 → 超时失败） ──
    await vi.waitFor(
      () => {
        expect(
          internalEvents.some((e) => e.eventType === TASK_REPLY_EVENT_TYPE),
        ).toBe(true);
      },
      { timeout: 2000 },
    );

    const replyEvt = internalEvents.find(
      (e) => e.eventType === TASK_REPLY_EVENT_TYPE,
    )!;
    expect(replyEvt.content.task_id).toBe(lastDispatchContent?.task_id);
    expect(replyEvt.content.status).toBe('completed');
    expect(replyEvt.content.body).toBe('报告完成');
    expect(replyEvt.content.reply_to).toBe('inst-pm');

    // ── 断言 2：PM 子进程收到了 task-reply IPC（notifyTaskReply 转发） ──
    await vi.waitFor(
      () => {
        expect(
          pmChild.sent.some((m) => m.type === 'task-reply'),
        ).toBe(true);
      },
      { timeout: 2000 },
    );

    // ── 断言 3：PM 的 dispatch promise 及时 resolve（核心——不是 9 分钟超时） ──
    await vi.waitFor(
      () => {
        expect(dispatchResult).not.toBeNull();
      },
      { timeout: 2000 },
    );
    expect(dispatchError).toBeNull();
    expect(dispatchResult).toEqual({ body: '报告完成', toolCallsUsed: 0 });
  });
});
