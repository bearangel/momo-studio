// electron/tests/agent/dispatch-snapshot.test.ts
//
// v25 Task 10 契约测试（spec §4.7）：dispatch 工具注入条件切会话快照。
//
// 行为契约：
//   1. dispatch 注入条件 = 「会话有效成员数 > 1 且自己是 is_leader」
//      （取代 v1 的 role==='main'；role 在 v25 恒 'standalone'）
//   2. config.subAgents = 当前 session_members 快照除自己
//      （取代 v1 的 assignment.parent_instance_id 链查询）
//   3. 快照语义：spawn 时点一次性计算，之后成员变化不影响已产出的配置
//
// 契约链路（momo-test-rules #4，不经手写中间数据）：
//   生产者 buildSpawnOpts（真实查 session_members × workspace_agent_members ×
//   agent_definitions）→ JSON.stringify/parse（AGENT_CONFIG 线协议真实传输方式）
//   → parseConfig（runtime-entry 侧真实解析）→ buildRuntimeContext（runtime-entry
//   真实工具注册）→ 断言 dispatch:<slug> 工具集。
//
// DB 隔离沿用仓库既定模式（参考 spawn-helpers-platform.test.ts）：
//   process.env.AP_USER_DATA_DIR 指向临时目录 + getDb() 单例 + closeDb() 复位。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { buildSpawnOpts } from '../../src/main/agent/spawn-helpers';
import { parseConfig, type AgentRuntimeOpts } from '../../src/main/agent/runtime-config';
import { buildRuntimeContext } from '../../src/main/agent/runtime-entry';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import type { AgentDefinition } from '../../src/main/agent/types';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-dispatch-snapshot-test-${Date.now()}-${process.pid}`,
);
/** buildRuntimeContext 的 WorkspaceFS 需要真实存在的 workspace 目录 */
const wsDir = path.join(tmpRoot, 'ws');

beforeEach(() => {
  fs.mkdirSync(wsDir, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  seedBase();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

// ─── seed 基座 ──────────────────────────────────────────────────────────────

/** workspace + provider + 三个 agent 定义（pm / coder / reviewer）+ 三个成员实例 */
function seedBase(): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES ('ws-1', 'WS', '', ?, 0, '@owner:local', '📁')`,
  ).run(wsDir);
  db.prepare(
    `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default, platform)
     VALUES ('prov-1', 'P', 'https://api.test/v1', 'provider.prov-1.api_key', NULL, 0, 'openai')`,
  ).run();
  // 三个 def：pm（被测 agent 自己）+ coder / reviewer（潜在 sub）
  for (const [defId, slug, desc] of [
    ['def-pm', 'pm', 'PM 描述'],
    ['def-coder', 'coder', '写代码的子 agent'],
    ['def-reviewer', 'reviewer', '做评审的子 agent'],
  ] as const) {
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
          default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
       VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', ?, '🤖', 'prov-1', 'm', 1)`,
    ).run(defId, slug, slug, desc);
  }
  for (const [instId, defId] of [
    ['inst-pm', 'def-pm'],
    ['inst-coder', 'def-coder'],
    ['inst-reviewer', 'def-reviewer'],
  ] as const) {
    db.prepare(
      `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
       VALUES (?, 'ws-1', ?, ?)`,
    ).run(instId, defId, `agent-${defId}-ab12`);
  }
}

function makeDef(defId: string, slug: string, description: string): AgentDefinition {
  return {
    id: defId,
    name: slug,
    slug,
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: 'p',
    defaultTools: [],
    defaultMcps: [],
    defaultSkills: [],
    source: 'custom',
    description,
    iconEmoji: '🤖',
    workspaceId: null,
    modelProviderId: 'prov-1',
    modelName: 'm',
  };
}

/** 生产者：真实 buildSpawnOpts（被测 agent = inst-pm） */
function buildPmOpts(): AgentRuntimeOpts {
  return buildSpawnOpts({
    instanceId: 'inst-pm',
    agentUserId: 'agent-def-pm-ab12',
    workspaceId: 'ws-1',
    workspaceDir: wsDir,
    teamSessionId: '',
    def: makeDef('def-pm', 'pm', 'PM 描述'),
    llmApiKey: 'k',
  });
}

/** 线协议跳：AGENT_CONFIG 真实传输方式（JSON env var → JSON.parse → parseConfig） */
function hopWire(opts: AgentRuntimeOpts): ReturnType<typeof parseConfig> {
  return parseConfig(JSON.parse(JSON.stringify(opts)));
}

