// electron/tests/agent/spawn-helpers-tools.test.ts
//
// v1.6 Task 4 关键回归测试：buildSpawnOpts 必须把 merged.tools 注入 opts.allowedTools。
//
// 背景：v1.5 之前 buildSpawnOpts 调用 mergeCapabilities(def, allocation) 后只消费
//   merged.skills / merged.mcps，把 merged.tools 完全丢弃。结果 AgentRuntimeOpts.allowedTools
//   永远 undefined，runtime-entry.ts 的 permission 判断对 undefined 全放行——所有 agent
//   实际能用全部 24 个工具，与 def.defaultTools 配置完全无关。这是 v1.5 以来最严重的
//   安全 bug，本测试锁死 bug 不复发。
//
// 三个回归用例：
//   1. def 默认工具 → allowedTools（Layer 1）
//   2. def 默认 + workspace allocation 合并 → allowedTools（Layer 1 ∪ Layer 2）
//   3. Layer 3 deltas 生效：removed 工具不在 allowedTools（Layer 1 ∪ Layer 2 - removed）
//
// v2（Task 10）：buildSpawnOpts 入参/出参改为本地身份形状
//   （agentUserId / teamSessionId，删除 botUserId / botAccessToken / homeserverUrl /
//   ownerUserId / teamRoomId），首个用例附加形状断言。
//
// DB 隔离沿用仓库既定模式（参考 assignment-capabilities-crud.test.ts / T2）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - getDb() 单例 + foreign_keys = ON（cascade 依赖此 PRAGMA）
//   - closeDb() 在 afterEach 复位单例
// 不用 new Database(':memory:') + spyOn(dbModule, 'getDb')：那会绕过 getDb 单例，
// 与生产代码路径不一致（AGENTS.md 明确要求按 T2 模式）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { buildSpawnOpts } from '../../src/main/agent/spawn-helpers';
import type { AgentDefinition } from '../../src/main/agent/types';

const tmpRoot = path.join(os.tmpdir(), `ap-spawn-tools-test-${Date.now()}-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();

  const db = getDb();
  // 预建 provider：buildSpawnOpts 内部 getProvider(def.modelProviderId) 必须命中
  // api_key_ref 是 NOT NULL 列，必须显式写入（keychain 由 resolveApiKey 在外部解析，
  // buildSpawnOpts 不读 key，故 keychain 不需 mock）
  db.prepare(
    `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('pid', 'Test', 'https://api.test.com', 'provider.pid.api_key', null, 0);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 三表共用的 workspace + agent_definition seed（INSERT 列对齐 v25 schema） */
function seedWorkspaceAndDef(
  db: ReturnType<typeof getDb>,
  wsId: string,
  defId: string,
  defaultToolsJson: string,
): void {
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(wsId, 'WS', '', '/tmp', 0, '@owner:s', '📁');
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt,
        default_tools, default_mcps, default_skills,
        source, description, icon_emoji,
        model_provider_id, model_name, task_driven)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    defId, 'T', 't', '1', 'declarative', 'p',
    defaultToolsJson, '[]', '[]',
    'custom', 'd', '🤖',
    'pid', 'm', 1,
  );
}

/** 由 defaultToolsJson 反推出 AgentDefinition.defaultTools（保持测试可读） */
function makeDef(defId: string, toolRefs: string[]): AgentDefinition {
  return {
    id: defId,
    name: 'T',
    slug: 't',
    version: '1',
    runtime: 'declarative',
    systemPrompt: 'p',
    defaultTools: toolRefs.map((ref) => ({ kind: 'builtin', ref })),
    defaultMcps: [],
    defaultSkills: [],
    source: 'custom',
    description: '',
    iconEmoji: '🤖',
    workspaceId: null,
    modelProviderId: 'pid',
    modelName: 'm',
  };
}

