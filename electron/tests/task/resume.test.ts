// electron/tests/task/resume.test.ts
//
// v2.6.0 任务断点续跑 Task 5 编排 + 接线锁。
//
// 编排锁（detectInterrupted / resumeTask）：
//   - fixture 经真实生产路径写库（routeChunkToBuffer 真实落库 + 真实
//     journal_entries 行 + workspace_agent_members JOIN agent_definitions）
//   - 断言：listInterrupted 命中 in_progress/assigned、字段齐（含 #roll 剥离、
//     agentName 解析、journalCount 准确）；resumeTask → 真实 AgentRunner.executeTask
//     派发 TaskConfig（含 resume 载荷 + streamSessionId 复用）→ 消息行翻回 streaming
//   - 状态机合法性：in_progress → cancelled 放弃链独立工作（不经 resumeTask）
//   - scheduler 边界回归锁：scheduler.checkOnce 对 in_progress/assigned 零触碰
//     （spec §5.4 + D6：恢复无缝；防未来改动与恢复链竞争）
//
// 接线锁（生产形态，spec §7「v2.5 C1 教训」）：
//   - 真实 AgentRunner.executeTask（真实 warmPool fake 化边界，照
//     runtime-registry.test.ts 模式）+ 真实 child.send 捕获
//   - 摘掉 agent-runner 的 `...(task.resume ? { resume: task.resume } : {})` 透传
//     → child.send payload 缺 resume → 锁必红（红绿变异记录）
//
// momo-test-rules 铁律 1+5：fixture 贴生产事件真实形状，禁止 mock store / mock
// rebuildTurn / mock executor——任何中间层简化都让锁失去杀伤力。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChildProcess } from 'node:child_process';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  __resetEventBufferForTest,
  __routeChunkToBufferForTest,
  __flushEventBufferForTest,
} from '../../src/main/agent/stream-relay';
import { AgentRunner } from '../../src/main/agent/agent-runner';
import { WarmPool } from '../../src/main/agent/warm-pool';
import {
  insertTask,
  transitionTaskStatus,
  getTask,
} from '../../src/main/storage/tasks/repo';
import type { TaskStatus } from '../../src/main/storage/tasks/repo';
import {
  insertMessage,
  getMessageByStreamSessionId,
  listMessagesByStreamSessionId,
  updateMessageStatus,
} from '../../src/main/storage/messages/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { listEventsByMessage } from '../../src/main/storage/messages/events-repo';
import { __clearRuntimeRegistryForTest } from '../../src/main/agent/runtime-registry';
import { __clearLaneForTest, getLane } from '../../src/main/agent/session-lane';
import { setJournalStore, getJournalStore } from '../../src/main/journal/recorder';
import { createJournalStore } from '../../src/main/journal/store';
import {
  detectInterrupted,
  resumeTask,
  sweepStaleStreaming,
  flipMessageBackToStreaming,
} from '../../src/main/task/resume';
import { type RebuiltTurn } from '../../src/main/agent/turn-reconstructor';
import { saveAgentDefinition } from '../../src/main/agent/crud';
import type { LLMMessage } from '../../src/main/agent/llm-provider';

// === 测试 DB 临时目录 ===

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-resume-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

function setupDb(): void {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
}

function teardownDb(): void {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
}

// === 最小真实 fixture（不触发 createWorkspace 的 git init / keytar 副作用）===

function insertWorkspace(id: string): void {
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
       VALUES (?, ?, ?, ?, 1, 'owner', '📁')`,
    )
    .run(id, `ws-${id}`, '', `/tmp/${id}`);
}

function insertAgentDef(id: string, name: string): void {
  saveAgentDefinition({
    id,
    name,
    slug: `slug-${id}`,
    version: '1',
    runtime: 'declarative',
    systemPrompt: '',
    defaultTools: [],
    defaultMcps: [],
    defaultSkills: [],
    source: 'builtin',
    description: '',
    iconEmoji: '🤖',
    workspaceId: null,
    modelProviderId: null,
    modelName: 'gpt-4o',
  });
}

function insertMember(
  instanceId: string,
  workspaceId: string,
  agentDefId: string,
  agentUserId: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO workspace_agent_members (
         instance_id, workspace_id, agent_definition_id, agent_user_id,
         api_key_override, last_running, created_at
       ) VALUES (?, ?, ?, ?, 0, 0, datetime('now'))`,
    )
    .run(instanceId, workspaceId, agentDefId, agentUserId);
}

// === 任务 / 流 fixture ===

function seedTask(opts: {
  id: string;
  status: TaskStatus;
  workspaceId: string;
  executionSessionId: string | null;
  assigneeAgentId?: string | null;
}): void {
  insertTask({
    id: opts.id,
    workspaceId: opts.workspaceId,
    title: `任务 ${opts.id}`,
    description: `描述 ${opts.id}`,
    creatorUserId: 'owner',
    status: opts.status,
    assigneeAgentId: opts.assigneeAgentId ?? null,
    executionSessionId: opts.executionSessionId,
  });
}

/**
 * 真实生产路径写入一个 agent 流（start + text_delta + tool_call_start/result），
 * 模拟 App 崩溃前已完成的事件。
 *
 * 同步插一条 owner 行的 user 消息（rebuildTurn 通过 created_at <= 流行时间窗
 * 找回回合起始 user 指令；不插则 messages[0] 缺失，rebuildTurn 重建段从
 * assistant 开始）。
 */
