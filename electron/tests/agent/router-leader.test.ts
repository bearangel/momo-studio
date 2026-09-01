// electron/tests/agent/router-leader.test.ts
//
// 会话路由 leader 接待改造测试（v25 Task 9，spec §4.6 / D5）。
// 五条行为契约 + T8 移交的 sender 契约锁：
//   ① 非 @ 消息 → 会话内 is_leader=1 且有效成员接待；无 leader（历史会话）→ 不派发
//   ② @ 成员 → 该成员直答，leader 不插嘴
//   ③ 接待者 lastRunning=false（无 runner）→ 自动 start 后派发（RouterService ensureRunner）
//   ④ 失效成员（已移出 ws）跳过；全部失效 → 消息仅落库 + 返回 readOnly=true
//   ⑤ 首条用户消息 → applyFirstMessageTitle 截断占位；接待者首次 final → scheduleLlmTitle
//   ※ sender 契约：生产 sendUserMessage 落库行被 session-naming 直接消费（'owner' 字面量锁死）
//
// 保真度约定（momo-test-rules）：
//   - Mock 收窄：仅 vi.mock p2p 广播（网络边界）与 createLLMProvider（LLM 边界）；
//     路由判定、DB 读写、命名守卫 SQL、事件落库全部走真实实现
//   - RouterService 用真实实例 + duck-typed fake runner（executeTask spy）；
//     自动拉起链用「注册 runner 进 Map」的 ensureRunner spy 仿真 start 效果
//     （真实 start 链 spawn 子进程，属进程边界，不在单测范围）
//   - final 落库点：真实 routeChunkToBuffer（start/end chunk 驱动），
//     listener 注册直接调用 setFinalListener(onLeaderFinal)（生产接线由
//     router-bootstrap 完成并在 router-bootstrap.test 锁定）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { mockBroadcast, createLLMProviderMock, chatMock, ensureMemberRuntimeMock } = vi.hoisted(() => ({
  mockBroadcast: vi.fn(),
  createLLMProviderMock: vi.fn(),
  chatMock: vi.fn(),
  ensureMemberRuntimeMock: vi.fn(),
}));

vi.mock('../../src/main/p2p', () => ({
  broadcastLocalMessage: mockBroadcast,
}));

vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: createLLMProviderMock,
}));

