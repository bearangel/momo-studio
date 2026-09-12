// electron/tests/agent/dispatch-session-boundary.test.ts
//
// dispatch 会话边界回归锁（2026-09-07 主机报告严重 bug）：
// 快速会话（单成员）中 PM 依然 dispatch 子 agent。
//
// 根因：buildDispatchSnapshot 是实例级快照（该实例作为 leader 的所有会话的
// 并集，spawn 时定型）——agent 只要曾是任何多成员会话的 leader，它在单成员
// 快速会话里也带着 dispatch 工具；executeDispatch 无任何「当前会话」校验。
//
// 修复语义（spec §4.7 会话边界的正确化）：dispatch 只在当前会话内合法——
//   1. 当前会话成员数 > 1（单成员/快速会话拒绝）
//   2. 自己是当前会话 leader
//   3. 目标 sub agent 是当前会话成员（防跨会话委派）
// 校验在 PM 侧 executeDispatch 入口执行（子进程 DB 可达，与 task-tools 同栈）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import { executeDispatch } from '../../src/main/agent/dispatch-wait';
import { INTERNAL_EVENT_MSG, type InternalEventMsg } from '../../src/main/agent/internal-event';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-dispatch-boundary-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

const sentEvents: InternalEventMsg[] = [];
const originalSend = process.send;

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-pm',
    agentUserId: 'agent-pm-01',
    systemPrompt: 'x',
    modelName: 'm',
    llmApiKey: 'k',
    workspaceDir: '/tmp',
    workspaceId: 'ws1',
    role: 'main',
    subAgents: [{ slug: 'ui', assignmentId: 'inst-sub', description: 'UI' }],
    skills: [],
    mcpNames: [],
    allowedTools: [],
    deniedTools: [],
    isLeader: true,
    devMode: false,
    maxToolCalls: -1,
    contextWindow: 0,
    outputTokens: 0,
    ...overrides,
  };
}

/** seed agent 定义 + workspace 成员行（session_members 的 FK 链上游） */
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
     VALUES (?, 'ws1', ?, ?)`,
  ).run(instanceId, instanceId, `agent-${instanceId}`);
}

/** seed 一个会话 + 成员（走生产 repo，保真 sessions/session_members 行形状）。
 *  insertSession 自生成 uuid——返回行 .id 即真实会话 id，测试闭包捕获供断言。 */
function seedSession(
  members: Array<{ instanceId: string; isLeader?: boolean }>,
): string {
  for (const m of members) seedAgentInstance(m.instanceId);
  const sess = insertSession({ workspaceId: 'ws1', title: '边界测试' });
  for (const m of members) {
    addSessionMember(sess.id, m.instanceId, m.isLeader === true);
  }
  return sess.id;
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/tmp', '@o')`)
    .run();
  sentEvents.length = 0;
  process.send = ((msg: unknown): boolean => {
    const m = msg as InternalEventMsg;
    if (m?.type === INTERNAL_EVENT_MSG) sentEvents.push(m);
    return true;
  }) as NonNullable<typeof process.send>;
});

afterEach(() => {
  process.send = originalSend;
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('executeDispatch 会话边界（严重 bug 回归锁）', () => {
  it('快速会话（单成员，仅自己）→ 拒绝 dispatch，不发事件', async () => {
    const sessionId = seedSession([{ instanceId: 'inst-pm', isLeader: true }]);
    const controller = new AbortController();
    const p = executeDispatch('ui', '任务', makeConfig(), undefined, 'ss-sub', 'ss-pm', sessionId, controller.signal).catch(() => null);
    controller.abort();
    await p;

    expect(sentEvents.find((e) => e.eventType === 'io.momo-studio.dispatch')).toBeUndefined();
  });

  it('多成员会话 + 自己是 leader + 目标在会话 → 放行（正常路径不回归）', async () => {
    const sessionId = seedSession([
      { instanceId: 'inst-pm', isLeader: true },
      { instanceId: 'inst-sub' },
    ]);
    const controller = new AbortController();
    const p = executeDispatch('ui', '任务', makeConfig(), undefined, 'ss-sub', 'ss-pm', sessionId, controller.signal).catch(() => null);
    controller.abort();
    await p;

    expect(sentEvents.find((e) => e.eventType === 'io.momo-studio.dispatch')).toBeDefined();
  });

  it('多成员会话但自己不是 leader → 拒绝', async () => {
    const sessionId = seedSession([
      { instanceId: 'other-leader', isLeader: true },
      { instanceId: 'inst-pm' },
      { instanceId: 'inst-sub' },
    ]);
    const controller = new AbortController();
    const p = executeDispatch('ui', '任务', makeConfig(), undefined, 'ss-sub', 'ss-pm', sessionId, controller.signal).catch(() => null);
    controller.abort();
    await p;

    expect(sentEvents.find((e) => e.eventType === 'io.momo-studio.dispatch')).toBeUndefined();
  });

  it('目标是快照成员但不是当前会话成员（跨会话委派）→ 拒绝', async () => {
    // inst-sub 在别的会话，当前会话只有 pm + 另一个成员
    const sessionId = seedSession([
      { instanceId: 'inst-pm', isLeader: true },
      { instanceId: 'inst-other' },
    ]);
    seedSession([{ instanceId: 'inst-sub' }]);
    const controller = new AbortController();
    const p = executeDispatch('ui', '任务', makeConfig(), undefined, 'ss-sub', 'ss-pm', sessionId, controller.signal).catch(() => null);
    controller.abort();
    await p;

    expect(sentEvents.find((e) => e.eventType === 'io.momo-studio.dispatch')).toBeUndefined();
  });

  it('会话不存在（executionSessionId 无效）→ 拒绝', async () => {
    const controller = new AbortController();
    const p = executeDispatch('ui', '任务', makeConfig(), undefined, 'ss-sub', 'ss-pm', 'sess-ghost', controller.signal).catch(() => null);
    controller.abort();
    await p;

    expect(sentEvents.find((e) => e.eventType === 'io.momo-studio.dispatch')).toBeUndefined();
  });
});