function seedAgentStream(opts: {
  streamSessionId: string;
  sessionId: string;
  senderAgentId: string;
  /** 仅透传进 start chunk；StreamChunk start 变体无 taskId 字段（运行时被忽略），可选 */
  taskId?: string;
  text: string[];
  withRoll?: boolean;
}): void {
  // 1) kickoff 注入的 owner 用户消息（与真实 sendUserMessage 同型：sender='owner'）
  insertMessage({
    sessionId: opts.sessionId,
    sender: 'owner',
    eventType: 'm.room.message',
    body: `原 user 指令 ${opts.streamSessionId}`,
    status: 'done',
  });
  __routeChunkToBufferForTest({
    type: 'start',
    streamSessionId: opts.streamSessionId,
    sessionId: opts.sessionId,
    senderAgentId: opts.senderAgentId,
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
  });
  for (const t of opts.text) {
    __routeChunkToBufferForTest({
      type: 'text',
      streamSessionId: opts.streamSessionId,
      delta: t,
    });
  }
  if (opts.withRoll) {
    // 模拟 message_roll 换行：后续 chunk 应落到 #roll1 后缀行
    __routeChunkToBufferForTest({
      type: 'message_roll',
      streamSessionId: opts.streamSessionId,
    });
    __routeChunkToBufferForTest({
      type: 'text',
      streamSessionId: opts.streamSessionId,
      delta: '滚后内容',
    });
  }
  __flushEventBufferForTest();
  // 模拟 App 崩溃后被 sweepStaleStreaming 收尾的形态：按 stream_session_id 查出
  // 该流全部真实 message 行（base + #roll 后缀行），逐行标 failed。
  // updateMessageStatus 首参是 message id——误传流 id 是静默 no-op（review
  // Finding 2），会让「翻回 streaming」的前置/后置断言空转
  for (const row of listMessagesByStreamSessionId(opts.streamSessionId)) {
    updateMessageStatus(row.id, 'failed');
  }
}

// === 测试 ===

describe('detectInterrupted（v2.6.0 启动恢复检测）', () => {
  beforeEach(() => {
    setupDb();
    __resetEventBufferForTest();
    setJournalStore(createJournalStore(getDb()));
    __clearLaneForTest();
    __clearRuntimeRegistryForTest();
    insertWorkspace('ws1');
    insertAgentDef('def1', 'Coder');
    insertMember('inst1', 'ws1', 'def1', 'agent-bot-1');
    insertAgentDef('def2', 'PM');
    insertMember('inst2', 'ws1', 'def2', 'agent-bot-2');
    insertSession({
      workspaceId: 'ws1',
      title: '任务 #T-1',
      kind: 'task_execution',
    });
    insertSession({
      workspaceId: 'ws1',
      title: '任务 #T-2',
      kind: 'task_execution',
    });
  });
  afterEach(() => {
    setJournalStore(null);
    __resetEventBufferForTest();
    __clearLaneForTest();
    __clearRuntimeRegistryForTest();
    teardownDb();
  });

  it('命中 in_progress 与 assigned；跳过 done / failed / draft / pending', () => {
    seedTask({ id: 'T-1', status: 'in_progress', workspaceId: 'ws1', executionSessionId: 'sess-task1', assigneeAgentId: 'inst1' });
    seedTask({ id: 'T-2', status: 'assigned', workspaceId: 'ws1', executionSessionId: null, assigneeAgentId: 'inst2' });
    seedTask({ id: 'T-3', status: 'completed', workspaceId: 'ws1', executionSessionId: 'sess-task1', assigneeAgentId: 'inst1' });
    seedTask({ id: 'T-4', status: 'failed', workspaceId: 'ws1', executionSessionId: 'sess-task1', assigneeAgentId: 'inst1' });
    seedTask({ id: 'T-5', status: 'draft', workspaceId: 'ws1', executionSessionId: null });
    seedTask({ id: 'T-6', status: 'pending', workspaceId: 'ws1', executionSessionId: null, assigneeAgentId: 'inst1' });

    const list = detectInterrupted();
    const ids = list.map((x) => x.taskId).sort();
    expect(ids).toEqual(['T-1', 'T-2']);
  });

  it('字段齐：taskId/title/status/agentName/journalCount/streamSessionId', () => {
    seedTask({ id: 'T-1', status: 'in_progress', workspaceId: 'ws1', executionSessionId: 'sess-task1', assigneeAgentId: 'inst1' });
    seedAgentStream({
      streamSessionId: 'ss-base-1',
      sessionId: 'sess-task1',
      senderAgentId: 'agent-bot-1',
      text: ['部分输出'],
    });

    // 写一条 journal 条目（变更账本——v2.5）
    const store = getJournalStore()!;
    store.insert({
      id: 'j-1',
      workspaceId: 'ws1',
      taskId: 'T-1',
      sessionId: 'sess-task1',
      streamSessionId: 'ss-base-1',
      toolName: 'write_file',
      path: '/workspace/foo.txt',
      op: 'create',
      beforeHash: null,
      afterHash: 'h-after',
      oldPath: null,
      createdAt: Date.now(),
    });

    const item = detectInterrupted()[0]!;
    expect(item).toBeDefined();
    expect(item.taskId).toBe('T-1');
    expect(item.title).toBe('任务 T-1');
    expect(item.status).toBe('in_progress');
    expect(item.agentName).toBe('Coder');
    expect(item.journalCount).toBe(1);
    expect(item.streamSessionId).toBe('ss-base-1');
  });

  it('#roll 后缀剥离：streamSessionId 返回 base id（不带 # 后缀）', () => {
    seedTask({ id: 'T-1', status: 'in_progress', workspaceId: 'ws1', executionSessionId: 'sess-task1', assigneeAgentId: 'inst1' });
    // 真实生产：start 写入 base 行 + 后续 message_roll 切到 #roll1 行
    // rebuildTurn 按 base 精确匹配；T1 报告 Concern #2 强调剥离
    seedAgentStream({
      streamSessionId: 'ss-base-roll',
      sessionId: 'sess-task1',
      senderAgentId: 'agent-bot-1',
      text: ['轮1'],
      withRoll: true,
    });
    // 验证消息表里 #roll1 行存在
    const rollRow = getMessageByStreamSessionId('ss-base-roll#roll1');
    expect(rollRow).not.toBeNull();

    const item = detectInterrupted()[0]!;
    expect(item.streamSessionId).toBe('ss-base-roll'); // 剥 #roll 后缀
  });

  it('agentName 解析：assigneeAgentId → workspace_agent_members.agent_definition_id → agent_definitions.name', () => {
    seedTask({ id: 'T-A', status: 'in_progress', workspaceId: 'ws1', executionSessionId: 'sess-task1', assigneeAgentId: 'inst2' });
    seedTask({ id: 'T-B', status: 'in_progress', workspaceId: 'ws1', executionSessionId: 'sess-task1', assigneeAgentId: 'inst1' });
    const list = detectInterrupted();
    const map = new Map(list.map((x) => [x.taskId, x.agentName]));
    expect(map.get('T-A')).toBe('PM');
    expect(map.get('T-B')).toBe('Coder');
  });

  it('assigned 任务 streamSessionId 为空（无断点流）', () => {
    seedTask({ id: 'T-2', status: 'assigned', workspaceId: 'ws1', executionSessionId: null, assigneeAgentId: 'inst1' });
    const item = detectInterrupted()[0]!;
    expect(item.streamSessionId).toBe('');
    expect(item.status).toBe('assigned');
  });

  it('session_queued 任务命中（executor 放行池语义——锁定既有行为）', () => {
    seedTask({ id: 'T-SQ', status: 'session_queued', workspaceId: 'ws1', executionSessionId: null, assigneeAgentId: 'inst1' });
    const item = detectInterrupted()[0]!;
    expect(item.taskId).toBe('T-SQ');
    expect(item.status).toBe('session_queued');
    expect(item.streamSessionId).toBe('');
  });

  it('journal store 未注入时 journalCount 降级为 0（不阻断检测）', () => {
    seedTask({ id: 'T-1', status: 'in_progress', workspaceId: 'ws1', executionSessionId: 'sess-task1', assigneeAgentId: 'inst1' });
    setJournalStore(null);
    const item = detectInterrupted()[0]!;
    expect(item.journalCount).toBe(0);
  });
});

