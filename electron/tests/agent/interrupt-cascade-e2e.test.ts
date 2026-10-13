// electron/tests/agent/interrupt-cascade-e2e.test.ts
//
// T0 复现 harness（spec 2026-10-13 §7.4 / §11.3-11，P0-B 首任务）：
// spring-mcp 实测病理——PM 派发 researcher 后用户停止 PM（~16:27），researcher
// 子流继续运行 22 分钟至自然完成（16:48）。三假设裁决：
//
//   H1：routeAbortDispatch 广播的 subStreamSessionId 与子 runner activeTasks 键不匹配
//       （routeDispatch 侧 ID 回收再生成——P0-7 病理复发）
//   H2：abort 消息到达子进程，但 chat loop 仅取消当前 LLM fetch，工具循环不检查 abort
//   H3：该链为 dispatch_bg 派发（fire-and-forget，PM 中止根本不产生 abort_dispatch）
//
// 驱动方式（momo-test-rules 保真度——mock 只收窄到进程/LLM 边界）：
//   - PM 角色 = 本测试进程内真实 runChatLoop（dispatch-parallel.test.ts 模式）：
//     真实 executeDispatch / executeDispatchBg / waitForTaskReply（dispatch-wait 全真实）
//   - 真实内部事件桥：process.send → handleChildMessage → RouterService.routeEvent →
//     routeDispatch / routeAbortDispatch（真）→ AgentRunner（真）→ mock 子进程壳
//   - mock 子进程壳 capture-only：记录 task-config 与 {type:'abort'} 下发——abort 下发
//     仅在 runner.activeTasks 键命中时发生（abortStream 未命中 no-op），因此「壳收到
//     abort」⟺「H1 键匹配成立 + 广播到达」
//   - abort 触发 = process.listeners('message') 注入 {type:'abort', streamSessionId}
//     （与 dispatch-parallel.test.ts:446 / runtime-stream.test.ts 同款——生产中主进程
//     abortStreamBySessionId → runner.abortStream → child.send 即此消息；PM 侧
//     abortListener → AbortController.abort() 的真实运行时语义由本进程内真实
//     runChatLoop 的 abortListener 承担）
//
// 裁决结论（证据详见 docs/plans/2026-10-13-t0-findings.md）：
//   - H1 不成立（场景 1 绿：ID 链 PM 预生成 → dispatch 事件 → routeDispatch →
//     activeTasks 键 → abort 广播目标全对齐）
//   - H2 不成立（chat loop 三检查点 + LLM fetch 全程 signal 感知；
//     dispatch-parallel.test.ts「并发批次中断」既有锁 + 定向代码审查）
//   - H3 成立（生产 DB 实证 dispatch_bg:researcher + 场景 2 红点复现：PM abort 后
//     bg 链零 abort_dispatch、零广播、registry 恒 in_flight——22 分钟病理的实验室版）
//
// 场景 2 红点用 it.fails 标注：B3 修复分支（cancelByPmStream + abortTurn 级联）落地后
// 本用例转绿 → it.fails 报「expected to fail but passed」→ 届时改回 it 即转正回归锁。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChildProcess } from 'node:child_process';

// mock electron：stream-relay 的 BrowserWindow 推送在测试环境静默降级
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: vi.fn() } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

// 必须在 import runtime-entry 之前 mock（vi.mock 会被 hoist）——LLM 边界预置轮次
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
import {
  __resetBgStateForTest,
  handleTaskReply,
} from '../../src/main/agent/dispatch-wait';
import {
  dispatchRegistry,
  __resetDispatchRegistryForTest,
} from '../../src/main/agent/dispatch-registry';
import { RouterService } from '../../src/main/agent/router-service';
import { AgentRunner } from '../../src/main/agent/agent-runner';
import { WarmPool } from '../../src/main/agent/warm-pool';
import { setBridgeRouter, handleChildMessage } from '../../src/main/agent/internal-event-bridge';
import { INTERNAL_EVENT_MSG, type InternalEventMsg } from '../../src/main/agent/internal-event';
import { buildToolRegistry } from '../../src/main/agent/tools';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';