// start 链 mock（spawn 子进程属进程边界）：ensureMemberRuntime 替换为
// 「向真实 agentRunners 注册 fake runner」的 spy——零 runner bootstrap 接线用例专用，
// 其余用例不触碰 ensureRouterService，不受影响
vi.mock('../../src/main/agent/start-chain', () => ({
  ensureMemberRuntime: ensureMemberRuntimeMock,
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertSession,
  addSessionMember,
  getSession,
} from '../../src/main/storage/sessions/repo';
import { listMessagesBySession } from '../../src/main/storage/messages/repo';
import { setKeychainImpl } from '../../src/main/storage/keychain';
import {
  sendUserMessage,
  resolveTarget,
  setSessionRouter,
} from '../../src/main/im/session-service';
import { RouterService } from '../../src/main/agent/router-service';
import { onLeaderFinal } from '../../src/main/im/session-naming';
import {
  __routeChunkToBufferForTest,
  __flushEventBufferForTest,
  __resetEventBufferForTest,
  setFinalListener,
} from '../../src/main/agent/stream-relay';
import type { AgentRunner } from '../../src/main/agent/agent-runner';

// ─── 测试基建 ────────────────────────────────────────────────────────────────

const tmpRoot = path.join(os.tmpdir(), `ap-router-leader-${Date.now()}`);

const PROVIDER_ID = 'p1';
/** 首条用户消息（去换行后前 20 字 = 含第二处逗号，正好 20 字符） */
const USER_BODY = '帮我做一个登录页面，要支持手机号验证码，还要记住密码';
const TRUNCATED_20 = '帮我做一个登录页面，要支持手机号验证码，';

function seedWorkspace(db: ReturnType<typeof getDb>, id: string): void {
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji,
        default_agent_instance_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'WS', '', '/tmp', 0, '@owner:s', '📁', null);
}

function seedProvider(db: ReturnType<typeof getDb>, id: string): void {
  db.prepare(
    `INSERT INTO model_providers (id, name, base_url, api_key_ref, platform)
     VALUES (?, ?, ?, ?, 'openai')`,
  ).run(id, `prov-${id}`, 'https://api.example.com/v1', `provider.${id}.api_key`);
}

function seedAgentDef(
  db: ReturnType<typeof getDb>,
  id: string,
  name: string,
  providerId: string | null = PROVIDER_ID,
): void {
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, system_prompt, model_name, icon_emoji, model_provider_id)
     VALUES (?, ?, ?, '1', 'p', 'test-model', '🤖', ?)`,
  ).run(id, name, name.toLowerCase(), providerId);
}

function seedMember(
  db: ReturnType<typeof getDb>,
  instanceId: string,
  defId: string,
  opts?: { lastRunning?: number; agentUserId?: string },
): void {
  db.prepare(
    `INSERT INTO workspace_agent_members
       (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
     VALUES (?, 'ws1', ?, ?, ?)`,
  ).run(instanceId, defId, opts?.agentUserId ?? `agent-${instanceId}`, opts?.lastRunning ?? 1);
}

/** duck-typed fake runner：只实现 routeUserChat 消费的 executeTask */
function makeFakeRunner(instanceId: string): { runner: AgentRunner; executeTask: ReturnType<typeof vi.fn> } {
  const executeTask = vi.fn().mockResolvedValue({ streamSessionId: 'ss-x' });
  const runner = { assignmentId: instanceId, executeTask } as unknown as AgentRunner;
  return { runner, executeTask };
}

/** 排空微任务队列（scheduleLlmTitle 的 fire-and-forget 链无定时器） */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();

  const db = getDb();
  seedWorkspace(db, 'ws1');
  seedProvider(db, PROVIDER_ID);
  seedAgentDef(db, 'def-lead', 'Alpha');
  seedAgentDef(db, 'def-b', 'Beta');

  // keychain OS 边界注入 fake：resolveApiKey（override ?? provider key）真实执行
  setKeychainImpl({
    async getSecret(key: string) {
      return key === `provider.${PROVIDER_ID}.api_key` ? 'sk-test' : null;
    },
    async setSecret() {},
    async deleteSecret() {},
  });

  mockBroadcast.mockReset().mockResolvedValue(undefined);
  chatMock.mockReset().mockResolvedValue({ content: '登录页面开发', toolCalls: [], finishReason: 'stop' });
  createLLMProviderMock.mockReset().mockImplementation(() => ({ chat: chatMock }));
});

afterEach(async () => {
  setSessionRouter(null);
  setFinalListener(null);
  __resetEventBufferForTest();
  // 零 runner bootstrap 用例可能经真实 router-bootstrap 注入过 router/runner——
  // 统一反向清理，防跨用例泄漏
  const { destroyRouterService } = await import('../../src/main/agent/router-bootstrap');
  destroyRouterService();
  const { agentRunners } = await import('../../src/main/agent/runtime-registry');
  agentRunners.clear();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

// ─── 契约①：非 @ 消息 → leader 接待 ────────────────────────────────────────

describe('契约①：非 @ 消息 → is_leader=1 且有效成员接待', () => {
  it('多成员会话：leader 成员接待非 @ 消息', async () => {
    const db = getDb();
    seedMember(db, 'inst-lead', 'def-lead');
    seedMember(db, 'inst-b', 'def-b');
    const s = insertSession({ workspaceId: 'ws1', title: '团队会话' });
    addSessionMember(s.id, 'inst-lead', true);
    addSessionMember(s.id, 'inst-b', false);

    expect(resolveTarget(s.id, [])).toBe('inst-lead');

    const routeUserChat = vi.fn().mockResolvedValue(undefined);
    setSessionRouter({ routeUserChat });
    await sendUserMessage({ sessionId: s.id, body: '大家好' });

    expect(routeUserChat).toHaveBeenCalledTimes(1);
    expect(routeUserChat).toHaveBeenCalledWith({ sessionId: s.id, assignmentId: 'inst-lead', body: '大家好' });
  });

  it('无 leader 的历史会话（成员均在但 is_leader=0）→ 不派发任何 agent，readOnly=false', async () => {
    const db = getDb();
    seedMember(db, 'inst-a', 'def-lead');
    seedMember(db, 'inst-b', 'def-b');
    const s = insertSession({ workspaceId: 'ws1', title: '历史会话' });
    addSessionMember(s.id, 'inst-a', false);
    addSessionMember(s.id, 'inst-b', false);

    expect(resolveTarget(s.id, [])).toBeNull();

    const routeUserChat = vi.fn();
    setSessionRouter({ routeUserChat });
    const result = await sendUserMessage({ sessionId: s.id, body: '没人接待' });

    expect(routeUserChat).not.toHaveBeenCalled();
    expect(result).toEqual({ readOnly: false });
    // 消息仍落库
    expect(listMessagesBySession(s.id)).toHaveLength(1);
  });
});

// ─── 契约②：@ 成员直答，leader 不插嘴 ──────────────────────────────────────

describe('契约②：@ 成员直答，leader 不插嘴', () => {
  it('@ 指定非 leader 成员 → 路由到该成员而非 leader', async () => {
    const db = getDb();
    seedMember(db, 'inst-lead', 'def-lead');
    seedMember(db, 'inst-b', 'def-b');
    const s = insertSession({ workspaceId: 'ws1', title: '团队会话' });
    addSessionMember(s.id, 'inst-lead', true);
    addSessionMember(s.id, 'inst-b', false);

    expect(resolveTarget(s.id, ['inst-b'])).toBe('inst-b');

    const routeUserChat = vi.fn().mockResolvedValue(undefined);
    setSessionRouter({ routeUserChat });
    await sendUserMessage({ sessionId: s.id, body: '@Beta 你来', mentionedInstanceIds: ['inst-b'] });

    expect(routeUserChat).toHaveBeenCalledWith({ sessionId: s.id, assignmentId: 'inst-b', body: '@Beta 你来' });
  });

  it('@ 非会话成员 → mention 未命中，回退 leader 接待', async () => {
    const db = getDb();
    seedMember(db, 'inst-lead', 'def-lead');
    const s = insertSession({ workspaceId: 'ws1', title: '单 agent 会话' });
    addSessionMember(s.id, 'inst-lead', true);

    expect(resolveTarget(s.id, ['inst-elsewhere'])).toBe('inst-lead');
  });
});

// ─── 契约③：接待者 lastRunning=false → 自动 start 后派发 ───────────────────

describe('契约③：接待者离线（lastRunning=false）→ 自动拉起后派发', () => {
  it('runner 缺失 → ensureRunner（start 链）先行，runner 注册后派发到目标会话', async () => {
    const db = getDb();
    // lastRunning=false：用户从未启动 / 已停止——runner 必然不在 Map
    seedMember(db, 'inst-lead', 'def-lead', { lastRunning: 0 });
    const s = insertSession({ workspaceId: 'ws1', title: '快速会话' });
    addSessionMember(s.id, 'inst-lead', true);

    const runners = new Map<string, AgentRunner>();
    const { runner: fakeRunner, executeTask } = makeFakeRunner('inst-lead');
    // 仿真 start 链效果：拉起完成后 runner 注册进全局 Map（真实链 spawn 子进程，属进程边界）
    const ensureRunner = vi.fn(async (instanceId: string) => {
      runners.set(instanceId, fakeRunner);
    });
    const svc = new RouterService({ runners, ensureRunner });
    setSessionRouter(svc);

    await sendUserMessage({ sessionId: s.id, body: '在吗' });

    expect(ensureRunner).toHaveBeenCalledTimes(1);
    expect(ensureRunner).toHaveBeenCalledWith('inst-lead');
    // start 后派发：executeTask 收到目标会话 + 消息体
    expect(executeTask).toHaveBeenCalledTimes(1);
    const task = executeTask.mock.calls[0]![0] as { executionSessionId: string; body: string };
    expect(task.executionSessionId).toBe(s.id);
    expect(task.body).toBe('在吗');
  });

  it('runner 已在 → 不触发自动拉起，直接派发', async () => {
    const db = getDb();
    seedMember(db, 'inst-lead', 'def-lead', { lastRunning: 1 });
    const s = insertSession({ workspaceId: 'ws1', title: '快速会话' });
    addSessionMember(s.id, 'inst-lead', true);

    const runners = new Map<string, AgentRunner>();
    const { runner: fakeRunner, executeTask } = makeFakeRunner('inst-lead');
    runners.set('inst-lead', fakeRunner);
    const ensureRunner = vi.fn();
    setSessionRouter(new RouterService({ runners, ensureRunner }));

    await sendUserMessage({ sessionId: s.id, body: '直接派发' });

    expect(ensureRunner).not.toHaveBeenCalled();
    expect(executeTask).toHaveBeenCalledTimes(1);
  });

  it('自动拉起失败 → 放弃派发，消息发送本身不抛错（fire-and-forget 语义）', async () => {
    const db = getDb();
    seedMember(db, 'inst-lead', 'def-lead', { lastRunning: 0 });
    const s = insertSession({ workspaceId: 'ws1', title: '快速会话' });
    addSessionMember(s.id, 'inst-lead', true);

    const runners = new Map<string, AgentRunner>();
    const { executeTask } = makeFakeRunner('inst-lead');
    const ensureRunner = vi.fn().mockRejectedValue(new Error('spawn 失败'));
    setSessionRouter(new RouterService({ runners, ensureRunner }));

    await expect(sendUserMessage({ sessionId: s.id, body: '拉不起来' })).resolves.toEqual({ readOnly: false });
    expect(executeTask).not.toHaveBeenCalled();
    // 消息仍落库
    expect(listMessagesBySession(s.id)).toHaveLength(1);
  });
});

// ─── 契约④：失效成员过滤 + 全失效只读 ──────────────────────────────────────

describe('契约④：失效成员（已移出 ws）跳过；全部失效 → 只读', () => {
  it('成员已移出 workspace → 视为失效：@ 失效成员不命中，回退 leader 接待', async () => {
    const db = getDb();
    seedMember(db, 'inst-lead', 'def-lead');
    seedMember(db, 'inst-gone', 'def-b');
    const s = insertSession({ workspaceId: 'ws1', title: '团队会话' });
    addSessionMember(s.id, 'inst-lead', true);
    addSessionMember(s.id, 'inst-gone', false);

    // 生产失效路径：removeMember 删 workspace_agent_members 行，
    // session_members 快照行由 FK ON DELETE CASCADE 级联清理
    db.prepare('DELETE FROM workspace_agent_members WHERE instance_id = ?').run('inst-gone');
    expect(getSessionMembersCount(s.id)).toBe(1);

    // @ 已移出成员 → mention 未命中 → 回退 leader 接待
    expect(resolveTarget(s.id, ['inst-gone'])).toBe('inst-lead');

    const routeUserChat = vi.fn().mockResolvedValue(undefined);
    setSessionRouter({ routeUserChat });
    const result = await sendUserMessage({ sessionId: s.id, body: '有人吗', mentionedInstanceIds: ['inst-gone'] });

    expect(routeUserChat).toHaveBeenCalledWith({ sessionId: s.id, assignmentId: 'inst-lead', body: '有人吗' });
    expect(result).toEqual({ readOnly: false });
  });

  it('全部成员失效 → 消息仅落库不派发，sendMessage 返回 readOnly=true', async () => {
    const db = getDb();
    seedMember(db, 'inst-lead', 'def-lead');
    const s = insertSession({ workspaceId: 'ws1', title: '孤儿会话' });
    addSessionMember(s.id, 'inst-lead', true);

    // 全部成员被移出 ws：快照行级联清空，会话退化为无有效成员
    db.prepare('DELETE FROM workspace_agent_members WHERE instance_id = ?').run('inst-lead');
    expect(getSessionMembersCount(s.id)).toBe(0);

    const routeUserChat = vi.fn();
    setSessionRouter({ routeUserChat });
    const result = await sendUserMessage({ sessionId: s.id, body: '只读会话' });

    expect(result).toEqual({ readOnly: true });
    expect(routeUserChat).not.toHaveBeenCalled();
    // 消息仅落库
    const rows = listMessagesBySession(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sender).toBe('owner');
  });
});

/** 会话内「有效成员」数：与生产接待判定同源（JOIN 过滤已移出 ws 的成员） */
function getSessionMembersCount(sessionId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM session_members m
       JOIN workspace_agent_members a ON m.instance_id = a.instance_id
       WHERE m.session_id = ?`,
    )
    .get(sessionId) as { n: number };
  return row.n;
}