describe('resumeTask（v2.6.0 断点续跑派发）', () => {
  beforeEach(() => {
    setupDb();
    __resetEventBufferForTest();
    setJournalStore(createJournalStore(getDb()));
    __clearLaneForTest();
    __clearRuntimeRegistryForTest();
    insertWorkspace('ws1');
    insertAgentDef('def1', 'Coder');
    insertMember('inst1', 'ws1', 'def1', 'agent-bot-1');
    insertSession({
      workspaceId: 'ws1',
      title: '任务 #T-1',
      kind: 'task_execution',
    });
  });
  afterEach(() => {
    setJournalStore(null);
    __resetEventBufferForTest();
    __clearLaneForTest();
    __clearRuntimeRegistryForTest();
    teardownDb();
  });

  it('in_progress 任务：派发 TaskConfig 含 resume 载荷 + streamSessionId 复用', async () => {
    seedTask({ id: 'T-1', status: 'in_progress', workspaceId: 'ws1', executionSessionId: 'sess-task1', assigneeAgentId: 'inst1' });
    seedAgentStream({
      streamSessionId: 'ss-base-r',
      sessionId: 'sess-task1',
      senderAgentId: 'agent-bot-1',
      text: ['完成一半'],
    });

    // 真实 AgentRunner + fake child（生产形态接线锁，Part A）
    const child = new EventEmitter() as ChildProcess;
    const sendSpy = vi.fn();
    (child as unknown as { send: typeof sendSpy }).send = sendSpy;
    (child as unknown as { kill: () => void }).kill = vi.fn();
    (child as unknown as { connected: boolean }).connected = true;
    (child as unknown as { exitCode: number | null }).exitCode = null;
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool,
    });
    // 直接注入到全局 agentRunners（resumeTask 用 agentRunners.get 查找）
    const { agentRunners } = await import('../../src/main/agent/runtime-registry');
    agentRunners.set('inst1', runner);

    // 真前置（Finding 2）：seed 修正后消息行确为 failed（sweep 收尾形态）——
    // 此前传流 id 的 no-op seeding 让「翻回」断言空转
    expect(getMessageByStreamSessionId('ss-base-r')!.status).toBe('failed');

    const result = await resumeTask('T-1');
    expect(result.streamSessionId).toBe('ss-base-r'); // 复用 base id（剥 # 后缀）

    // 接线锁（Part A）：child.send 真实收到 task-config + resume 载荷
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = sendSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.type).toBe('task-config');
    expect(sent.taskId).toBe('T-1');
    expect(sent.executionSessionId).toBe('sess-task1');
    expect(sent.streamSessionId).toBe('ss-base-r');
    expect(sent.resume).toBeDefined();
    const resume = sent.resume as { messages: unknown[]; toolCallsUsed: number; steers: string[] };
    expect(resume.messages.length).toBeGreaterThan(0);
    expect(Array.isArray(resume.messages)).toBe(true);
    expect(resume.toolCallsUsed).toBe(0);
    expect(resume.steers).toEqual([]);

    // 消息行翻回 streaming
    const msg = getMessageByStreamSessionId('ss-base-r')!;
    expect(msg.status).toBe('streaming');
  });

  it('双恢复守卫（Finding 4）：同流连续两次 resumeTask → 第二次拒绝，child 不收双 task-config', async () => {
    seedTask({ id: 'T-D1', status: 'in_progress', workspaceId: 'ws1', executionSessionId: 'sess-task1', assigneeAgentId: 'inst1' });
    seedAgentStream({
      streamSessionId: 'ss-dbl',
      sessionId: 'sess-task1',
      senderAgentId: 'agent-bot-1',
      taskId: 'T-D1',
      text: ['执行到一半'],
    });

    const child = new EventEmitter() as ChildProcess;
    const sendSpy = vi.fn();
    (child as unknown as { send: typeof sendSpy }).send = sendSpy;
    (child as unknown as { kill: () => void }).kill = vi.fn();
    (child as unknown as { connected: boolean }).connected = true;
    (child as unknown as { exitCode: number | null }).exitCode = null;
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool,
    });
    const { agentRunners } = await import('../../src/main/agent/runtime-registry');
    agentRunners.set('inst1', runner);

    const first = await resumeTask('T-D1');
    expect(first.streamSessionId).toBe('ss-dbl');
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // 第二次恢复同一任务：首次派发的流仍占道（fake child 未收尾）→ 拒绝
    await expect(resumeTask('T-D1')).rejects.toThrow(/已在恢复中/);
    // 关键锁：child 仍只收到一次 task-config（同 child 双 chat loop 被守卫拦截）
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('flip 后置（Finding 5）：lane 被异流占用时 resumeTask 抛错且消息行保持 failed', async () => {
    seedTask({ id: 'T-F5', status: 'in_progress', workspaceId: 'ws1', executionSessionId: 'sess-task1', assigneeAgentId: 'inst1' });
    seedAgentStream({
      streamSessionId: 'ss-flip',
      sessionId: 'sess-task1',
      senderAgentId: 'agent-bot-1',
      taskId: 'T-F5',
      text: ['半截输出'],
    });

    const child = new EventEmitter() as ChildProcess;
    const sendSpy = vi.fn();
    (child as unknown as { send: typeof sendSpy }).send = sendSpy;
    (child as unknown as { kill: () => void }).kill = vi.fn();
    (child as unknown as { connected: boolean }).connected = true;
    (child as unknown as { exitCode: number | null }).exitCode = null;
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool,
    });
    const { agentRunners } = await import('../../src/main/agent/runtime-registry');
    agentRunners.set('inst1', runner);

    // 同会话被另一条手输快速消息流占道
    const { registerLane } = await import('../../src/main/agent/session-lane');
    registerLane('sess-task1', {
      taskId: null,
      streamSessionId: 'other-manual-stream',
      assignmentId: 'inst1',
    });

    await expect(resumeTask('T-F5')).rejects.toThrow(/已被另一活跃流占用/);
    // 关键锁：拒绝路径不滞留 streaming 行——flip 未发生，保持 failed
    expect(getMessageByStreamSessionId('ss-flip')!.status).toBe('failed');
    // 未派发任何 task-config
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('C1 补偿锁：executeTask 同步抛错（spawn ENOENT 形态）→ lane 清空 + 消息行回滚 failed + 错误抛给调用方', async () => {
    seedTask({ id: 'T-C1', status: 'in_progress', workspaceId: 'ws1', executionSessionId: 'sess-task1', assigneeAgentId: 'inst1' });
    seedAgentStream({
      streamSessionId: 'ss-c1',
      sessionId: 'sess-task1',
      senderAgentId: 'agent-bot-1',
      taskId: 'T-C1',
      text: ['半程输出'],
    });

    // spawn 失败注入：不预热（池空）→ acquire 冷启动 fallback 直接吃到 spawn 拒绝
    // （真实形态：node 可执行缺失 / fork ENOENT——错误形状按真实语义仿真）
    const warmPool = new WarmPool({ spawn: vi.fn().mockRejectedValue(new Error('spawn ENOENT')) });
    const runner = new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool,
    });
    const { agentRunners } = await import('../../src/main/agent/runtime-registry');
    agentRunners.set('inst1', runner);

    // 真前置：翻回前确为 failed（sweep 收尾形态）
    expect(getMessageByStreamSessionId('ss-c1')!.status).toBe('failed');

    // IPC 调用方收到错误（不吞）
    await expect(resumeTask('T-C1')).rejects.toThrow(/spawn ENOENT/);

    // 车道补偿清空——否则 isLaneOccupied 恒真，会话死锁至重启
    expect(getLane('sess-task1')).toBeNull();

    // 消息行回滚：翻回 streaming 的行退回 failed，不滞留幽灵 streaming 行
    const msg = getMessageByStreamSessionId('ss-c1')!;
    expect(msg.status).toBe('failed');
    // final 事件落库（renderer 聚合状态与消息行同步翻回 failed）
    const final = listEventsByMessage(msg.id).find((e) => e.eventType === 'final');
    expect(final).toBeDefined();
    expect((final?.payload as Record<string, unknown>).status).toBe('failed');
  });

  it('重建段含已落库事件：tool_call_start/result 对 + 后续 text → LLMMessage 重建', async () => {
    seedTask({ id: 'T-1', status: 'in_progress', workspaceId: 'ws1', executionSessionId: 'sess-task1', assigneeAgentId: 'inst1' });
    insertMessage({
      sessionId: 'sess-task1',
      sender: 'owner',
      eventType: 'm.room.message',
      body: '原 user 指令 ss-rich',
      status: 'done',
    });
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-rich',
      sessionId: 'sess-task1',
      senderAgentId: 'agent-bot-1',
    });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-rich', delta: '先想一下' });
    __routeChunkToBufferForTest({
      type: 'tool_call',
      streamSessionId: 'ss-rich',
      callId: 'call-1',
      toolName: 'read_file',
      args: { path: '/x' },
    });
    __routeChunkToBufferForTest({
      type: 'tool_result',
      streamSessionId: 'ss-rich',
      callId: 'call-1',
      toolName: 'read_file',
      result: '文件内容',
      success: true,
    });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-rich', delta: '分析完毕' });
    __flushEventBufferForTest();
    // 真实 message id（传流 id 是静默 no-op——Finding 2 同型修复）
    updateMessageStatus(getMessageByStreamSessionId('ss-rich')!.id, 'failed');

    const child = new EventEmitter() as ChildProcess;
    const sendSpy = vi.fn();
    (child as unknown as { send: typeof sendSpy }).send = sendSpy;
    (child as unknown as { kill: () => void }).kill = vi.fn();
    (child as unknown as { connected: boolean }).connected = true;
    (child as unknown as { exitCode: number | null }).exitCode = null;
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool,
    });
    const { agentRunners } = await import('../../src/main/agent/runtime-registry');
    agentRunners.set('inst1', runner);

    const result = await resumeTask('T-1');
    expect(result.streamSessionId).toBe('ss-rich');
    const sent = sendSpy.mock.calls[0]![0] as { resume: RebuiltTurn };
    // 重建段应至少 4 条：原 user + assistant(tools) + tool(call-1) + assistant(text)
    expect(sent.resume.messages.length).toBeGreaterThanOrEqual(4);
    expect(sent.resume.toolCallsUsed).toBe(1);
  });

  it('assigned 任务：交由既有 executor 放行（notifyExecutor 真实锁定，不 void 压制）', async () => {
    seedTask({ id: 'T-A', status: 'assigned', workspaceId: 'ws1', executionSessionId: null, assigneeAgentId: 'inst1' });

    // CJS 模块对象可 spy：resumeTask 内部 await import('./executor') 在调用时
    // 解析同一模块命名空间 → spy 命中（review Finding 3：删 void notifySpy 压制）
    const executorModule = await import('../../src/main/task/executor');
    const notifySpy = vi.spyOn(executorModule, 'notifyExecutor');

    const result = await resumeTask('T-A');
    expect(result.streamSessionId).toBe('');
    // executor 放行链真实锁定——notifyExecutor 被调（并发闸 + 队列序 + kickoff 入口）
    expect(notifySpy).toHaveBeenCalledTimes(1);
    // 状态保持 assigned（resumeTask 不改任务状态——D6 检测时不改任务状态）
    expect(getTask('T-A')!.status).toBe('assigned');
    notifySpy.mockRestore();
  });

  it('非中断状态（completed/failed/draft/pending）抛错', async () => {
    seedTask({ id: 'T-C', status: 'completed', workspaceId: 'ws1', executionSessionId: 'sess-task1', assigneeAgentId: 'inst1' });
    seedTask({ id: 'T-F', status: 'failed', workspaceId: 'ws1', executionSessionId: 'sess-task1', assigneeAgentId: 'inst1' });
    seedTask({ id: 'T-D', status: 'draft', workspaceId: 'ws1', executionSessionId: null });

    await expect(resumeTask('T-C')).rejects.toThrow(/不可恢复/);
    await expect(resumeTask('T-F')).rejects.toThrow(/不可恢复/);
    await expect(resumeTask('T-D')).rejects.toThrow(/不可恢复/);
  });

  it('放弃链独立工作：in_progress → cancelled 经 task:transition 状态机合法性', () => {
    seedTask({ id: 'T-X', status: 'in_progress', workspaceId: 'ws1', executionSessionId: 'sess-task1', assigneeAgentId: 'inst1' });
    // spec §5.5：放弃走既有 task:transition('cancelled')——验证状态机合法性
    expect(() => transitionTaskStatus('T-X', 'cancelled')).not.toThrow();
    expect(getTask('T-X')!.status).toBe('cancelled');
  });
});