// === 公共 stub（与 dispatch-parallel.test.ts / orchestration-e2e.test.ts 同款） ===

const stubMemoryProvider: MemoryProvider = {
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

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-interrupt-cascade-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

/** process.send 捕获的全部 IPC 消息（chunk + 内部事件信封） */
const sentMsgs: unknown[] = [];

/** 内部事件信封（dispatch / abort_dispatch 等） */
function internalEvents(eventType?: string): InternalEventMsg[] {
  return sentMsgs.filter(
    (m): m is InternalEventMsg =>
      (m as { type?: string }).type === INTERNAL_EVENT_MSG &&
      (eventType === undefined || (m as { eventType?: string }).eventType === eventType),
  );
}

/** 子进程壳收到的 {type:'abort'} 下发（routeAbortDispatch 广播 / runner.abortStream 产物） */
interface AbortDelivery { streamSessionId?: string }
const subChildAborts: AbortDelivery[] = [];

/** 子进程壳捕获的 task-config（routeDispatch 实际 spawn 用的流 id 等观察点） */
interface CapturedTaskConfig {
  type?: string;
  taskId?: string | null;
  streamSessionId?: string;
  body?: string;
}
const capturedConfigs: CapturedTaskConfig[] = [];

let sessChatId = '';
const originalSend = process.send;
/** 本测试构造的 RouterService（afterEach stop——清扫计时器防迟触发重开 DB） */
let routerSvc: RouterService | null = null;

/** seed agent 定义 + workspace 成员行（sender 反查键 agent-<inst>） */
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

/**
 * mock 子进程壳（capture-only）。仿真运行中语义（connected / exitCode=null——
 * WarmPool isChildAlive 需要）；记录主进程下发：task-config 进 capturedConfigs、
 * {type:'abort'} 进 subChildAborts。不模拟任何 runtime 行为——子 agent 是否响应
 * abort 属 H2 域，由真实 runChatLoop 既有测试（dispatch-parallel「并发批次中断」）
 * + 代码审查裁决，不在本壳伪造。
 */
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

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-pm',
    agentUserId: 'agent-inst-pm',
    systemPrompt: 'x',
    modelName: 'm',
    llmApiKey: 'k',
    workspaceDir: '/tmp',
    workspaceId: 'ws',
    role: 'main',
    subAgents: [{ slug: 'researcher', assignmentId: 'inst-researcher', description: '研究员' }],
    skills: [],
    mcpNames: [],
    allowedTools: [],
    deniedTools: [],
    isLeader: true,
    devMode: false,
    maxToolCalls: 10,
    contextWindow: 0,
    outputTokens: 0,
    ...overrides,
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

/** mock chatStream——每次调用返回下一个预置 delta 序列 */
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

/** 等待子进程壳捕获第 n 个 task-config（桥→路由→executeTask 异步跳） */
async function waitForCapture(n: number): Promise<void> {
  await vi.waitFor(
    () => { expect(capturedConfigs.length).toBeGreaterThanOrEqual(n); },
    { timeout: 3000 },
  );
}

/**
 * 模拟主进程停止按钮的 IPC 下发（生产链：abortStreamBySessionId → runner.abortStream
 * → child.send；本进程即 PM 子进程——runtime-entry abortListener 真实实现匹配
 * streamSessionId 后 abortController.abort()）。
 */
function abortPmStream(streamSessionId: string): void {
  for (const listener of process.listeners('message')) {
    listener({ type: 'abort', streamSessionId }, undefined);
  }
}

/** 流式 chunk 过滤（排除内部事件信封等） */
function streamChunks(): StreamChunk[] {
  const types = new Set(['start', 'thinking', 'text', 'tool_call', 'tool_result', 'end']);
  return sentMsgs.filter((c) => {
    const t = (c as { type?: string }).type;
    return t !== undefined && types.has(t);
  }) as StreamChunk[];
}

/**
 * PM 本回合真实流 id：runChatLoop 未传 override 时自生成（abortListener 按它
 * 精确匹配），从 start chunk 读取（runtime-stream.test.ts abort 用例同款）。
 */
function pmStreamIdFromStartChunk(): string {
  const startChunk = streamChunks().find((c) => c.type === 'start') as { streamSessionId?: string };
  if (typeof startChunk?.streamSessionId !== 'string') {
    throw new Error('start chunk 未发出——PM chat loop 尚未启动');
  }
  return startChunk.streamSessionId;
}

beforeEach(() => {
  // ── DB：真实 SQLite + 会话边界数据域（inst-pm leader + inst-researcher 成员） ──
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`).run();
  for (const inst of ['inst-pm', 'inst-researcher']) seedAgentInstance(inst);
  const sess = insertSession({ workspaceId: 'ws', title: 'interrupt-cascade' });
  addSessionMember(sess.id, 'inst-pm', true);
  addSessionMember(sess.id, 'inst-researcher', false);
  sessChatId = sess.id;

  // ── 真实路由链：bridge → RouterService → AgentRunner → mock 子进程壳 ──
  __resetBgStateForTest();
  __resetDispatchRegistryForTest();
  __setMemoryProviderForTest(stubMemoryProvider);
  sentMsgs.length = 0;
  capturedConfigs.length = 0;
  subChildAborts.length = 0;
  vi.mocked(createLLMProvider).mockReset();
  const subRunner = new AgentRunner({
    agentAssignmentId: 'inst-researcher',
    agentUserId: 'agent-inst-researcher',
    workspaceId: 'ws',
    warmPool: new WarmPool({ spawn: vi.fn().mockResolvedValue(mkSubChild()) }),
  });
  routerSvc = new RouterService({ runners: new Map([['inst-researcher', subRunner]]) });
  setBridgeRouter(routerSvc);

  // ── process.send：全部 IPC 记录 + 内部事件转交真实桥（orchestration-e2e 模式） ──
  process.send = ((msg: unknown): boolean => {
    sentMsgs.push(msg);
    const m = msg as InternalEventMsg;
    if (m?.type === INTERNAL_EVENT_MSG) handleChildMessage(msg);
    return true;
  }) as NonNullable<typeof process.send>;
});

afterEach(() => {
  process.send = originalSend;
  setBridgeRouter(null);
  routerSvc?.stop();
  routerSvc = null;
  // 兜底清理在途 dispatch（失败注入幂等——已 settle 的走 miss 路径仅 warn）
  for (const cfg of capturedConfigs) {
    if (cfg.taskId) handleTaskReply({ task_id: cfg.taskId, status: 'failed', body: '测试清理' });
  }
  __resetBgStateForTest();
  __resetMemoryProviderForTest();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

// ══════════════════════════════════════════════════════════════════════════
// 场景 1（H1 裁决·预期绿）：同步 dispatch 链的中断级联——ID 全链对齐 + 广播到达
// ══════════════════════════════════════════════════════════════════════════

describe('T0 场景 1：同步 dispatch——中止 PM 后级联到达子 runner（H1 裁决）', () => {
  it('PM 流等待 dispatch 时被中止 → abort_dispatch 产生 + subStreamSessionId 与 activeTasks 键全链对齐 + 子壳 ≤2s 收到 abort + 链 cancelled', async () => {
    // PM 首轮：一个 dispatch:researcher（同步，永不回执——子壳不模拟回复）
    mockProviderMultiRound([
      [
        {
          type: 'tool_use',
          toolCall: { id: 'c-sync', name: 'dispatch:researcher', arguments: { task: '调研 X' } },
        },
        { type: 'done', finishReason: 'tool_use' },
      ],
    ]);
    const pmSsi = 'ss-pm-sync';
    const loopDone = runChatLoop(sessChatId, '去调研', makeConfig(), makeContext(pmSsi));

    // 等派发链闭合：dispatch 事件 → 真桥 → routeDispatch → 子 runner executeTask
    await waitForCapture(1);
    const subCfg = capturedConfigs[0]!;
    const chainId = subCfg.taskId;
    if (typeof chainId !== 'string') throw new Error('TaskConfig 缺 taskId——派发链未闭合');
    const dispatchEvt = internalEvents('io.momo-studio.dispatch')[0]!;
    const spawnedSubSsi = subCfg.streamSessionId;
    const realPmSsi = pmStreamIdFromStartChunk();

    // PM 阻塞在 dispatch 段（无回执）——此刻用户按下停止
    abortPmStream(realPmSsi);
    const result = await loopDone;

    // ── PM 侧收尾：中断退出（真实 chat loop abort 语义）──
    expect(result).toBe('(中断)');
    const endChunk = streamChunks().find((c) => c.type === 'end') as { finishReason: string };
    expect(endChunk.finishReason).toBe('interrupted');

    // ── H1 裁决点 1：ID 全链对齐（PM 预生成 → dispatch 事件 → routeDispatch
    //    spawn 用值 → 注册表 → abort_dispatch 广播目标，五点同值）──
    expect(dispatchEvt.content.sub_stream_session_id).toBe(spawnedSubSsi);
    expect(dispatchRegistry.get(chainId)?.subStreamSessionId).toBe(spawnedSubSsi);

    // ── 级联交付：abort_dispatch 事件产生且 ≤2s 广播到达子 runner ──
    //    （子壳收到 abort ⟺ activeTasks 键命中——abortStream 未命中时 no-op 不下发）
    const t0 = Date.now();
    await vi.waitFor(
      () => { expect(subChildAborts.some((a) => a.streamSessionId === spawnedSubSsi)).toBe(true); },
      { timeout: 2000 },
    );
    expect(Date.now() - t0).toBeLessThan(2000);

    // ── H1 裁决点 2：abort_dispatch 载荷与 spawn 用 ID 一致 ──
    const abortEvt = internalEvents('io.momo-studio.abort_dispatch')[0]!;
    expect(abortEvt.content.task_id).toBe(chainId);
    expect(abortEvt.content.sub_stream_session_id).toBe(spawnedSubSsi);

    // ── 链注册表：cancelled（迟到回执不唤醒 PM 的挡板）──
    expect(dispatchRegistry.get(chainId)?.status).toBe('cancelled');
  }, 10_000);
});

// ══════════════════════════════════════════════════════════════════════════
// 场景 2（H3 裁决·红点复现）：dispatch_bg 链——PM 中止后零级联
//（spring-mcp 病理实验室版：researcher 22 分钟无视中断）
// ══════════════════════════════════════════════════════════════════════════

describe('T0 场景 2：dispatch_bg——中止 PM 后子流无人中断（H3 裁决，spring-mcp 复现）', () => {
  it('机制记录（绿）：bg 链在 PM 中止后零 abort_dispatch / 零广播 / registry 恒 in_flight——与同批同步链形成对照', async () => {
    // PM 首轮：先派 bg（即时返回句柄），再同步 dispatch（阻塞等待）——PM 停止时
    // 两条链同时在途，恰为 spring-mcp 会话形态（bg 链 + PM 在另一任务中被停）
    mockProviderMultiRound([
      [
        {
          type: 'tool_use',
          toolCall: { id: 'c-bg', name: 'dispatch_bg:researcher', arguments: { task: '后台调研 Y' } },
        },
        {
          type: 'tool_use',
          toolCall: { id: 'c-sync', name: 'dispatch:researcher', arguments: { task: '前台调研 Z' } },
        },
        { type: 'done', finishReason: 'tool_use' },
      ],
    ]);
    const pmSsi = 'ss-pm-bg';
    const loopDone = runChatLoop(sessChatId, '双线调研', makeConfig(), makeContext(pmSsi));

    // bg 派发 + 同步派发均闭合（bg 即时完成派发；同步链阻塞 PM）
    await waitForCapture(2);
    const byBody = new Map(capturedConfigs.map((c) => [c.body, c]));
    const bgCfg = byBody.get('后台调研 Y')!;
    const syncCfg = byBody.get('前台调研 Z')!;
    const bgChain = bgCfg.taskId;
    const syncChain = syncCfg.taskId;
    if (typeof bgChain !== 'string' || typeof syncChain !== 'string') {
      throw new Error('TaskConfig 缺 taskId——派发链未闭合');
    }

    // PM 在同步 dispatch 等待中被用户停止
    abortPmStream(pmStreamIdFromStartChunk());
    await loopDone;

    // 同步链：级联到达（场景 1 已详证，此处对照存在性）
    expect(subChildAborts.some((a) => a.streamSessionId === syncCfg.streamSessionId)).toBe(true);

    // ── H3 裁决点：bg 链零级联（当前实现的机制事实——这就是 22 分钟病理）──
    expect(internalEvents('io.momo-studio.abort_dispatch').some(
      (e) => e.content.task_id === bgChain,
    )).toBe(false);
    // 等 500ms 确认非异步迟到（广播是同步链路，实际即时）
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(subChildAborts.some((a) => a.streamSessionId === bgCfg.streamSessionId)).toBe(false);
    // 链注册表恒 in_flight（未 cancel——唯一取消入口是 PM 主动 dispatch_cancel，
    // PM 进程已随中止退出，句柄随之蒸发——生产 DB 16:29:41 gather 报「句柄不存在」同源）
    expect(dispatchRegistry.get(bgChain)?.status).toBe('in_flight');
    expect(dispatchRegistry.get(syncChain)?.status).toBe('cancelled');
  }, 10_000);

  // T0 红点（it.fails：当前实现下必然红——B3 修复分支落地后转绿，届时报
  // 「expected to fail but passed」，改回 it 即转正回归锁）：
  // spec §11.3-11——中止 PM 后本回合派生的全部在途链（含 bg）≤2s aborted
  it.fails('T0 红点：中止 PM 流后 dispatch_bg 子 agent 流应 ≤2s aborted（spec §11.3-11）', async () => {
    mockProviderMultiRound([
      [
        {
          type: 'tool_use',
          toolCall: { id: 'c-bg', name: 'dispatch_bg:researcher', arguments: { task: '后台调研 W' } },
        },
        {
          type: 'tool_use',
          toolCall: { id: 'c-sync', name: 'dispatch:researcher', arguments: { task: '前台调研 V' } },
        },
        { type: 'done', finishReason: 'tool_use' },
      ],
    ]);
    const pmSsi = 'ss-pm-red';
    const loopDone = runChatLoop(sessChatId, '双线调研', makeConfig(), makeContext(pmSsi));

    await waitForCapture(2);
    const bgCfg = capturedConfigs.find((c) => c.body === '后台调研 W')!;
    if (typeof bgCfg.taskId !== 'string' || typeof bgCfg.streamSessionId !== 'string') {
      throw new Error('TaskConfig 缺字段——派发链未闭合');
    }

    abortPmStream(pmStreamIdFromStartChunk());
    await loopDone;

    // 子流 ≤2s 内被中止——观察点 = 子 runner 收到 abort 下发（activeTasks 键命中
    // 才会发生；真实子进程收到后 chat loop 中止已由 dispatch-parallel 既有锁证明）
    await vi.waitFor(
      () => { expect(subChildAborts.some((a) => a.streamSessionId === bgCfg.streamSessionId)).toBe(true); },
      { timeout: 2000 },
    );
    expect(dispatchRegistry.get(bgCfg.taskId)?.status).toBe('cancelled');
  }, 10_000);
});