// ─── 契约⑤：命名服务接线（T8 → T9） ────────────────────────────────────────

describe('契约⑤：首条消息截断占位 + 接待者首次 final 触发 LLM 命名', () => {
  it('首条用户消息落库 → 标题截断为去换行前 20 字，title_auto 保持 1', async () => {
    const db = getDb();
    seedMember(db, 'inst-lead', 'def-lead');
    const s = insertSession({ workspaceId: 'ws1', title: '新会话', titleAuto: true });
    addSessionMember(s.id, 'inst-lead', true);

    await sendUserMessage({ sessionId: s.id, body: USER_BODY });

    const after = getSession(s.id)!;
    expect(after.title).toBe(TRUNCATED_20);
    expect(after.titleAuto).toBe(true);
  });

  it('接待者首次 final（end chunk 落库点）→ scheduleLlmTitle → LLM 替换标题', async () => {
    const db = getDb();
    seedMember(db, 'inst-lead', 'def-lead');
    const s = insertSession({ workspaceId: 'ws1', title: '新会话', titleAuto: true });
    addSessionMember(s.id, 'inst-lead', true);

    // 首条用户消息（生产写入路径）
    await sendUserMessage({ sessionId: s.id, body: USER_BODY });

    // 接待 agent 流：start → end（final 事件落库点在 end 分支）
    setFinalListener(onLeaderFinal);
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-leader-1',
      sessionId: s.id,
      senderAgentId: 'agent-inst-lead',
    });
    __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'ss-leader-1', finishReason: 'stop' });
    __flushEventBufferForTest();
    await flushMicrotasks();

    expect(createLLMProviderMock).toHaveBeenCalledTimes(1);
    const after = getSession(s.id)!;
    expect(after.title).toBe('登录页面开发');
    expect(after.titleAuto).toBe(false);
  });

  it('非接待成员的 final 不触发 LLM 命名（sender 必须是 leader 的 agentUserId）', async () => {
    const db = getDb();
    seedMember(db, 'inst-lead', 'def-lead');
    seedMember(db, 'inst-b', 'def-b');
    const s = insertSession({ workspaceId: 'ws1', title: '新会话', titleAuto: true });
    addSessionMember(s.id, 'inst-lead', true);
    addSessionMember(s.id, 'inst-b', false);

    await sendUserMessage({ sessionId: s.id, body: USER_BODY });

    setFinalListener(onLeaderFinal);
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: 'ss-sub-1',
      sessionId: s.id,
      senderAgentId: 'agent-inst-b',
    });
    __routeChunkToBufferForTest({ type: 'end', streamSessionId: 'ss-sub-1', finishReason: 'stop' });
    __flushEventBufferForTest();
    await flushMicrotasks();

    expect(createLLMProviderMock).not.toHaveBeenCalled();
    const after = getSession(s.id)!;
    expect(after.title).toBe(TRUNCATED_20);
    expect(after.titleAuto).toBe(true);
  });
});

