// electron/tests/agent/resolve-model-limits.test.ts
//
// 压缩重构 Task 1（spec 2026-09-09 §2.3）：窗口元数据 resolve 链契约测试。
//
// 锁死的优先级（单一真相源）：
//   provider_models.context_window（用户覆盖，非 NULL 且 >0）
//     → 内置目录（model-catalog 按 platform+名称匹配）
//     → null（未知；下游 RuntimeConfig 用 0 表示）
//
// 同时锁 spawn 透传链（生产者 → AGENT_CONFIG 线协议 → 消费者）：
//   buildSpawnOpts 产出 opts.contextWindow/outputTokens（null→0）
//   → JSON 序列化（AGENT_CONFIG env）→ parseConfig 还原 RuntimeConfig 字段。
//
// DB 隔离沿用仓库既定模式（参考 spawn-helpers-platform.test.ts）：
//   process.env.AP_USER_DATA_DIR 指向临时目录 + getDb() 单例 + closeDb() 复位。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  resolveModelLimits,
  buildSpawnOpts,
} from '../../src/main/agent/spawn-helpers';
import { parseConfig } from '../../src/main/agent/runtime-config';
import type { AgentDefinition } from '../../src/main/agent/types';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-resolve-limits-test-${Date.now()}-${process.pid}`,
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

function seedProvider(
  db: ReturnType<typeof getDb>,
  id: string,
  platform: 'openai' | 'anthropic',
): void {
  db.prepare(
    `INSERT INTO model_providers
       (id, name, base_url, api_key_ref, default_model, is_default, platform)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'T', 'https://api.test.com', `provider.${id}.api_key`, null, 0, platform);
}

/** 种 provider_models 行（context_window 为用户覆盖列，可空） */
function seedModelRow(
  db: ReturnType<typeof getDb>,
  providerId: string,
  modelId: string,
  contextWindow: number | null,
): void {
  db.prepare(
    `INSERT INTO provider_models (provider_id, model_id, enabled, added_at, context_window)
     VALUES (?, ?, 1, 1000, ?)`,
  ).run(providerId, modelId, contextWindow);
}

function seedWorkspaceAndDef(
  db: ReturnType<typeof getDb>,
  wsId: string,
  defId: string,
  providerId: string,
  modelName: string,
): void {
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, 'WS', '', '/tmp', 0, '@owner:s', '📁')`,
  ).run(wsId);
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt,
        default_tools, default_mcps, default_skills,
        source, description, icon_emoji,
        model_provider_id, model_name, task_driven)
     VALUES (?, 'T', 't', '1', 'declarative', 'p', '[]', '[]', '[]',
        'custom', 'd', '🤖', ?, ?, 1)`,
  ).run(defId, providerId, modelName);
}

function makeDef(defId: string, providerId: string, modelName: string): AgentDefinition {
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
    modelName,
  };
}

describe('resolveModelLimits：优先级链（用户列 > 目录 > null）', () => {
  it('用户列 context_window 非 NULL 且 >0：覆盖目录窗口，outputTokens 仍取目录', async () => {
    const db = getDb();
    seedProvider(db, 'pid-a', 'openai');
    seedModelRow(db, 'pid-a', 'glm-4.6', 131072);

    const limits = await resolveModelLimits('pid-a', 'glm-4.6');
    // glm-4.6 目录值 200000/96000；用户覆盖窗口 131072 生效，输出上限沿用目录
    expect(limits).toEqual({ contextWindow: 131072, outputTokens: 96000 });
  });

  it('用户列为 NULL：回落目录值', async () => {
    const db = getDb();
    seedProvider(db, 'pid-b', 'openai');
    seedModelRow(db, 'pid-b', 'gpt-4o', null);

    expect(await resolveModelLimits('pid-b', 'gpt-4o')).toEqual({
      contextWindow: 128000,
      outputTokens: 16384,
    });
  });

  it('provider_models 无该行：直接走目录（不报错）', async () => {
    const db = getDb();
    seedProvider(db, 'pid-c', 'openai');

    expect(await resolveModelLimits('pid-c', 'gpt-4o')).toEqual({
      contextWindow: 128000,
      outputTokens: 16384,
    });
  });

  it('用户列与目录都无：返回 null（未知窗口 fail-safe）', async () => {
    const db = getDb();
    seedProvider(db, 'pid-d', 'openai');
    seedModelRow(db, 'pid-d', 'my-private-model', null);

    expect(await resolveModelLimits('pid-d', 'my-private-model')).toBeNull();
  });

  it('用户列有值但目录无条目：窗口生效，outputTokens=0（输出未知）', async () => {
    const db = getDb();
    seedProvider(db, 'pid-e', 'openai');
    seedModelRow(db, 'pid-e', 'my-private-model', 999999);

    expect(await resolveModelLimits('pid-e', 'my-private-model')).toEqual({
      contextWindow: 999999,
      outputTokens: 0,
    });
  });

  it('provider 不存在：返回 null（ghost provider 不炸）', async () => {
    const db = getDb();
    seedProvider(db, 'pid-f', 'openai');
    void db;

    expect(await resolveModelLimits('ghost-provider', 'gpt-4o')).toBeNull();
  });
});

