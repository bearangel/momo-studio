// electron/tests/integration/orchestration-e2e.test.ts
//
// v2.8.0 Orchestration 元语 Task 8：集成与回归——证明前序 T1-T7 交付的
// 编排链路端到端可用（spec 2026-09-12 orchestration-primitives）。
//
// 三场景（brief Step 1，全部「真 DB + mock 子进程边界」——task-reply-
// return-chain.test.ts 模式：mock 只落在 mock 子进程壳与 process.send
// 进程边界，其余组件全真实）：
//
//   1. followup 端到端：
//      executeDispatch（真）→ sendDispatchEvent → process.send →
//      internal-event-bridge（真）→ RouterService.routeEvent（真）→
//      routeDispatch → AgentRunner.executeTask（真）→ mock 子进程壳捕获
//      task-config（子 agent 视角的 TaskConfig wire 形态）
//      → 手动 seed 子回复（__routeChunkToBufferForTest 生产落库链，模拟
//      子 agent 流式消息落库）→ handleTaskReply settle dispatch promise
//      → executeFollowup（真）→ 重建器读到链历史 → 第二次捕获的 TaskConfig
//      断言：historyPrefix 含首轮内容 + taskId 沿用 + body=question
//      → 第二轮回复落库 + settle → 再 followup → 重建器读到两轮完整链
//      （assistant → user → assistant）
//
//   2. bg 三连派 → handleTaskReply ×3 → gather all 全中：
//      executeDispatchBg ×3（真，各自经真派发链路由到子 agent）→
//      handleTaskReply ×3（真，翻转句柄 done）→ executeGather('all')（真）
//      三条 done 全中、pending 空
//
//   3. bg → gather(any, 短超时) 未完成 pending → reply 迟到 → 二次 gather
//      命中缓存：超时非错误（句柄保留），迟到 reply 翻转句柄后二次 gather
//      同步首扫立即收割缓存结果
//
//   4. forcedExit 补投幂等（spec 2026-10-13 §11.2-10 L2 场景）：
//      链 A 同步消费（executeDispatch resolve → 真 task_reply_ack 路径 →
//      registry.markConsumed）；链 B 后台终态（bg 派发 + 子终态直达桥 settle，
//      PM 已 idle 无消费零 ack）；随后 PM forcedExit（onPmIdle(id, true,
//      roundStartedAt)）。断言：链 A 零回执行零唤醒；链 B 恰一条
//      sender='system' 回执行 + 恰一次唤醒；重复 forcedExit 零增量。
//
// fixture 保真度（momo-test-rules 铁律 5「mock 收窄」）：
//   - 真实 SQLite（tmp + AP_USER_DATA_DIR + runMigrations + seed ws /
//     agent 链 / 会话成员——会话边界校验的真实数据域）
//   - 真实 internal-event-bridge + RouterService + AgentRunner + WarmPool
//     （spawn 注入 mock 子进程壳——捕获 task-config，模拟子进程边界）
//   - 真实 stream-relay 落库链（__routeChunkToBufferForTest /
//     __flushEventBufferForTest——子回复行与生产同路径写入，task_id 打标
//     经 T5 链路天然生效）
//   - 真实 executeDispatch / executeFollowup / executeDispatchBg /
//     executeGather / handleTaskReply（dispatch-wait 全真实实现）
//   - mock 仅两处：子进程壳（capture-only）+ process.send（记录并转交
//     真实桥——同 task-reply-return-chain.test.ts 的桥接模式）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChildProcess } from 'node:child_process';

