// electron/tests/agent/subtask-stop-cancel-chain.test.ts
//
// D3 复现红测·段 1-4（验收报告 2026-10-31 T15：「停止 Smith 的子任务」点击无效）。
// 入口 = DispatchChip 停止按钮的真实 IPC 面：dispatch:cancelChain({subStreamSessionId})
// → RouterService.cancelChain → dispatchRegistry.cancel + broadcastAbortDispatch →
// runners Map → runner.abortStream → child.send({type:'abort'})。
//
// 段 5（子进程反应）由 subtask-stop-child-reaction.test.ts 独立锁绿——本文件用
// mock 子进程壳只验「下发到达」（interrupt-cascade-e2e 场景 1 锁的是 PM-abort
// 入口；本文件锁 cancelChain 入口——两个不同入口共享广播下游）。
//
// 驱动方式与 interrupt-cascade-e2e.test.ts 同款（真桥真路由真 PM chat loop，
// 仅子进程壳与 LLM 为 mock——momo-test-rules mock 收窄）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChildProcess } from 'node:child_process';

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: vi.fn() } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import { createLLMProvider } from '../../src/main/agent/llm-provider';
import { runChatLoop, type RuntimeContext } from '../../src/main/agent/runtime-entry';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';
import type { StreamDelta } from '../../src/main/agent/llm-provider';
import type { StreamChunk } from '../../src/main/agent/stream-chunk';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';
import { handleTaskReply, __resetBgStateForTest } from '../../src/main/agent/dispatch-wait';
import { getTask } from '../../src/main/storage/tasks/repo';
import { dispatchRegistry, __resetDispatchRegistryForTest } from '../../src/main/agent/dispatch-registry';
import { RouterService } from '../../src/main/agent/router-service';
import { AgentRunner } from '../../src/main/agent/agent-runner';
import { __clearLaneForTest } from '../../src/main/agent/session-lane';
import { setAbortResolver } from '../../src/main/agent/stream-relay';
import { WarmPool } from '../../src/main/agent/warm-pool';
import { setBridgeRouter, handleChildMessage } from '../../src/main/agent/internal-event-bridge';
import { INTERNAL_EVENT_MSG, type InternalEventMsg } from '../../src/main/agent/internal-event';
import { buildToolRegistry } from '../../src/main/agent/tools';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';

const stubMemoryProvider: MemoryProvider = {
  getTaskContext: async () => null,
  getConversationContext: async () => ({ messages: [] }),
  getAgentContext: async () => ({ preferences: [], learnedPatterns: [] }),
  getUserContext: async () => ({ preferences: [] }),
  getWorkspaceContext: async () => null,
  getPinnedContext: async () => ({ hint: '', truncatedCount: 0, pinnedIds: [] }),
  searchMemories: async () => {
    throw new Error('测试 stub 不落库');
  },
  saveMemory: async () => {
    throw new Error('测试 stub 不落库');
  },
  deleteMemory: async () => {
    throw new Error('测试 stub 不落库');
  },
};

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-subtask-cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

const sentMsgs: unknown[] = [];
interface AbortDelivery {
  streamSessionId?: string;
}
const subChildAborts: AbortDelivery[] = [];
interface CapturedTaskConfig {
  type?: string;
  taskId?: string | null;
  streamSessionId?: string;
}
const capturedConfigs: CapturedTaskConfig[] = [];

let sessChatId = '';
const originalSend = process.send;
let routerSvc: RouterService | null = null;
let subRunner: AgentRunner | null = null;

function seedAgentInstance(instanceId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
        default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
     VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', 'm', 1)`,
  ).run(instanceId, instanceId, instanceId);
  db.prepare(
    `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
     VALUES (?, 'ws', ?, ?)`,
  ).run(instanceId, instanceId, `agent-${instanceId}`);
}

/** mock 子进程壳（capture-only）——与 interrupt-cascade-e2e 同款 */
function mkSubChild(): ChildProcess {
  return {
    pid: 4302,
    on: vi.fn(),
    off: vi.fn(),
    connected: true,
    exitCode: null,
    kill: vi.fn(),
    send: vi.fn((msg: unknown): boolean => {
      const m = msg as { type?: string };
      if (m?.type === 'task-config') capturedConfigs.push(msg as CapturedTaskConfig);
      if (m?.type === 'abort') subChildAborts.push(msg as AbortDelivery);
      return true;
    }),
  } as unknown as ChildProcess;
}