describe('spawn-helpers bug 修复：merged.tools → allowedTools', () => {
  it('buildSpawnOpts 把 def 默认工具注入 opts.allowedTools', () => {
    const db = getDb();
    seedWorkspaceAndDef(
      db,
      'ws1',
      'def1',
      JSON.stringify([
        { kind: 'builtin', ref: 'read_file' },
        { kind: 'builtin', ref: 'bash' },
      ]),
    );

    const opts = buildSpawnOpts({
      instanceId: 'inst1',
      agentUserId: 'agent-t-ab12cd',
      workspaceId: 'ws1',
      workspaceDir: '/tmp',
      teamSessionId: 'sess-1',
      def: makeDef('def1', ['read_file', 'bash']),
      role: 'standalone',
      llmApiKey: 'k',
    });

    // 回归断言：v1.5 此处为 undefined（bug），修复后必须等于 def 默认工具列表
    expect(opts.allowedTools).toEqual(['read_file', 'bash']);

    // v2（Task 10）：opts 携带本地身份 + 团队会话 ID，不再有 Matrix 凭据字段
    expect(opts.agentAssignmentId).toBe('inst1');
    expect(opts.agentUserId).toBe('agent-t-ab12cd');
    expect(opts.teamSessionId).toBe('sess-1');
    expect(opts).not.toHaveProperty('botUserId');
    expect(opts).not.toHaveProperty('botAccessToken');
    expect(opts).not.toHaveProperty('homeserverUrl');
    expect(opts).not.toHaveProperty('ownerUserId');
    expect(opts).not.toHaveProperty('teamRoomId');
  });

  it('def 默认 + workspace allocation 合并后注入 allowedTools', () => {
    const db = getDb();
    seedWorkspaceAndDef(
      db,
      'ws1',
      'def1',
      JSON.stringify([{ kind: 'builtin', ref: 'read_file' }]),
    );
    // workspace allocation 加 bash（Layer 2 增量）
    db.prepare(
      'INSERT INTO workspace_allocations (workspace_id, capability_type, capability_ref) VALUES (?, ?, ?)',
    ).run('ws1', 'tool', 'bash');

    const opts = buildSpawnOpts({
      instanceId: 'inst1',
      agentUserId: 'agent-t-ab12cd',
      workspaceId: 'ws1',
      workspaceDir: '/tmp',
      teamSessionId: 'sess-1',
      def: makeDef('def1', ['read_file']),
      role: 'standalone',
      llmApiKey: 'k',
    });

    // 回归断言：Layer 1 ∪ Layer 2 后的工具全集（顺序：def 先，alloc 后）
    expect(opts.allowedTools).toEqual(['read_file', 'bash']);
  });

  it('Layer 3 deltas 生效：removed bash 不在 allowedTools 中', () => {
    const db = getDb();
    seedWorkspaceAndDef(
      db,
      'ws1',
      'def1',
      JSON.stringify([
        { kind: 'builtin', ref: 'read_file' },
        { kind: 'builtin', ref: 'bash' },
      ]),
    );
    // 必须先建成员行（agent_assignment_capabilities.assignment_id 与成员实例对齐）
    db.prepare(
      `INSERT INTO workspace_agent_members
         (instance_id, workspace_id, agent_definition_id, agent_user_id)
       VALUES (?, ?, ?, ?)`,
    ).run('inst1', 'ws1', 'def1', 'agent-t-ab12cd');
    // ⚠️ v25 已知断裂：agent_assignment_capabilities 的 FK 仍引用已 DROP 的
    // agent_assignments 表（foreign_keys=ON 时 INSERT 报 no such table）——
    // 生产写路径 agent:setMemberDeltas 同样受影响，属能力域清理任务范围。
    // 本用例锁的是 read 侧（readAssignmentDeltas → mergeCapabilities）Layer 3
    // 合并语义，故 seed 临时关 FK 绕过断裂的写路径；断裂本身已在任务报告记录。
    db.pragma('foreign_keys = OFF');
    try {
      db.prepare(
        'INSERT INTO agent_assignment_capabilities (assignment_id, capability_type, mode, ref) VALUES (?, ?, ?, ?)',
      ).run('inst1', 'tool', 'remove', 'bash');
    } finally {
      db.pragma('foreign_keys = ON');
    }

    const opts = buildSpawnOpts({
      instanceId: 'inst1',
      agentUserId: 'agent-t-ab12cd',
      workspaceId: 'ws1',
      workspaceDir: '/tmp',
      teamSessionId: 'sess-1',
      def: makeDef('def1', ['read_file', 'bash']),
      role: 'standalone',
      llmApiKey: 'k',
    });

    // 回归断言：bash 被 Layer 3 delta remove，最终 allowedTools 只剩 read_file
    expect(opts.allowedTools).toEqual(['read_file']);
  });
});