// mock electron：stream-relay 的 BrowserWindow 推送在测试环境静默降级
//（同 dispatch-followup.test.ts 模式）
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: vi.fn() } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import { hasReceiptRow, listMessagesBySession } from '../../src/main/storage/messages/repo';
import {
  executeDispatch,
  executeFollowup,
  executeDispatchBg,
  executeGather,
  handleTaskReply,
  __resetBgStateForTest,
} from '../../src/main/agent/dispatch-wait';
import {
  dispatchRegistry,
  __resetDispatchRegistryForTest,
} from '../../src/main/agent/dispatch-registry';
import {
  TASK_REPLY_EVENT_TYPE,
  TASK_REPLY_ACK_EVENT_TYPE,
} from '../../src/main/agent/dispatch';
import {
  __routeChunkToBufferForTest,
  __resetEventBufferForTest,
  __flushEventBufferForTest,
} from '../../src/main/agent/stream-relay';
import { RouterService } from '../../src/main/agent/router-service';
import { AgentRunner } from '../../src/main/agent/agent-runner';
import { WarmPool } from '../../src/main/agent/warm-pool';
import { setBridgeRouter, handleChildMessage } from '../../src/main/agent/internal-event-bridge';
import { INTERNAL_EVENT_MSG, type InternalEventMsg } from '../../src/main/agent/internal-event';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';
import type { LLMMessage } from '../../src/main/agent/llm-provider';

// === 测试态 ===

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-orchestration-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

/** process.send 捕获的内部事件信封（dispatch / abort 等） */
const sentEvents: InternalEventMsg[] = [];

/** mock 子进程壳捕获的 task-config（子 agent 视角的 TaskConfig wire 形态） */
interface CapturedTaskConfig {
  type?: string;
  taskId?: string | null;
  executionSessionId?: string;
  body?: string;
  streamSessionId?: string;
  historyPrefix?: LLMMessage[];
  dispatchContext?: { task_id?: string; fromAssignmentId?: string };
}
const capturedConfigs: CapturedTaskConfig[] = [];

/** beforeEach seed 的会话 id（insertSession 自生成 uuid，测试体经此引用） */
let sessChatId = '';

const originalSend = process.send;

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
    subAgents: [{ slug: 'ui', assignmentId: 'inst-sub', description: 'UI' }],
    skills: [],
    mcpNames: [],
    allowedTools: [],
    deniedTools: [],
    isLeader: false,
    devMode: false,
    maxToolCalls: -1,
    contextWindow: 0,
    outputTokens: 0,
    ...overrides,
  };
}

/** seed agent 定义 + workspace 成员行（agent_user_id = `agent-<inst>`——followup 校验 c 的 sender 反查键） */
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
 * mock 子进程壳（capture-only）：记录主进程发来的全部 IPC 消息，task-config
 * 进 capturedConfigs。运行中语义（connected=true / exitCode=null——WarmPool
 * isChildAlive 健康检查需要）。不模拟任何 runtime 行为——子 agent 的流式
 * 消息由测试体经生产落库链手动 seed（见 seedSubRound）。
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
      if (m?.type === 'task-config') {
        capturedConfigs.push(msg as CapturedTaskConfig);
      }
      return true;
    }),
  } as unknown as ChildProcess;
}

/**
 * 经 stream-relay 生产落库链 seed 一轮子 agent 回复：start（taskId 打标 +
 * parent 指向 PM 流，形态同生产 runChatLoop 发出的 start chunk）→ text →
 * end → flush。行 sender = inst-sub 的 agentUserId，(task_id, session_id)
 * 双键打标——rebuildSubConversation 据此聚合。
 */
function seedSubRound(taskId: string, subStreamId: string, pmStreamId: string, text: string): void {
  __routeChunkToBufferForTest({
    type: 'start',
    streamSessionId: subStreamId,
    sessionId: sessChatId,
    senderAgentId: 'agent-inst-sub',
    parentStreamSessionId: pmStreamId,
    taskId,
  });
  __routeChunkToBufferForTest({ type: 'text', streamSessionId: subStreamId, delta: text });
  __routeChunkToBufferForTest({ type: 'end', streamSessionId: subStreamId, finishReason: 'stop' });
  __flushEventBufferForTest();
}