function makeConfig(): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-pm',
    agentUserId: 'agent-inst-pm',
    systemPrompt: 'x',
    modelName: 'm',
    llmApiKey: 'k',
    workspaceDir: '/tmp',
    workspaceId: 'ws',
    role: 'main',
    subAgents: [{ slug: 'smith', assignmentId: 'inst-smith', description: '工程师' }],
    skills: [],
    mcpNames: [],
    allowedTools: [],
    deniedTools: [],
    isLeader: true,
    devMode: false,
    maxToolCalls: 10,
    contextWindow: 0,
    outputTokens: 0,
  };
}

function makeContext(streamSessionId: string): RuntimeContext {
  const mockWsFs = {
    readFile: vi.fn().mockResolvedValue(Buffer.from('mock file content')),
    writeFile: vi.fn().mockResolvedValue(undefined),
    listDir: vi.fn().mockResolvedValue([]),
    assertInWorkspace: (p: string) => path.resolve('/tmp', p),
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
    workspaceId: 'ws',
    workspaceDir: '/tmp',
    creatorUserId: '@owner:test',
    roomId: sessChatId,
    streamSessionId,
    sendStreamChunk: () => {},
    toolModules: buildToolRegistry({
      wsFs: mockWsFs,
      workspaceId: 'ws',
      workspaceDir: '/tmp',
      creatorUserId: '@owner:test',
      skillRegistry: mockSkillRegistry,
      streamSessionId,
      roomId: sessChatId,
      sendStreamChunk: () => {},
      permissionConfig: { allowedTools: [] as string[], deniedTools: [] as string[] },
    }),
  };
}

function mockProviderMultiRound(rounds: StreamDelta[][]): void {
  let callIndex = 0;
  vi.mocked(createLLMProvider).mockReturnValue({
    chat: vi.fn(),
    chatStream: vi.fn(async function* (): AsyncGenerator<StreamDelta> {
      const deltas = rounds[callIndex] ?? rounds[rounds.length - 1]!;
      callIndex++;
      for (const d of deltas) yield d;
    }),
  });
}