// ─── T8 移交必办①：sender 契约锁（生产者 → 消费者，不经手写中间数据） ─────

describe('sender 契约锁：生产写入的 sender 字面量 === session-naming 读取的 owner', () => {
  it('真实 sendUserMessage 落库行被真实 scheduleLlmTitle 直接消费（firstUser 过滤命中）', async () => {
    const db = getDb();
    seedMember(db, 'inst-lead', 'def-lead');
    const s = insertSession({ workspaceId: 'ws1', title: '新会话', titleAuto: true });
    addSessionMember(s.id, 'inst-lead', true);

    // 生产者：真实 sendUserMessage（不经手写 insertMessage 构造中间数据）
    await sendUserMessage({ sessionId: s.id, body: USER_BODY });

    // 消费者：真实 scheduleLlmTitle——内部按 m.sender === 'owner' 找 firstUser；
    // 字面量漂移时 firstUser 找不到 → warn 跳过 → LLM mock 永不被调 → 本断言红
    const { scheduleLlmTitle } = await import('../../src/main/im/session-naming');
    scheduleLlmTitle(s.id);
    await flushMicrotasks();

    expect(createLLMProviderMock).toHaveBeenCalledTimes(1);
    expect(getSession(s.id)!.title).toBe('登录页面开发');

    // 锁生产现状：落库行 sender 就是 'owner' 字面量（消费方过滤条件的另一面）
    const rows = listMessagesBySession(s.id);
    expect(rows[0]!.sender).toBe('owner');
  });
});