/** 等待 mock 子进程壳捕获到第 n 个 task-config（桥→路由→executeTask 是异步跳） */
async function waitForCapture(n: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(capturedConfigs.length).toBeGreaterThanOrEqual(n);
    },
    { timeout: 3000 },
  );
}

/**
 * v2.9 回执双路 settle（集成夹具的诚实双路径）：
 *   1. 直接 handleTaskReply——resolve 本进程内的 pendingReplies（executeDispatch
 *      的 promise 在测试进程里等价于「PM 子进程侧」状态）
 *   2. 经 mock process.send → 真桥 → routeTaskReply——settle 主进程
 *      DispatchRegistry（routeDispatch 对在途链的重复轮拒绝以此为准——
 *      不走此路则下一轮 followup 派发会被误拒）
 */
function settleBoth(taskId: string, body: string, toolCallsUsed: number): void {
  handleTaskReply({ task_id: taskId, status: 'completed', body, tool_calls_used: toolCallsUsed });
  process.send?.({
    type: INTERNAL_EVENT_MSG,
    eventType: 'io.momo-studio.task_reply',
    sessionId: sessChatId,
    sender: 'agent-inst-sub',
    content: { task_id: taskId, status: 'completed', body, tool_calls_used: toolCallsUsed, reply_to: 'inst-pm' },
  });
}