describe('TaskScheduler 边界回归锁（v2.6.0 spec §5.4 + D6）', () => {
  beforeEach(() => {
    setupDb();
    __resetEventBufferForTest();
    setJournalStore(createJournalStore(getDb()));
    __clearLaneForTest();
    __clearRuntimeRegistryForTest();
    insertWorkspace('ws1');
    insertAgentDef('def1', 'X');
    insertMember('inst1', 'ws1', 'def1', 'agent-bot-1');
  });
  afterEach(() => {
    setJournalStore(null);
    __resetEventBufferForTest();
    __clearLaneForTest();
    __clearRuntimeRegistryForTest();
    teardownDb();
  });

  it('checkOnce 对 in_progress 任务零触碰（不抢 in_progress——防未来改动与恢复链竞争）', async () => {
    insertAgentDef('def1', 'X');
    seedTask({ id: 'T-IP', status: 'in_progress', workspaceId: 'ws1', executionSessionId: 'sess-x', assigneeAgentId: 'inst1' });
    // 引入 scheduler 模块——避免循环 import
    const { TaskScheduler } = await import('../../src/main/task/scheduler');
    const sched = new TaskScheduler({ scanPickup: vi.fn().mockResolvedValue(true) });
    sched.checkOnce();
    expect(getTask('T-IP')!.status).toBe('in_progress');
  });

  it('checkOnce 对 assigned 任务零触碰（assigned 池由 executor 放行，不由 scheduler 升级）', async () => {
    insertAgentDef('def1', 'X');
    seedTask({ id: 'T-AS', status: 'assigned', workspaceId: 'ws1', executionSessionId: null, assigneeAgentId: 'inst1' });
    const { TaskScheduler } = await import('../../src/main/task/scheduler');
    const sched = new TaskScheduler({ scanPickup: vi.fn().mockResolvedValue(true) });
    sched.checkOnce();
    expect(getTask('T-AS')!.status).toBe('assigned');
  });

  it('checkOnce 仅升级 pending → assigned（scheduler 既有职责）', async () => {
    insertAgentDef('def1', 'X');
    // pending 任务带 scheduled_at 已到点 + 有委派目标 → 升级
    getDb()
      .prepare(
        `INSERT INTO tasks (
           id, workspace_id, title, description, status, creator_user_id,
           assignee_agent_id, scheduled_at, tool_calls_used,
           created_at, updated_at
         ) VALUES (?, 'ws1', '待升级', '', 'pending', 'owner', 'inst1', ?, 0, ?, ?)`,
      )
      .run('T-PD', Date.now() - 1000, Date.now(), Date.now());
    const { TaskScheduler } = await import('../../src/main/task/scheduler');
    const sched = new TaskScheduler({ scanPickup: vi.fn().mockResolvedValue(true) });
    sched.checkOnce();
    expect(getTask('T-PD')!.status).toBe('assigned');
  });
});