describe('窗口元数据 spawn 透传（buildSpawnOpts → AGENT_CONFIG → parseConfig）', () => {
  it('目录命中的模型：opts 携带窗口两字段，线协议往返后 RuntimeConfig 保持', async () => {
    const db = getDb();
    seedProvider(db, 'pid-g', 'openai');
    seedWorkspaceAndDef(db, 'ws-1', 'def-1', 'pid-g', 'gpt-4o');

    const opts = await buildSpawnOpts({
      instanceId: 'inst1',
      agentUserId: 'agent-t-ab12cd',
      workspaceId: 'ws-1',
      workspaceDir: '/tmp',
      def: makeDef('def-1', 'pid-g', 'gpt-4o'),
      llmApiKey: 'k',
    });

    expect(opts.contextWindow).toBe(128000);
    expect(opts.outputTokens).toBe(16384);

    // 线协议跳：AGENT_CONFIG 的真实传输方式（JSON env var → parseConfig）
    const config = parseConfig(JSON.parse(JSON.stringify(opts)));
    expect(config.contextWindow).toBe(128000);
    expect(config.outputTokens).toBe(16384);
  });

  it('未知窗口模型：opts 与 RuntimeConfig 均为 0（0=未知 fail-safe）', async () => {
    const db = getDb();
    seedProvider(db, 'pid-h', 'anthropic');
    seedWorkspaceAndDef(db, 'ws-1', 'def-2', 'pid-h', 'my-unknown-model');

    const opts = await buildSpawnOpts({
      instanceId: 'inst1',
      agentUserId: 'agent-t-ab12cd',
      workspaceId: 'ws-1',
      workspaceDir: '/tmp',
      def: makeDef('def-2', 'pid-h', 'my-unknown-model'),
      llmApiKey: 'k',
    });

    expect(opts.contextWindow).toBe(0);
    expect(opts.outputTokens).toBe(0);

    const config = parseConfig(JSON.parse(JSON.stringify(opts)));
    expect(config.contextWindow).toBe(0);
    expect(config.outputTokens).toBe(0);
  });

  it('用户列覆盖：buildSpawnOpts 产出被覆盖后的窗口', async () => {
    const db = getDb();
    seedProvider(db, 'pid-i', 'openai');
    seedModelRow(db, 'pid-i', 'glm-4.6', 131072);
    seedWorkspaceAndDef(db, 'ws-1', 'def-3', 'pid-i', 'glm-4.6');

    const opts = await buildSpawnOpts({
      instanceId: 'inst1',
      agentUserId: 'agent-t-ab12cd',
      workspaceId: 'ws-1',
      workspaceDir: '/tmp',
      def: makeDef('def-3', 'pid-i', 'glm-4.6'),
      llmApiKey: 'k',
    });

    expect(opts.contextWindow).toBe(131072);
    // 输出上限未被用户列覆盖，沿用目录
    expect(opts.outputTokens).toBe(96000);
  });
});
