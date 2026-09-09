// electron/tests/agent/resolve-thinking.test.ts
//
// 思维配置 fallback（spec §4）+ 方言解析 + 越界钳制 + spawn 透传往返：
//   agent_definitions.thinking_json → provider_models.thinking_json → {mode:'auto'}
// 能力词汇表：预设模型表 → 正则目录 → none
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { resolveThinkingConfig, buildSpawnOpts } from '../../src/main/agent/spawn-helpers';
import { parseConfig } from '../../src/main/agent/runtime-config';
import { getProvider, type ModelProvider } from '../../src/main/agent/provider-crud';
import type { AgentDefinition } from '../../src/main/agent/types';

const tmpRoot = path.join(os.tmpdir(), `ap-resolve-thinking-${Date.now()}-${process.pid}`);

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

function seedProvider(id: string, platform: 'openai' | 'anthropic', presetKey: string | null): void {
  // name 取 id 保证唯一（model_providers.name UNIQUE；同一用例会种多个 provider）
  getDb().prepare(
    `INSERT INTO model_providers
       (id, name, base_url, api_key_ref, default_model, is_default, platform, preset_key)
     VALUES (?, ?, 'https://api.test.com', 'ref', NULL, 0, ?, ?)`,
  ).run(id, id, platform, presetKey);
}

function seedModelThinking(providerId: string, modelId: string, thinkingJson: string | null): void {
  getDb().prepare(
    `INSERT INTO provider_models (provider_id, model_id, enabled, added_at, thinking_json)
     VALUES (?, ?, 1, 1, ?)`,
  ).run(providerId, modelId, thinkingJson);
}

function seedWorkspaceAndDef(defId: string, providerId: string, modelName: string, thinkingJson: string | null): void {
  getDb().prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES ('ws-1', 'WS', '', '/tmp', 0, '@owner:s', 'X')`,
  ).run();
  getDb().prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills,
        source, description, icon_emoji, model_provider_id, model_name, task_driven, thinking_json)
     VALUES (?, 'T', 't', '1', 'declarative', 'p', '[]', '[]', '[]', 'custom', 'd', 'X', ?, ?, 1, ?)`,
  ).run(defId, providerId, modelName, thinkingJson);
}

function makeDef(
  defId: string,
  providerId: string,
  modelName: string,
  thinkingJson?: AgentDefinition['thinkingJson'],
): AgentDefinition {
  return {
    id: defId, name: 'T', slug: 't', version: '1', runtime: 'declarative', systemPrompt: 'p',
    defaultTools: [], defaultMcps: [], defaultSkills: [], source: 'custom', description: '',
    iconEmoji: 'X', workspaceId: null, modelProviderId: providerId, modelName, thinkingJson,
  };
}

describe('resolveThinkingConfig：配置 fallback 与方言', () => {
  it('无任何配置 → auto；预设供应商方言来自 preset；能力来自预设表', () => {
    seedProvider('p1', 'openai', 'zhipu');
    const p = getProvider('p1') as ModelProvider;
    expect(resolveThinkingConfig(makeDef('d1', 'p1', 'glm-5.3'), p)).toEqual({
      wire: 'toggle-effort', kind: 'effort', mode: 'auto', effort: null,
    });
  });

  it('模型级 thinking_json 生效；agent 级覆盖模型级', () => {
    seedProvider('p2', 'openai', 'zhipu');
    seedModelThinking('p2', 'glm-5.3', JSON.stringify({ mode: 'on', effort: 'low' }));
    const p = getProvider('p2') as ModelProvider;
    const base = makeDef('d2', 'p2', 'glm-5.3');
    expect(resolveThinkingConfig(base, p).mode).toBe('on');
    expect(resolveThinkingConfig(base, p).effort).toBe('low');
    const override = makeDef('d2', 'p2', 'glm-5.3', { mode: 'off', effort: null });
    expect(resolveThinkingConfig(override, p).mode).toBe('off');
  });

  it('effort 越界回退模型 default；kimi-k3 模型级方言覆写生效', () => {
    seedProvider('p3', 'openai', 'moonshot');
    seedModelThinking('p3', 'kimi-k3', JSON.stringify({ mode: 'on', effort: 'ultra' }));
    const req = resolveThinkingConfig(makeDef('d3', 'p3', 'kimi-k3'), getProvider('p3') as ModelProvider);
    expect(req.wire).toBe('effort');
    expect(req.effort).toBe('max'); // 越界 'ultra' → default 'max'
  });

  it('toggle 模型 on 不带 effort；能力=none 时 kind 透传', () => {
    seedProvider('p4', 'openai', 'zhipu');
    seedModelThinking('p4', 'glm-4.6', JSON.stringify({ mode: 'on', effort: 'whatever' }));
    const req = resolveThinkingConfig(makeDef('d4', 'p4', 'glm-4.6'), getProvider('p4') as ModelProvider);
    expect(req).toEqual({ wire: 'toggle-effort', kind: 'toggle', mode: 'on', effort: null });
  });

  it('自定义供应商：platform 兜底方言 + 正则目录能力', () => {
    seedProvider('p5', 'anthropic', null);
    expect(resolveThinkingConfig(makeDef('d5', 'p5', 'claude-sonnet-4-5'), getProvider('p5') as ModelProvider)).toEqual({
      wire: 'anthropic-budget', kind: 'effort', mode: 'auto', effort: null,
    });
    seedProvider('p6', 'openai', null);
    expect(resolveThinkingConfig(makeDef('d6', 'p6', 'glm-4.6'), getProvider('p6') as ModelProvider)).toEqual({
      wire: 'effort', kind: 'toggle', mode: 'auto', effort: null,
    });
  });
});

describe('spawn 透传：buildSpawnOpts → AGENT_CONFIG → parseConfig', () => {
  it('thinking 随 opts 定型，线协议往返保持', async () => {
    seedProvider('p7', 'openai', 'deepseek');
    seedModelThinking('p7', 'deepseek-v4-pro', JSON.stringify({ mode: 'on', effort: 'high' }));
    seedWorkspaceAndDef('d7', 'p7', 'deepseek-v4-pro', null);

    const opts = await buildSpawnOpts({
      instanceId: 'inst1', agentUserId: 'agent-t-ab12cd', workspaceId: 'ws-1',
      workspaceDir: '/tmp', def: makeDef('d7', 'p7', 'deepseek-v4-pro'), llmApiKey: 'k',
    });
    expect(opts.thinking).toEqual({ wire: 'toggle-effort', kind: 'effort', mode: 'on', effort: 'high' });

    const config = parseConfig(JSON.parse(JSON.stringify(opts)));
    expect(config.thinking).toEqual({ wire: 'toggle-effort', kind: 'effort', mode: 'on', effort: 'high' });
  });

  it('旧 AGENT_CONFIG 无 thinking 字段 / 非法结构 → undefined（兼容 + fail-safe）', async () => {
    seedProvider('p8', 'openai', null);
    seedWorkspaceAndDef('d8', 'p8', 'gpt-4o', null);
    const opts = await buildSpawnOpts({
      instanceId: 'inst1', agentUserId: 'agent-t-ab12cd', workspaceId: 'ws-1',
      workspaceDir: '/tmp', def: makeDef('d8', 'p8', 'gpt-4o'), llmApiKey: 'k',
    });
    const wire = JSON.parse(JSON.stringify(opts)) as Record<string, unknown>;
    delete wire.thinking;
    expect(parseConfig(wire).thinking).toBeUndefined();
    expect(parseConfig({ ...wire, thinking: { wire: 'bad' } }).thinking).toBeUndefined();
  });
});