// ============================================================================
// 接线锁（v2.6.0 plan §7 + spec §7「v2.5 C1 教训」——生产形态）
//
// 双层结构断言（momo-test-rules 红绿变异记录）：
//   Part A：AgentRunner.executeTask 真实派发 + child.send 捕获 → 断言 resume 字段
//           出现在 IPC payload。摘掉 agent-runner 的 `...(task.resume ? { resume:
//           task.resume } : {})` → 锁红。
//   Part B：经 child.send 严格 round-trip 重建段字段（messages/toolCallsUsed/
//           steers 三件套） + 首条 user role + content 严格保真。
//           摘掉 TaskConfig.resume 字段定义或字段映射 → 锁红。
//   T4 runtime-resume.test.ts 已独立锁住 runChatLoop 运行时消费语义——
//   摘掉 runtime-entry.ts 解构 `resume` → T4 场景 1/2/3 红（独立锁链）。
// ============================================================================

describe('接线锁：AgentRunner.executeTask → child.send task-config 透传 resume', () => {
  beforeEach(() => {
    setupDb();
    __resetEventBufferForTest();
    setJournalStore(createJournalStore(getDb()));
    __clearLaneForTest();
    __clearRuntimeRegistryForTest();
    insertWorkspace('ws1');
    insertAgentDef('def1', 'Coder');
    insertMember('inst1', 'ws1', 'def1', 'agent-bot-1');
  });
  afterEach(() => {
    setJournalStore(null);
    __resetEventBufferForTest();
    __clearLaneForTest();
    __clearRuntimeRegistryForTest();
    teardownDb();
  });

  it('Part A：TaskConfig 含 resume 字段真实到达 child.send（摘透传必红）', async () => {
    seedTask({ id: 'T-W1', status: 'in_progress', workspaceId: 'ws1', executionSessionId: 'sess-w1', assigneeAgentId: 'inst1' });
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-w1',
      sessionId: 'sess-w1',
      senderAgentId: 'agent-bot-1',
    });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-w1', delta: '半截输出' });
    __flushEventBufferForTest();
    updateMessageStatus(getMessageByStreamSessionId('ss-w1')!.id, 'failed');

    const child = new EventEmitter() as ChildProcess;
    const sendSpy = vi.fn();
    (child as unknown as { send: typeof sendSpy }).send = sendSpy;
    (child as unknown as { kill: () => void }).kill = vi.fn();
    (child as unknown as { connected: boolean }).connected = true;
    (child as unknown as { exitCode: number | null }).exitCode = null;
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool,
    });
    const { agentRunners } = await import('../../src/main/agent/runtime-registry');
    agentRunners.set('inst1', runner);

    await resumeTask('T-W1');

    // 锁断言：child.send 第一参必须含 type=task-config 且 resume 字段被序列化
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = sendSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.type).toBe('task-config');
    expect(sent.resume).toBeDefined();
    const resumePayload = sent.resume as { messages: LLMMessage[]; toolCallsUsed: number; steers: string[] };
    expect(Array.isArray(resumePayload.messages)).toBe(true);
    expect(resumePayload.messages.length).toBeGreaterThan(0);
    expect(resumePayload.toolCallsUsed).toBe(0);
    expect(resumePayload.steers).toEqual([]);
  });

  it('Part B：TaskConfig resume 载荷经 executeTask → child.send 字段 round-trip 严格保真（摘透传必红 + 摘字段映射必红）', async () => {
    // 双层结构断言（不依赖完整 RuntimeContext 拼装——T4 runtime-resume.test.ts
    // 已覆盖 runChatLoop resumeTurn 消费的语义）：
    //   1. cfg.resume 字段经 child.send IPC 严格 round-trip（messages/toolCallsUsed/steers 三件套）
    //   2. 摘掉 agent-runner 的 `...(task.resume ? { resume: task.resume } : {})` 透传 → child.send payload 缺 resume → 锁红
    //   3. 摘掉 runTaskChatLoop 的解构 `resume`（destructure 改 named 字段如 `_resume`）→ IPC 仍含 resume 但 runtime 侧不消费 → T4 的 runtime-resume.test.ts 场景 1/2/3 会红（独立锁）
    seedTask({ id: 'T-W2', status: 'in_progress', workspaceId: 'ws1', executionSessionId: 'sess-w2', assigneeAgentId: 'inst1' });
    insertSession({ workspaceId: 'ws1', title: 't', kind: 'task_execution' });
    insertMessage({
      sessionId: 'sess-w2',
      sender: 'owner',
      eventType: 'm.room.message',
      body: '原 user 指令 ss-w2',
      status: 'done',
    });
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-w2',
      sessionId: 'sess-w2',
      senderAgentId: 'agent-bot-1',
    });
    __flushEventBufferForTest();
    updateMessageStatus(getMessageByStreamSessionId('ss-w2')!.id, 'failed');

    // 注入断点流行（rebuildTurn 应能拉出含 user + text 的 messages）
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-w2', delta: '前情文本' });
    __flushEventBufferForTest();

    const child = new EventEmitter() as ChildProcess;
    const sendSpy = vi.fn();
    (child as unknown as { send: typeof sendSpy }).send = sendSpy;
    (child as unknown as { kill: () => void }).kill = vi.fn();
    (child as unknown as { connected: boolean }).connected = true;
    (child as unknown as { exitCode: number | null }).exitCode = null;
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool,
    });
    const { agentRunners } = await import('../../src/main/agent/runtime-registry');
    agentRunners.set('inst1', runner);

    await resumeTask('T-W2');

    // 锁断言：child.send 第一参含 type=task-config + resume 字段严格 round-trip
    // （messages 含 user + 重建段文本；toolCallsUsed 数值；steers 数组）
    // ——摘掉 agent-runner 的 `resume` 透传 → 该 IPC payload 缺 resume 字段 → 锁红
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = sendSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.type).toBe('task-config');
    expect(sent.taskId).toBe('T-W2');
    expect(sent.executionSessionId).toBe('sess-w2');
    expect(sent.streamSessionId).toBe('ss-w2');
    const resumePayload = sent.resume as {
      messages: LLMMessage[];
      toolCallsUsed: number;
      steers: string[];
    };
    expect(Array.isArray(resumePayload.messages)).toBe(true);
    expect(resumePayload.messages.length).toBeGreaterThan(0);
    // 重建段首条必须是 user（rebuildTurn 经 owner 行 created_at <= 流行时间窗找回）
    expect(resumePayload.messages[0]?.role).toBe('user');
    expect(resumePayload.messages[0]?.content).toBe('原 user 指令 ss-w2');
    // toolCallsUsed 数值字段（重建流无 tool_call 事件 → 0）
    expect(resumePayload.toolCallsUsed).toBe(0);
    // steers 数组字段（未消费 steer 数组）
    expect(resumePayload.steers).toEqual([]);
  });
});