beforeEach(() => {
  // ── DB：真实 SQLite + 会话边界数据域（inst-pm leader + inst-sub 成员） ──
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`).run();
  for (const inst of ['inst-pm', 'inst-sub']) seedAgentInstance(inst);
  const sess = insertSession({ workspaceId: 'ws', title: 'orchestration-e2e' });
  addSessionMember(sess.id, 'inst-pm', true);
  addSessionMember(sess.id, 'inst-sub', false);
  sessChatId = sess.id;

  // ── 真实路由链：bridge → RouterService → AgentRunner → mock 子进程壳 ──
  __resetBgStateForTest();
  __resetEventBufferForTest();
  __resetDispatchRegistryForTest();
  sentEvents.length = 0;
  capturedConfigs.length = 0;
  const subRunner = new AgentRunner({
    agentAssignmentId: 'inst-sub',
    agentUserId: 'agent-inst-sub',
    workspaceId: 'ws',
    warmPool: new WarmPool({ spawn: vi.fn().mockResolvedValue(mkSubChild()) }),
  });
  setBridgeRouter(
    new RouterService({ runners: new Map([['inst-sub', subRunner]]) }),
  );

  // ── process.send：内部事件记录 + 转交真实桥（同 task-reply-return-chain 模式） ──
  // 哨兵置位：sendInternalEvent 仅在 MOMO_RUNTIME_CHILD=1 时发送（生产=spawner env；
  // 本测试经 stub 通道消费，迟到异步事件在哨兵恢复后自然哑火，不再污染池通道）
  process.env.MOMO_RUNTIME_CHILD = '1';
  process.send = ((msg: unknown): boolean => {
    const m = msg as InternalEventMsg;
    if (m?.type === INTERNAL_EVENT_MSG) {
      sentEvents.push(m);
      // 真实内部事件桥 → RouterService.routeEvent → routeDispatch → 子 runner
      handleChildMessage(msg);
    }
    return true;
  }) as NonNullable<typeof process.send>;
});

afterEach(() => {
  process.send = originalSend;
  delete process.env.MOMO_RUNTIME_CHILD;
  setBridgeRouter(null);
  // 兜底清理 pending dispatch（测试失败中途退出时防渐进超时计时器悬挂）：
  // 对本测试发出的全部 dispatch task_id 幂等注入 failed reply（已 settle 的
  // 走 miss 路径仅产生 warn，不影响结果）
  const dispatched = new Set(
    sentEvents
      .filter((e) => e.eventType === 'io.momo-studio.dispatch')
      .map((e) => String(e.content.task_id)),
  );
  for (const taskId of dispatched) {
    handleTaskReply({ task_id: taskId, status: 'failed', body: '测试清理' });
  }
  __resetBgStateForTest();
  __resetEventBufferForTest();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

// ══════════════════════════════════════════════════════════════════════════
// 场景 1：followup 端到端（dispatch → 回复落库 → settle → followup 续接）
// ══════════════════════════════════════════════════════════════════════════

describe('followup 端到端（dispatch 派发 → 回复落库 → followup 续接两轮）', () => {
  it('首轮 dispatch 经真路由链捕获 TaskConfig → seed 回复 → settle → followup：historyPrefix 含首轮 + taskId 沿用 + body=question；二轮后再 followup 重建器读到两轮', async () => {
    const cfg = makeConfig();

    // ── 首轮 dispatch：真 executeDispatch → 真桥 → 真路由 → 子 agent 收到任务 ──
    const p1 = executeDispatch('ui', '首轮任务', cfg, 1, 'ss-r1', 'ss-pm-r1', sessChatId);
    await waitForCapture(1);
    const cfg1 = capturedConfigs[0]!;
    // 首轮 TaskConfig：taskId 即链 ID（buildDispatchMessage 生成）+ dispatchContext
    // 双设 + 无前缀（普通 dispatch 不携带 historyPrefix——wire 级缺席）
    const CHAIN = cfg1.taskId;
    if (typeof CHAIN !== 'string') throw new Error('首轮 TaskConfig 缺 taskId——派发链未闭合');
    expect(cfg1.body).toBe('首轮任务');
    expect(cfg1.executionSessionId).toBe(sessChatId);
    expect(cfg1.streamSessionId).toBe('ss-r1');
    expect(cfg1.dispatchContext?.task_id).toBe(CHAIN);
    expect(cfg1.dispatchContext?.fromAssignmentId).toBe('inst-pm');
    expect('historyPrefix' in cfg1).toBe(false);

    // ── 手动 seed 子回复（模拟子 agent 流式消息经生产落库链写入 + task_id 打标） ──
    seedSubRound(CHAIN, 'ss-r1', 'ss-pm-r1', '首轮结论');

    // ── reply settle：双路（child 侧 promise resolve + 主进程 registry settle） ──
    settleBoth(CHAIN, '首轮结论', 1);
    await expect(p1).resolves.toEqual({ body: '首轮结论', toolCallsUsed: 1 });

    // ── followup：真 executeFollowup（v2.9 异步——立即返回确认）→ 重建器读链 →
    //    追问行落库 → 沿用链 ID 派发 ──
    const ack2 = executeFollowup(CHAIN, '把结论展开成表格', cfg, sessChatId, 'ss-pm-r2', 'ss-r2');
    expect(ack2).toContain('追问已送达');
    await waitForCapture(2);
    const cfg2 = capturedConfigs[1]!;
    // 核心断言（brief）：第二次捕获的 TaskConfig——
    //   historyPrefix 含首轮内容 + taskId 沿用 + body = question
    expect(cfg2.taskId).toBe(CHAIN);
    expect(cfg2.body).toBe('把结论展开成表格');
    expect(cfg2.historyPrefix).toEqual([{ role: 'assistant', content: '首轮结论' }]);
    // 子流为 followup 指定的新 subStreamSessionId（每轮新 chip 查找键）+ 链上下文
    expect(cfg2.streamSessionId).toBe('ss-r2');
    expect(cfg2.dispatchContext?.task_id).toBe(CHAIN);
    expect(cfg2.dispatchContext?.fromAssignmentId).toBe('inst-pm');

    // ── 二轮回复落库 + 双路 settle ──
    seedSubRound(CHAIN, 'ss-r2', 'ss-pm-r2', '二轮结论');
    settleBoth(CHAIN, '二轮结论', 2);

    // ── N-1 修复后语义：二轮是 followup 轮——executeFollowup 异步不注册
    //    pendingReplies、无 ack 消费路径（spec §6.1 ack 仅同步消费 / gather
    //    收割）→ settle 即恒投递（v2.9 语义），回执行落库进链历史。投递在
    //    异步 tryDeliver 循环——三轮 followup 前先等回执行可见，否则重建
    //    前缀存在缺回执行 user 轮的竞态 ──
    await vi.waitFor(() => {
      const receipts = listMessagesBySession(sessChatId).filter(
        (r) => r.taskId === CHAIN && r.sender === 'system' && r.parentStreamSessionId === null,
      );
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.body).toContain('二轮结论');
    });

    // ── 再 followup：重建器读到两轮完整链（assistant → user → assistant）+
    //    二轮回执行（sender=system 映射 user 轮——deliverChainResult 设计：
    //    回执行进链历史，后续 followup 重建天然聚合本轮结果） ──
    const ack3 = executeFollowup(CHAIN, '再问一句', cfg, sessChatId, 'ss-pm-r3', 'ss-r3');
    expect(ack3).toContain('追问已送达');
    await waitForCapture(3);
    const cfg3 = capturedConfigs[2]!;
    expect(cfg3.taskId).toBe(CHAIN);
    expect(cfg3.body).toBe('再问一句');
    // 消费/投递分水岭（A7 + N-1 修复后）：首轮同步内联消费——executeDispatch
    // resolve 经真 task_reply_ack 路径 markConsumed（delivered=true）→ 首轮
    // 零回执行；二轮 followup 轮无 ack 路径 → settle 恒投递 → 恰一条回执行。
    // （旧期望「零回执行注入」绿在 N-1 bug 上：hasReceiptRow 误命中追问行，
    // 二轮投递被整条吞掉——结果永不送达，与渐进超时文案承诺直接矛盾）
    expect(cfg3.historyPrefix).toEqual([
      { role: 'assistant', content: '首轮结论' },
      { role: 'user', content: '把结论展开成表格' },
      { role: 'assistant', content: '二轮结论' },
      // 回执行作为第 4 轮 user 输入（含结果全文 + followup 指引——模板含链
      // UUID，stringContaining 锁形态不锁随机值）
      { role: 'user', content: expect.stringContaining('【dispatch 回执自动送达】') },
    ]);
    // 链历史恰一条回执行且承载结果正文（上文 toEqual 已锁形状；此处显式锁
    // 回执行内容——与场景 4 的「后台无消费链恰一条」互为镜像）
    const prefixText = JSON.stringify(cfg3.historyPrefix);
    expect(prefixText).toContain('首轮结论');
    expect(prefixText).toContain('二轮结论');
    expect(prefixText).toContain('【dispatch 回执自动送达】');

    // 末轮收尾：清除追问在途标记（下一轮 followup 可用）
    handleTaskReply({ task_id: CHAIN, status: 'completed', body: '三轮结论', tool_calls_used: 0 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 场景 2：bg 三连派 → handleTaskReply ×3 → gather all 全中
// ══════════════════════════════════════════════════════════════════════════

describe('bg 三连派 → reply ×3 → gather all 全中', () => {
  it('三个 executeDispatchBg 各经真路由链派达子 agent → 三条 reply 翻转句柄 → gather all 一次收齐', async () => {
    const cfg = makeConfig();

    const b1 = await executeDispatchBg('ui', '后台任务一', cfg, 2, 'ss-bg-1', 'ss-pm-bg', sessChatId);
    const b2 = await executeDispatchBg('ui', '后台任务二', cfg, 2, 'ss-bg-2', 'ss-pm-bg', sessChatId);
    const b3 = await executeDispatchBg('ui', '后台任务三', cfg, 2, 'ss-bg-3', 'ss-pm-bg', sessChatId);
    // 三个句柄各自独立（taskId 即 dispatch 事件 task_id，不另造 ID 空间）
    expect(new Set([b1.taskId, b2.taskId, b3.taskId]).size).toBe(3);

    // 三条派发均经真桥→真路由到达子 agent（各自 body / subStream 对位）
    await waitForCapture(3);
    const byId = new Map(capturedConfigs.map((c) => [c.taskId ?? '', c]));
    expect(byId.get(b1.taskId)?.body).toBe('后台任务一');
    expect(byId.get(b1.taskId)?.streamSessionId).toBe('ss-bg-1');
    expect(byId.get(b2.taskId)?.body).toBe('后台任务二');
    expect(byId.get(b2.taskId)?.streamSessionId).toBe('ss-bg-2');
    expect(byId.get(b3.taskId)?.body).toBe('后台任务三');
    expect(byId.get(b3.taskId)?.streamSessionId).toBe('ss-bg-3');

    // 真 handleTaskReply ×3：pendingReplies miss → bg 句柄翻转 done + 结果缓存
    handleTaskReply({ task_id: b1.taskId, status: 'completed', body: '结果一', tool_calls_used: 1 });
    handleTaskReply({ task_id: b2.taskId, status: 'completed', body: '结果二', tool_calls_used: 2 });
    handleTaskReply({ task_id: b3.taskId, status: 'completed', body: '结果三', tool_calls_used: 3 });

    // 真 executeGather('all')：三条全中（同步首扫立即收割，无 pending 无 notes）
    const r = await executeGather([b1.taskId, b2.taskId, b3.taskId], 'all');
    expect(r.pending).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.done).toHaveLength(3);
    const doneById = new Map(r.done.map((d) => [d.taskId, d]));
    // F2：outcome 随收割条目透传（completed reply → outcome=completed）
    expect(doneById.get(b1.taskId)).toEqual({ taskId: b1.taskId, status: 'done', outcome: 'completed', body: '结果一', toolCallsUsed: 1 });
    expect(doneById.get(b2.taskId)).toEqual({ taskId: b2.taskId, status: 'done', outcome: 'completed', body: '结果二', toolCallsUsed: 2 });
    expect(doneById.get(b3.taskId)).toEqual({ taskId: b3.taskId, status: 'done', outcome: 'completed', body: '结果三', toolCallsUsed: 3 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 场景 3：bg → gather(any, 短超时) 未完成 pending → reply 迟到 → 二次 gather 命中缓存
// ══════════════════════════════════════════════════════════════════════════

describe('bg → gather(any, 短超时) pending → 迟到 reply → 二次 gather 命中缓存', () => {
  it('超时返回 pending 非错误（句柄保留）→ 迟到 reply 翻转 → 二次 gather 同步收割缓存结果', async () => {
    const cfg = makeConfig();

    const { taskId } = await executeDispatchBg('ui', '慢任务', cfg, undefined, 'ss-slow', 'ss-pm-slow', sessChatId);
    await waitForCapture(1);
    expect(capturedConfigs[0]?.taskId).toBe(taskId);
    expect(capturedConfigs[0]?.body).toBe('慢任务');

    // 短超时 gather(any)：钳制下限 1000ms——真实计时（集成测试不造假时钟）
    const r1 = await executeGather([taskId], 'any', 1000);
    expect(r1.done).toEqual([]);
    expect(r1.pending).toEqual([taskId]);
    expect(r1.notes).toEqual([]);

    // reply 迟到：真 handleTaskReply 翻转句柄 done + 缓存结果（无 gather waiter 挂起，直接翻转）
    handleTaskReply({ task_id: taskId, status: 'completed', body: '迟到结果', tool_calls_used: 2 });

    // 二次 gather：同步首扫命中缓存立即返回（不挂计时器）
    const r2 = await executeGather([taskId], 'any');
    expect(r2.done).toEqual([{ taskId, status: 'done', outcome: 'completed', body: '迟到结果', toolCallsUsed: 2 }]);
    expect(r2.pending).toEqual([]);
    expect(r2.notes).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 场景 4：forcedExit 补投幂等（spec 2026-10-13 §11.2-10）——同步消费链零重投，
// 后台终态链恰一次送达；重复 forcedExit 零增量
// ══════════════════════════════════════════════════════════════════════════

describe('forcedExit 补投幂等：同步消费链零重投零唤醒，后台终态链恰一次送达', () => {
  it('链 A 同步消费（真 ack 路径）→ forcedExit 后零回执行零唤醒；链 B 后台终态无消费 → 恰一条 system 回执行 + 恰一次唤醒；重复 forcedExit 无增量', async () => {
    const cfg = makeConfig();
    const roundStartedAt = Date.now();

    // 本场景私有路由服务：sub + PM 双真实 runner——PM runner 在位使投递循环
    // 完整走 routeUserChat(systemKickoff) → executeTask（唤醒即 PM 收到
    // kickoff task-config，与生产「唤醒 PM 新回合」同构）
    const pmKickoffs: CapturedTaskConfig[] = [];
    const mkPmChild = (): ChildProcess => ({
      pid: 4303,
      on: vi.fn(),
      off: vi.fn(),
      connected: true,
      exitCode: null,
      kill: vi.fn(),
      send: vi.fn((msg: unknown): boolean => {
        const m = msg as { type?: string };
        if (m?.type === 'task-config') pmKickoffs.push(msg as CapturedTaskConfig);
        return true;
      }),
    }) as unknown as ChildProcess;
    const subRunner = new AgentRunner({
      agentAssignmentId: 'inst-sub',
      agentUserId: 'agent-inst-sub',
      workspaceId: 'ws',
      warmPool: new WarmPool({ spawn: vi.fn().mockResolvedValue(mkSubChild()) }),
    });
    const pmRunner = new AgentRunner({
      agentAssignmentId: 'inst-pm',
      agentUserId: 'agent-inst-pm',
      workspaceId: 'ws',
      warmPool: new WarmPool({ spawn: vi.fn().mockResolvedValue(mkPmChild()) }),
    });
    const svc = new RouterService({ runners: new Map([['inst-sub', subRunner], ['inst-pm', pmRunner]]) });
    const wakeSpy = vi.spyOn(svc, 'routeUserChat');
    setBridgeRouter(svc);

    // ── 链 A：同步消费——executeDispatch → 子终态 → 双路 settle（resolve 分支
    //    自动经真 process.send → 桥 → applyRegistryAck → markConsumed）──
    const pA = executeDispatch('ui', '同步任务A', cfg, 1, 'ss-a', 'ss-pm-a', sessChatId);
    await waitForCapture(1);
    const chainA = capturedConfigs[0]!.taskId;
    if (typeof chainA !== 'string') throw new Error('链 A TaskConfig 缺 taskId——派发链未闭合');
    seedSubRound(chainA, 'ss-a', 'ss-pm-a', '同步结论A');
    settleBoth(chainA, '同步结论A', 1);
    await expect(pA).resolves.toEqual({ body: '同步结论A', toolCallsUsed: 1 });
    // ack 真路径落注册表：delivered=true（A7 判别点——无消费确认时恒 false）
    await vi.waitFor(() => expect(dispatchRegistry.get(chainA)?.delivered).toBe(true));
    expect(
      sentEvents.some(
        (e) => e.eventType === TASK_REPLY_ACK_EVENT_TYPE && e.content.task_id === chainA,
      ),
    ).toBe(true);

    // ── 链 B：后台派发 + 子终态直达桥（生产路径：子 runtime 子进程 →
    //    handleChildMessage → routeTaskReply settle）——PM 已 idle 不调
    //    handleTaskReply，bg 句柄无人收割 → 零 ack，链停在 done/未投递/未消费 ──
    const bg = await executeDispatchBg('ui', '后台任务B', cfg, undefined, 'ss-b', 'ss-pm-b', sessChatId);
    await waitForCapture(2);
    expect(capturedConfigs[1]?.taskId).toBe(bg.taskId);
    process.send?.({
      type: INTERNAL_EVENT_MSG,
      eventType: TASK_REPLY_EVENT_TYPE,
      sessionId: sessChatId,
      sender: 'agent-inst-sub',
      content: { task_id: bg.taskId, status: 'completed', body: '后台结论B', tool_calls_used: 2, reply_to: 'inst-pm' },
    });
    await vi.waitFor(() => expect(dispatchRegistry.get(bg.taskId)?.status).toBe('done'));
    expect(dispatchRegistry.get(bg.taskId)).toMatchObject({
      delivered: false,
      awaitWake: false,
      isFollowupRound: false,
    });
    expect(
      sentEvents.some(
        (e) => e.eventType === TASK_REPLY_ACK_EVENT_TYPE && e.content.task_id === bg.taskId,
      ),
    ).toBe(false);
    // settle 时刻零即时投递（bg 链非 followup 轮、未过 PM 空闲快照——不属恒投递类）
    expect(wakeSpy).toHaveBeenCalledTimes(0);
    expect(pmKickoffs).toHaveLength(0);

    // ── PM forcedExit（A8：roundStartedAt 窗口内 settle 的链补投）──
    svc.onPmIdle('inst-pm', true, roundStartedAt);

    // 链 B：恰一次唤醒（deliverChainResult → routeUserChat(systemKickoff)）
    await vi.waitFor(() => expect(wakeSpy).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(pmKickoffs).toHaveLength(1));
    expect(wakeSpy.mock.calls[0]![0]).toMatchObject({
      sessionId: sessChatId,
      assignmentId: 'inst-pm',
      systemKickoff: true,
    });
    expect(wakeSpy.mock.calls[0]![0].body).toContain(bg.taskId);
    expect(pmKickoffs[0]?.executionSessionId).toBe(sessChatId);
    expect(String(pmKickoffs[0]?.body)).toContain('后台结论B');

    // 链 B：恰一条 sender='system' 回执行（hasReceiptRow 生产查重口径 + 计数）
    expect(hasReceiptRow(sessChatId, bg.taskId)).toBe(true);
    const receiptRows = getDb()
      .prepare(
        `SELECT body FROM messages
         WHERE session_id = ? AND task_id = ? AND sender = 'system' AND segment_of IS NULL`,
      )
      .all(sessChatId, bg.taskId) as { body: string }[];
    expect(receiptRows).toHaveLength(1);
    expect(receiptRows[0]!.body).toContain('【dispatch 回执自动送达】');
    expect(receiptRows[0]!.body).toContain('后台结论B');

    // 链 A：零回执行零唤醒（全局唤醒恰 1 次且属链 B；无 A 的 system 行）
    expect(hasReceiptRow(sessChatId, chainA)).toBe(false);
    const totalSystemRows = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND sender = 'system'`)
      .get(sessChatId) as { n: number };
    expect(totalSystemRows.n).toBe(1);
    // 链 A 终态保持已消费：forcedExit 补投窗口未命中它（delivered 挡板）
    expect(dispatchRegistry.get(chainA)).toMatchObject({ status: 'done', delivered: true, awaitWake: false });

    // ── 重复 forcedExit：零增量（take 语义已标 delivered + PM 占线双层挡板）──
    svc.onPmIdle('inst-pm', true, roundStartedAt);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(wakeSpy).toHaveBeenCalledTimes(1);
    expect(pmKickoffs).toHaveLength(1);
    expect(
      getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM messages
           WHERE session_id = ? AND sender = 'system' AND segment_of IS NULL`,
        )
        .get(sessChatId) as { n: number },
    ).toEqual({ n: 1 });
  });
});