/** 消费者视角：从真实工具注册结果里取 dispatch:<slug> 工具名列表 */
async function dispatchToolNames(opts: AgentRuntimeOpts): Promise<string[]> {
  const config = hopWire(opts);
  const ctx = await buildRuntimeContext(config);
  return ctx.tools.map((t) => t.name).filter((n) => n.startsWith('dispatch:'));
}

/** 建团队会话快捷方式：members = [instanceId × isLeader] 快照写入 */
function createSession(
  members: Array<{ instanceId: string; isLeader: boolean }>,
): string {
  const s = insertSession({ workspaceId: 'ws-1', title: 'T' });
  for (const m of members) addSessionMember(s.id, m.instanceId, m.isLeader);
  return s.id;
}

// ─── 契约 1+2：多成员 leader → 注入 dispatch + subAgents=快照除自己 ──────────

describe('dispatch 快照契约（spec §4.7）', () => {
  it('多成员会话 leader：注入 dispatch 工具，subAgents=快照除自己（slug/assignmentId/description 真实值）', async () => {
    createSession([
      { instanceId: 'inst-pm', isLeader: true },
      { instanceId: 'inst-coder', isLeader: false },
      { instanceId: 'inst-reviewer', isLeader: false },
    ]);

    const opts = buildPmOpts();
    expect(opts.isLeader).toBe(true);
    // 契约 2：快照除自己——不含 inst-pm，且携带消费者真实使用的三个字段
    // （dispatch-wait 按 slug 路由、dispatch_to 用 assignmentId、工具描述用 description）
    expect(opts.subAgents!).toHaveLength(2);
    expect(opts.subAgents!.map((s) => s.slug).sort()).toEqual(['coder', 'reviewer']);
    expect(opts.subAgents!.map((s) => s.assignmentId).sort()).toEqual(['inst-coder', 'inst-reviewer']);
    const coder = opts.subAgents!.find((s) => s.slug === 'coder');
    expect(coder?.description).toBe('写代码的子 agent');

    // 消费者：真实工具注册（经 AGENT_CONFIG 线协议跳）
    expect((await dispatchToolNames(opts)).sort()).toEqual(['dispatch:coder', 'dispatch:reviewer']);
  });

  it('单成员会话（仅自己 leader）：不注入 dispatch 工具', async () => {
    createSession([{ instanceId: 'inst-pm', isLeader: true }]);

    const opts = buildPmOpts();
    expect(opts.isLeader).toBe(false);
    expect(opts.subAgents).toEqual([]);
    expect(await dispatchToolNames(opts)).toEqual([]);
  });

  it('非 leader 多成员：不注入 dispatch 工具（即使会话成员数 > 1）', async () => {
    createSession([
      { instanceId: 'inst-coder', isLeader: true },
      { instanceId: 'inst-pm', isLeader: false },
      { instanceId: 'inst-reviewer', isLeader: false },
    ]);

    const opts = buildPmOpts();
    expect(opts.isLeader).toBe(false);
    expect(opts.subAgents).toEqual([]);
    expect(await dispatchToolNames(opts)).toEqual([]);
  });

  it('不在任何会话：不注入（空输入专项）', async () => {
    const opts = buildPmOpts();
    expect(opts.isLeader).toBe(false);
    expect(opts.subAgents).toEqual([]);
    expect(await dispatchToolNames(opts)).toEqual([]);
  });

  // ─── 契约 3：快照时点语义 ────────────────────────────────────────────────

  it('快照后成员入会不影响已 spawn 配置；下一次 spawn 才看到新成员', () => {
    createSession([
      { instanceId: 'inst-pm', isLeader: true },
      { instanceId: 'inst-coder', isLeader: false },
    ]);
    const opts = buildPmOpts();
    const frozen = JSON.parse(JSON.stringify(opts.subAgents));

    // 快照后新成员入会（同会话）
    const db = getDb();
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
          default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
       VALUES ('def-late', 'late', 'late', '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', 'd', '🤖', 'prov-1', 'm', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
       VALUES ('inst-late', 'ws-1', 'def-late', 'agent-def-late-ab12')`,
    ).run();
    db.prepare(
      `INSERT INTO session_members (session_id, instance_id, is_leader, added_at)
       SELECT session_id, 'inst-late', 0, ? FROM session_members WHERE instance_id = 'inst-pm'`,
    ).run(Date.now());

    // 已 spawn 配置不受影响（AGENT_CONFIG 已在子进程环境里定型）
    expect(opts.subAgents).toEqual(frozen);
    // 新一次 spawn 看到新成员（快照按 spawn 时点重算）
    const opts2 = buildPmOpts();
    expect(opts2.subAgents!.map((s) => s.slug).sort()).toEqual(['coder', 'late']);
  });

  it('成员被移出 workspace（FK 级联清 session_members）：下一次 spawn 快照剔除该成员', () => {
    createSession([
      { instanceId: 'inst-pm', isLeader: true },
      { instanceId: 'inst-coder', isLeader: false },
      { instanceId: 'inst-reviewer', isLeader: false },
    ]);
    const db = getDb();
    db.prepare(`DELETE FROM workspace_agent_members WHERE instance_id = 'inst-reviewer'`).run();

    const opts = buildPmOpts();
    expect(opts.subAgents!.map((s) => s.slug)).toEqual(['coder']);

    // 全部其他成员被移出 → 有效成员数回到 1 → 不再注入
    db.prepare(`DELETE FROM workspace_agent_members WHERE instance_id = 'inst-coder'`).run();
    const opts2 = buildPmOpts();
    expect(opts2.isLeader).toBe(false);
    expect(opts2.subAgents).toEqual([]);
  });

  // ─── 多会话 union 与去重 ─────────────────────────────────────────────────

  it('leader 的多个会话：subAgents 取并集且按实例去重', () => {
    // S1：pm(leader) + coder；S2：pm(leader) + coder + reviewer
    createSession([
      { instanceId: 'inst-pm', isLeader: true },
      { instanceId: 'inst-coder', isLeader: false },
    ]);
    createSession([
      { instanceId: 'inst-pm', isLeader: true },
      { instanceId: 'inst-coder', isLeader: false },
      { instanceId: 'inst-reviewer', isLeader: false },
    ]);

    const opts = buildPmOpts();
    expect(opts.subAgents!.map((s) => s.slug).sort()).toEqual(['coder', 'reviewer']);
  });

  it('跨 workspace 会话不串位：其他 ws 的会话（即便自己是 leader）不进入快照', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
       VALUES ('ws-2', 'WS2', '', ?, 0, '@owner:local', '📁')`,
    ).run(wsDir);
    // ws-2 放一个成员 + 会话（leader = ws-1 的 inst-pm——构造跨 ws 会话的极端形状）
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
          default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
       VALUES ('def-other', 'other', 'other', '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', 'd', '🤖', 'prov-1', 'm', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
       VALUES ('inst-other', 'ws-2', 'def-other', 'agent-def-other-ab12')`,
    ).run();
    const s2 = insertSession({ workspaceId: 'ws-2', title: 'T2' });
    addSessionMember(s2.id, 'inst-pm', true);
    addSessionMember(s2.id, 'inst-other', false);

    const opts = buildPmOpts();
    expect(opts.isLeader).toBe(false);
    expect(opts.subAgents).toEqual([]);
  });

  // ─── 线协议：isLeader 字段（isCoordinator 改名）+ 解析防御 ───────────────

  it('线协议字段为 isLeader（非 isCoordinator）；parseConfig 布尔特判缺失/非法回退 false', () => {
    createSession([
      { instanceId: 'inst-pm', isLeader: true },
      { instanceId: 'inst-coder', isLeader: false },
    ]);

    const opts = buildPmOpts();
    const wire = JSON.parse(JSON.stringify(opts)) as Record<string, unknown>;
    expect(wire.isLeader).toBe(true);
    expect('isCoordinator' in wire).toBe(false);

    // 缺失 / 非法 → false（错误路径专项）
    const noField = { ...wire } as Record<string, unknown>;
    delete noField.isLeader;
    expect(parseConfig(noField).isLeader).toBe(false);
    const badField = { ...wire, isLeader: 'yes' };
    expect(parseConfig(badField).isLeader).toBe(false);
  });

  it('subAgents 非法形状经线协议被 parseConfig 类型守卫剔除', () => {
    createSession([
      { instanceId: 'inst-pm', isLeader: true },
      { instanceId: 'inst-coder', isLeader: false },
    ]);
    const wire = JSON.parse(JSON.stringify(buildPmOpts())) as Record<string, unknown>;
    wire.subAgents = [
      { slug: 'x' }, // 缺 assignmentId/description → 守卫剔除
      { slug: 1, assignmentId: 'a', description: 'd' }, // slug 非字符串 → 剔除
      'not-an-object',
    ];
    const config = parseConfig(wire);
    expect(config.subAgents).toEqual([]);
    expect(config.isLeader).toBe(true);
  });
});