async function waitForCapture(n: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(capturedConfigs.length).toBeGreaterThanOrEqual(n);
    },
    { timeout: 3000 },
  );
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`,
  ).run();
  for (const inst of ['inst-pm', 'inst-smith']) seedAgentInstance(inst);
  const sess = insertSession({ workspaceId: 'ws', title: 'subtask-cancel' });
  addSessionMember(sess.id, 'inst-pm', true);
  addSessionMember(sess.id, 'inst-smith', false);
  sessChatId = sess.id;

  __resetBgStateForTest();
  __resetDispatchRegistryForTest();
  __clearLaneForTest();
  __setMemoryProviderForTest(stubMemoryProvider);
  sentMsgs.length = 0;
  capturedConfigs.length = 0;
  subChildAborts.length = 0;
  vi.mocked(createLLMProvider).mockReset();
  subRunner = new AgentRunner({
    agentAssignmentId: 'inst-smith',
    agentUserId: 'agent-inst-smith',
    workspaceId: 'ws',
    warmPool: new WarmPool({ spawn: vi.fn().mockResolvedValue(mkSubChild()) }),
  });
  routerSvc = new RouterService({ runners: new Map([['inst-smith', subRunner]]) });
  setBridgeRouter(routerSvc);

  process.send = ((msg: unknown): boolean => {
    sentMsgs.push(msg);
    const m = msg as InternalEventMsg;
    if (m?.type === INTERNAL_EVENT_MSG) handleChildMessage(msg);
    return true;
  }) as NonNullable<typeof process.send>;
});

afterEach(async () => {
  process.send = originalSend;
  setBridgeRouter(null);
  routerSvc?.stop();
  routerSvc = null;
  subRunner = null;
  setAbortResolver(null);
  __clearLaneForTest();
  for (const cfg of capturedConfigs) {
    if (cfg.taskId) handleTaskReply({ task_id: cfg.taskId, status: 'failed', body: '测试清理' });
  }
  __resetBgStateForTest();
  __resetMemoryProviderForTest();
  await new Promise((resolve) => setTimeout(resolve, 50));
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('D3 段 1-4：cancelChain 入口（DispatchChip 停止按钮的真实 IPC 面）', () => {
  it('同步 dispatch 在途 → cancelChain(subStreamSessionId) → 链 cancelled + 子壳秒级收到 abort（streamSessionId 精确匹配）', async () => {
    // PM 首轮派发 dispatch:smith（同步，永不回执——壳不模拟回复，链停在 in_flight）
    mockProviderMultiRound([
      [
        {
          type: 'tool_use',
          toolCall: { id: 'c-smith', name: 'dispatch:smith', arguments: { task: '写游戏' } },
        },
        { type: 'done', finishReason: 'tool_use' },
      ],
    ]);
    const pmSsi = 'ss-pm';
    const loopDone = runChatLoop(
      sessChatId,
      '去写游戏',
      makeConfig(),
      makeContext(pmSsi),
      undefined,
      undefined,
      undefined,
      pmSsi,
    );
    loopDone.catch(() => {}); // afterEach 注入清理回执收尾——本体断言不依赖 PM 落幕

    await waitForCapture(1);
    const subCfg = capturedConfigs[0]!;
    const chainId = subCfg.taskId;
    if (typeof chainId !== 'string') throw new Error('TaskConfig 缺 taskId——派发链未闭合');

    // 注册表先对齐（与 interrupt-cascade 场景 1 同款断言）
    expect(dispatchRegistry.get(chainId)?.subStreamSessionId).toBe(subCfg.streamSessionId);

    // ── 被测入口：renderer DispatchChip 的停止按钮 ──
    const r = routerSvc!.cancelChain({ subStreamSessionId: subCfg.streamSessionId });
    expect(r.status).toBe('cancelled');

    // 段 2-4：广播到达子 runner（≤2s）且 streamSessionId 精确
    await vi.waitFor(
      () => {
        expect(subChildAborts.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 2000 },
    );
    expect(subChildAborts[0]!.streamSessionId).toBe(subCfg.streamSessionId);
    // 链终态
    expect(dispatchRegistry.get(chainId)?.status).toBe('cancelled');

    // D4 账本投影（全链集成）：register 落行 + cancelChain 投影 cancelled
    const row = getTask(chainId);
    expect(row, 'dispatch 链应投影为 tasks 行').toBeDefined();
    expect(row!.origin).toBe('dispatch');
    expect(row!.status).toBe('cancelled');
    expect(row!.assigneeAgentId).toBe('inst-smith');
  });

  it('D4 settle 投影：task_reply completed → 行翻 completed（真实路由链）', async () => {
    mockProviderMultiRound([
      [
        {
          type: 'tool_use',
          toolCall: { id: 'c-smith-2', name: 'dispatch:smith', arguments: { task: '写逻辑' } },
        },
        { type: 'done', finishReason: 'tool_use' },
      ],
      [{ type: 'text', content: '完成' }, { type: 'done', finishReason: 'stop' }],
    ]);
    const loopDone = runChatLoop(
      sessChatId,
      '去写逻辑',
      makeConfig(),
      makeContext('ss-pm2'),
      undefined,
      undefined,
      undefined,
      'ss-pm2',
    );
    loopDone.catch(() => {});

    await waitForCapture(1);
    const subCfg = capturedConfigs[0]!;
    const chainId = subCfg.taskId;
    if (typeof chainId !== 'string') throw new Error('派发链未闭合');
    expect(getTask(chainId)?.status).toBe('in_progress');

    // 经真实路由入口触发 settle（dispatch-auto-delivery 同款 mkEvent 直连
    // routeEvent——sender=子 agent 的 agentUserId，resolveSender 反查匹配链目标）
    routerSvc!.routeEvent(
      {
        getType: () => 'io.momo-studio.task_reply',
        getContent: () => ({ task_id: chainId, status: 'completed', body: '子任务完成' }),
        getSender: () => 'agent-inst-smith',
        getRoomId: () => sessChatId,
      },
      'agent-inst-smith',
      null,
    );
    expect(getTask(chainId)?.status, 'settle 投影 → completed').toBe('completed');
  });
});