// ─── 零 runner bootstrap 接线（评审修复：自动拉起契约跨重启闭环） ───────────

describe('零 runner bootstrap：RouterService 在零 runner 状态也被创建（自动拉起闭环）', () => {
  it('用户停掉全部 agent 后重启（boot 零 runner）→ ensureRouterService 仍创建 router，sendUserMessage 触发自动拉起派发', async () => {
    const db = getDb();
    seedMember(db, 'inst-lead', 'def-lead', { lastRunning: 0 });
    const s = insertSession({ workspaceId: 'ws1', title: '快速会话' });
    addSessionMember(s.id, 'inst-lead', true);

    // 真生产接线：真实 router-bootstrap + 真实 agentRunners 注册表（非 setSessionRouter 注入）
    const { agentRunners } = await import('../../src/main/agent/runtime-registry');
    const { ensureRouterService, __resetRouterServiceForTest } = await import('../../src/main/agent/router-bootstrap');
    __resetRouterServiceForTest();
    agentRunners.clear();

    // start 链效果仿真（进程边界 mock）：拉起 = 向真实注册表写入 fake runner
    const { runner: fakeRunner, executeTask } = makeFakeRunner('inst-lead');
    ensureMemberRuntimeMock.mockReset();
    ensureMemberRuntimeMock.mockImplementation(async (instanceId: string) => {
      agentRunners.set(instanceId, fakeRunner);
    });

    // 零 runner 启动——旧实现在此早退（router 永不创建 → 派发链静默死路）
    await ensureRouterService(agentRunners);

    await sendUserMessage({ sessionId: s.id, body: '重启后第一条消息' });

    expect(ensureMemberRuntimeMock).toHaveBeenCalledTimes(1);
    expect(ensureMemberRuntimeMock).toHaveBeenCalledWith('inst-lead');
    expect(executeTask).toHaveBeenCalledTimes(1);
    const task = executeTask.mock.calls[0]![0] as { executionSessionId: string; body: string };
    expect(task.executionSessionId).toBe(s.id);
    expect(task.body).toBe('重启后第一条消息');
  });
});