// ============================================================================
// flipMessageBackToStreaming（final review I1：SQL 与「base OR LIKE 'base#%'」
// 注释对齐）+ C1 端到端契约锁
//
// I1 危害形态：带 roll 的断点流恢复时旧 SQL 仅精确匹配 base——真正中断的
// #roll{n} 行保持 failed（sweep 标的），已被 roll 正常终态化的 base 行被从
// done 错翻回 streaming。红绿变异记录：摘掉 LIKE 子句（恢复精确匹配）→
// 「base 保持 done」断言必红（旧实现 base 被翻回 streaming）。
//
// fixture 全部经真实生产路径：chunk 驱动建流/roll（roll 自动终态化 base）+
// 真实 sweepStaleStreaming 收尾（只动 streaming 行，不动 done）——不手搓
// 生产不存在的行形态（momo-test-rules 铁律 1）。
// ============================================================================

describe('flipMessageBackToStreaming（I1 roll 边界 + C1 start 幂等契约锁）', () => {
  beforeEach(() => {
    setupDb();
    __resetEventBufferForTest();
  });
  afterEach(() => {
    __resetEventBufferForTest();
    teardownDb();
  });

  it('无 roll：sweep 标 failed 的流行翻回 streaming + status_change 落库（行为回归锁）', () => {
    __routeChunkToBufferForTest({
      type: 'start', streamSessionId: 'ss-flip-1', sessionId: 'sess-flip', senderAgentId: 'agent-bot-1',
    });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-flip-1', delta: '半截输出' });
    __flushEventBufferForTest();
    // App 崩溃 → boot sweep 收尾（真实生产路径，非手搓 updateMessageStatus）
    expect(sweepStaleStreaming()).toBe(1);
    expect(getMessageByStreamSessionId('ss-flip-1')!.status).toBe('failed');

    flipMessageBackToStreaming('ss-flip-1');

    const row = getMessageByStreamSessionId('ss-flip-1')!;
    expect(row.status).toBe('streaming');
    // 不改 body（保留 sweep 聚合回写的正文）
    expect(row.body).toBe('半截输出');
    // status_change 事件落库（renderer 聚合器消费——实时/重启两侧同视图）
    const statusChanges = listEventsByMessage(row.id).filter(
      (e) => e.eventType === 'status_change' && e.payload.status === 'streaming',
    );
    expect(statusChanges.length).toBe(2); // start 建行 1 条 + flip 1 条
  });

  it('I1 红绿主锁：带 roll 断点流翻最新 #roll1 行，已被 roll 终态化的 base 行保持 done', () => {
    // 真实生产：start + text → message_roll（base 自动终态化 done + body 聚合回写）
    // → #roll1 承接后续 → 崩溃 → sweep 只收尾 streaming 的 #roll1
    __routeChunkToBufferForTest({
      type: 'start', streamSessionId: 'ss-flip-r', sessionId: 'sess-flip', senderAgentId: 'agent-bot-1',
    });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-flip-r', delta: '断点前内容' });
    __routeChunkToBufferForTest({ type: 'message_roll', streamSessionId: 'ss-flip-r' });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-flip-r', delta: '滚后内容' });
    __flushEventBufferForTest();
    expect(sweepStaleStreaming()).toBe(1); // 仅 #roll1（base 已 done 不命中）

    const family = listMessagesByStreamSessionId('ss-flip-r');
    expect(family).toHaveLength(2);
    const base = family.find((m) => m.streamSessionId === 'ss-flip-r')!;
    const roll1 = family.find((m) => m.streamSessionId === 'ss-flip-r#roll1')!;
    expect(base.status).toBe('done');
    expect(roll1.status).toBe('failed');

    // resume：flip 以 base id 调用（resolveBreakpointStreamId 剥 # 后缀的产物）
    flipMessageBackToStreaming('ss-flip-r');

    // 关键断言（红绿点）：翻的是真正中断的 #roll1，base 不被错翻
    expect(getMessageByStreamSessionId('ss-flip-r')!.status).toBe('done');
    expect(getMessageByStreamSessionId('ss-flip-r#roll1')!.status).toBe('streaming');
    // status_change 落在 #roll1 上（不是 base）
    const roll1StatusChanges = listEventsByMessage(roll1.id).filter(
      (e) => e.eventType === 'status_change',
    );
    expect(roll1StatusChanges.length).toBe(2); // roll 建行 1 条 + flip 1 条
    const baseStatusChanges = listEventsByMessage(base.id).filter(
      (e) => e.eventType === 'status_change',
    );
    expect(baseStatusChanges.length).toBe(1); // 仅 start 建行——flip 未碰 base
  });

  it('C1 端到端契约锁：sweep → flip → resume 重发 start（base ssi）→ 续流 #roll1 收尾，全程零新行', () => {
    // ── 中断前：带 roll 的流跑到一半，App 崩溃 ──
    __routeChunkToBufferForTest({
      type: 'start', streamSessionId: 'ss-e2e', sessionId: 'sess-flip', senderAgentId: 'agent-bot-1',
    });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-e2e', delta: '断点前' });
    __routeChunkToBufferForTest({ type: 'message_roll', streamSessionId: 'ss-e2e' });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-e2e', delta: '滚后' });
    __flushEventBufferForTest();
    // ── 重启：boot sweep 收尾 #roll1 ──
    expect(sweepStaleStreaming()).toBe(1);
    // ── 恢复：flip 翻回 #roll1（base id 入参，剥 # 后缀后的产物）──
    flipMessageBackToStreaming('ss-e2e');
    // ── resume 派发：子进程以 base ssi 重发 start + 续跑输出 + end ──
    __routeChunkToBufferForTest({
      type: 'start', streamSessionId: 'ss-e2e', sessionId: 'sess-flip', senderAgentId: 'agent-bot-1',
    });
    __routeChunkToBufferForTest({ type: 'text', streamSessionId: 'ss-e2e', delta: '，续跑补全' });
    __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'ss-e2e', finishReason: 'stop' });

    // 全程零新行（红绿点：旧 start 实现在 start 重发处 +1 僵尸行）
    const family = listMessagesByStreamSessionId('ss-e2e');
    expect(family).toHaveLength(2);
    const base = family.find((m) => m.streamSessionId === 'ss-e2e')!;
    const roll1 = family.find((m) => m.streamSessionId === 'ss-e2e#roll1')!;
    // base：roll 终态化形态原样保持
    expect(base.status).toBe('done');
    expect(base.body).toBe('断点前');
    // #roll1：续流收尾——body 聚合滚后 + 续跑文本，事件续落（seq 全序连续）
    expect(roll1.status).toBe('done');
    expect(roll1.body).toBe('滚后，续跑补全');
    const roll1Events = listEventsByMessage(roll1.id);
    const seqs = roll1Events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // seq 升序（时间线性全序）
    // 时间线诚实：streaming(roll建行) → failed(sweep final 进程中断) →
    // streaming(flip) → streaming(幂等 start) → done(end final)
    const statusTimeline = roll1Events
      .filter((e) => e.eventType === 'status_change' || e.eventType === 'final')
      .map((e) => (e.payload.status as string));
    expect(statusTimeline).toEqual(['streaming', 'failed', 'streaming', 'streaming', 'done']);
  });

  it('无匹配行：no-op 不抛错不插行（边界空输入）', () => {
    expect(() => flipMessageBackToStreaming('ss-never-existed')).not.toThrow();
    expect(listMessagesByStreamSessionId('ss-never-existed')).toHaveLength(0);
  });
});
