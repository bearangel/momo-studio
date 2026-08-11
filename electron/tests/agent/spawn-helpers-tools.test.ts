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

/** 三表共用的 workspace + agent_definition seed（INSERT 列对齐 v1.6 schema） */
function seedWorkspaceAndDef(
  db: ReturnType<typeof getDb>,
  wsId: string,
  defId: string,
  defaultToolsJson: string,
): void {
  db.prepare(
    `INSERT INTO workspaces
       (id, name, directory_path, matrix_space_id, team_room_id, git_initialized, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(wsId, 'WS', '/tmp', '!s:r', '!t:r', 0, '@owner:s');
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt,
        default_tools, default_mcps, default_skills,
        source, description, icon_emoji,
        workspace_id, model_provider_id, model_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    defId, 'T', 't', '1', 'declarative', 'p',
    defaultToolsJson, '[]', '[]',
    'custom', 'd', '🤖',
    null, 'pid', 'm',
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
      botUserId: '@bot:s',
      workspaceId: 'ws1',
      workspaceDir: '/tmp',
      teamRoomId: '!t:r',
      ownerUserId: '@owner:s',
      def: makeDef('def1', ['read_file', 'bash']),
      botAccessToken: 'tok',
      role: 'standalone',
      llmApiKey: 'k',
      isCoordinator: false,
    });

    // 回归断言：v1.5 此处为 undefined（bug），修复后必须等于 def 默认工具列表
    expect(opts.allowedTools).toEqual(['read_file', 'bash']);
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
      botUserId: '@bot:s',
      workspaceId: 'ws1',
      workspaceDir: '/tmp',
      teamRoomId: '!t:r',
      ownerUserId: '@owner:s',
      def: makeDef('def1', ['read_file']),
      botAccessToken: 'tok',
      role: 'standalone',
      llmApiKey: 'k',
      isCoordinator: false,
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
    // 必须先建 assignment 行（agent_assignment_capabilities 的 FK 依赖）
    db.prepare(
      `INSERT INTO agent_assignments
         (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, role)
       VALUES (?, ?, ?, ?, 1, 'standalone')`,
    ).run('inst1', 'ws1', 'def1', '@bot:s');
    // Layer 3 delta：移除 bash
    db.prepare(
      'INSERT INTO agent_assignment_capabilities (assignment_id, capability_type, mode, ref) VALUES (?, ?, ?, ?)',
    ).run('inst1', 'tool', 'remove', 'bash');

    const opts = buildSpawnOpts({
      instanceId: 'inst1',
      botUserId: '@bot:s',
      workspaceId: 'ws1',
      workspaceDir: '/tmp',
      teamRoomId: '!t:r',
      ownerUserId: '@owner:s',
      def: makeDef('def1', ['read_file', 'bash']),
      botAccessToken: 'tok',
      role: 'standalone',
      llmApiKey: 'k',
      isCoordinator: false,
    });

    // 回归断言：bash 被 Layer 3 delta remove，最终 allowedTools 只剩 read_file
    expect(opts.allowedTools).toEqual(['read_file']);
  });
});
