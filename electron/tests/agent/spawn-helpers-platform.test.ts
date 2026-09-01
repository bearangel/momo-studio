// electron/tests/agent/spawn-helpers-platform.test.ts
//
// P3 Task 1：buildSpawnOpts 必须把 provider.platform 透传到 opts.modelPlatform。
//
// 背景：
//   v24 migration 已把 model_providers 表加 platform 列（CHECK IN ('openai'|'anthropic')），
//   provider-crud rowToProvider 已产出字段。但 spawn-helpers.ts 的 buildSpawnOpts 仍
//   只透传 modelName / modelBaseUrl / llmApiKey，runtime-entry 创建 LLM 时只收到 baseUrl，
//   createLLMProvider 不得不按 baseUrl 启发式检测 platform（detectPlatform 启发式）。
//   非 anthropic.com 域名的 Anthropic 兼容供应商会被误判为 openai 协议——本测试锁死
//   接线，使设置页的下拉（v24 落地）真正生效。
//
// 测试边界：
//   - buildSpawnOpts 透传：platform 'anthropic' → opts.modelPlatform === 'anthropic'；
//     platform 'openai' → 'openai'。
//   - runtime-entry 侧：runChatLoop 调用 createLLMProvider 时传入的 provider 参数由
//     config.modelPlatform 决定；该函数 spawn 进子进程，单元测试在 dispatch/task-reply
//     集成套件里有间接覆盖（mock createLLMProvider 校验 provider 字段），本文件按 brief
//     只覆盖 spawn-helpers 直测点。
//
// DB 隔离沿用仓库既定模式（参考 spawn-helpers-tools.test.ts）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - getDb() 单例 + foreign_keys = ON
//   - closeDb() 在 afterEach 复位单例

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { buildSpawnOpts } from '../../src/main/agent/spawn-helpers';
import type { AgentDefinition } from '../../src/main/agent/types';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-spawn-platform-test-${Date.now()}-${process.pid}`,
);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** v24 schema：platform 列必填。INSERT 同步写 platform，避免默认值 'openai' 遮蔽测试意图 */
function seedProvider(
  db: ReturnType<typeof getDb>,
  id: string,
  baseUrl: string,
  platform: 'openai' | 'anthropic',
): void {
  db.prepare(
    `INSERT INTO model_providers
       (id, name, base_url, api_key_ref, default_model, is_default, platform)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'Test', baseUrl, `provider.${id}.api_key`, null, 0, platform);
}

/** workspace + agent_definition seed（v25 schema 列对齐） */
function seedWorkspaceAndDef(
  db: ReturnType<typeof getDb>,
  wsId: string,
  defId: string,
  providerId: string,
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
    '[]', '[]', '[]',
    'custom', 'd', '🤖',
    providerId, 'm', 1,
  );
}

function makeDef(defId: string, providerId: string): AgentDefinition {
  return {
    id: defId,
    name: 'T',
    slug: 't',
    version: '1',
    runtime: 'declarative',
    systemPrompt: 'p',
    defaultTools: [],
    defaultMcps: [],
    defaultSkills: [],
    source: 'custom',
    description: '',
    iconEmoji: '🤖',
    workspaceId: null,
    modelProviderId: providerId,
    modelName: 'm',
  };
}

describe('buildSpawnOpts platform 透传 (P3 Task 1)', () => {
  it('provider.platform=anthropic 时 opts.modelPlatform === "anthropic"', () => {
    const db = getDb();
    seedProvider(db, 'pid-ant', 'https://api.custom-ant.com/v1', 'anthropic');
    seedWorkspaceAndDef(db, 'ws1', 'def1', 'pid-ant');

    const opts = buildSpawnOpts({
      instanceId: 'inst1',
      agentUserId: 'agent-t-ab12cd',
      workspaceId: 'ws1',
      workspaceDir: '/tmp',
      teamSessionId: 'sess-1',
      def: makeDef('def1', 'pid-ant'),
      role: 'standalone',
      llmApiKey: 'k',
    });

    expect(opts.modelPlatform).toBe('anthropic');
  });

  it('provider.platform=openai 时 opts.modelPlatform === "openai"', () => {
    const db = getDb();
    seedProvider(db, 'pid-oai', 'https://api.openai.com/v1', 'openai');
    seedWorkspaceAndDef(db, 'ws1', 'def1', 'pid-oai');

    const opts = buildSpawnOpts({
      instanceId: 'inst1',
      agentUserId: 'agent-t-ab12cd',
      workspaceId: 'ws1',
      workspaceDir: '/tmp',
      teamSessionId: 'sess-1',
      def: makeDef('def1', 'pid-oai'),
      role: 'standalone',
      llmApiKey: 'k',
    });

    expect(opts.modelPlatform).toBe('openai');
  });

  it('opts.modelBaseUrl 仍同步透传（接线不影响 baseUrl 行为）', () => {
    const db = getDb();
    seedProvider(db, 'pid-ant', 'https://api.custom-ant.com/v1', 'anthropic');
    seedWorkspaceAndDef(db, 'ws1', 'def1', 'pid-ant');

    const opts = buildSpawnOpts({
      instanceId: 'inst1',
      agentUserId: 'agent-t-ab12cd',
      workspaceId: 'ws1',
      workspaceDir: '/tmp',
      teamSessionId: 'sess-1',
      def: makeDef('def1', 'pid-ant'),
      role: 'standalone',
      llmApiKey: 'k',
    });

    expect(opts.modelBaseUrl).toBe('https://api.custom-ant.com/v1');
  });
});
