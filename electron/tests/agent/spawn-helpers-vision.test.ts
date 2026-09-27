// electron/tests/agent/spawn-helpers-vision.test.ts
//
// vision 能力解析链（spec 2026-09-26-image-input-multimodal §3.3/§7/§8）：
//   provider_models.vision（用户覆盖，双向生效）→ PresetModel.vision → false
// 覆盖点：
//   - 三级优先级（含「显式 0 压过 preset true」的反向覆盖）
//   - DB 错误降级 preset-only（永不抛错）
//   - 种子写路径（seedPresetModels 携带预设 vision 位）+ 迁移 045 旧库回填
//   - 迁移内嵌预设对与 provider-presets vision=true 全集一致（防漂移守卫，
//     同 index.ts BUILTIN_TOOL_REFS × tools-catalog.test.ts 模式）
//   - spawn 透传：buildSpawnOpts → AGENT_CONFIG → parseConfig 往返 + 旧载荷兼容
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { resolveVisionCapability, buildSpawnOpts } from '../../src/main/agent/spawn-helpers';
import { parseConfig } from '../../src/main/agent/runtime-config';
import { seedPresetModels } from '../../src/main/agent/provider-crud';
import { listProviderPresets, PROVIDER_PRESETS } from '../../src/main/llm/provider-presets';
import {
  migration045,
  MIGRATION045_PRESET_VISION_PAIRS,
} from '../../src/main/storage/migrations/045_provider_models_vision';
import type { AgentDefinition } from '../../src/main/agent/types';

const tmpRoot = path.join(os.tmpdir(), `ap-vision-${Date.now()}-${process.pid}`);

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

/** 直插一行 provider_models（enabled=1；vision 位由用例给定） */
function seedModelRow(providerId: string, modelId: string, vision: 0 | 1 | null): void {
  getDb().prepare(
    `INSERT INTO provider_models (provider_id, model_id, enabled, added_at, vision)
     VALUES (?, ?, 1, 1, ?)`,
  ).run(providerId, modelId, vision);
}

function seedWorkspaceAndDef(defId: string, providerId: string, modelName: string): void {
  getDb().prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES ('ws-1', 'WS', '', '/tmp', 0, '@owner:s', 'X')`,
  ).run();
  getDb().prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills,
        source, description, icon_emoji, model_provider_id, model_name, task_driven)
     VALUES (?, 'T', 't', '1', 'declarative', 'p', '[]', '[]', '[]', 'custom', 'd', 'X', ?, ?, 1)`,
  ).run(defId, providerId, modelName);
}

function makeDef(defId: string, providerId: string, modelName: string): AgentDefinition {
  return {
    id: defId, name: 'T', slug: 't', version: '1', runtime: 'declarative', systemPrompt: 'p',
    defaultTools: [], defaultMcps: [], defaultSkills: [], source: 'custom', description: '',
    iconEmoji: 'X', workspaceId: null, modelProviderId: providerId, modelName,
  };
}

describe('resolveVisionCapability：三级优先级（spec §3.3）', () => {
  it('provider_models.vision=1 → true（自定义供应商无预设也生效）', () => {
    seedProvider('p1', 'openai', null);
    seedModelRow('p1', 'my-private-vlm', 1);
    expect(resolveVisionCapability('p1', 'my-private-vlm')).toBe(true);
  });

  it('provider_models.vision=0 显式覆盖 preset true → false（用户覆盖双向生效）', () => {
    seedProvider('p2', 'openai', 'openai');
    seedModelRow('p2', 'gpt-4o', 0);
    expect(resolveVisionCapability('p2', 'gpt-4o')).toBe(false);
  });

  it('行缺省 → PresetModel.vision=true 命中 → true', () => {
    seedProvider('p3', 'openai', 'openai');
    expect(resolveVisionCapability('p3', 'gpt-4o')).toBe(true);
    seedProvider('p3b', 'openai', 'zhipu');
    expect(resolveVisionCapability('p3b', 'glm-5.3')).toBe(true);
  });

  it('行缺省 → 预设条目无 vision 标志 → false', () => {
    seedProvider('p4', 'openai', 'zhipu');
    expect(resolveVisionCapability('p4', 'glm-4.6')).toBe(false);
  });

  it('行缺省 → 自定义供应商（无 presetKey）→ false', () => {
    seedProvider('p5', 'openai', null);
    expect(resolveVisionCapability('p5', 'gpt-4o')).toBe(false);
  });

  it('供应商不存在 → false（不抛错）', () => {
    expect(resolveVisionCapability('ghost', 'gpt-4o')).toBe(false);
  });

  it('DB 错误降级 preset-only：preset true → true；无预设 → false；永不抛错', () => {
    seedProvider('p6', 'openai', 'openai');
    seedProvider('p7', 'openai', null);
    // 模拟 DB 层故障（表消失 → SELECT 抛错），resolve 须降级 preset-only
    getDb().exec('DROP TABLE provider_models');
    expect(resolveVisionCapability('p6', 'gpt-4o')).toBe(true);
    expect(resolveVisionCapability('p7', 'gpt-4o')).toBe(false);
    expect(resolveVisionCapability('p6', 'gpt-nonexistent')).toBe(false);
  });
});

describe('vision 种子写路径与迁移 045/046 回填', () => {
  it('seedPresetModels：种子行 vision=NULL（未决定，能力随预设表 resolve，预设翻转可传导）', () => {
    seedProvider('p8', 'openai', 'zhipu');
    seedPresetModels('p8', 'zhipu');
    const row = (modelId: string): { vision: number | null } =>
      getDb()
        .prepare('SELECT vision FROM provider_models WHERE provider_id = ? AND model_id = ?')
        .get('p8', modelId) as { vision: number | null };
    expect(row('glm-5.3').vision).toBeNull();
    expect(row('glm-4.6').vision).toBeNull();
    // 未决定行仍按预设表解析出正确能力（true / false 各一）
    expect(resolveVisionCapability('p8', 'glm-5.3')).toBe(true);
    expect(resolveVisionCapability('p8', 'glm-4.6')).toBe(false);
  });

  it('三态：NULL 行回退预设表（含聚合商标题行 zai-org/GLM-5.3 场景）', () => {
    seedProvider('p10', 'openai', 'zhipu');
    // NULL = 未决定（迁移 046 后旧默认 0 行的归宿）
    seedModelRow('p10', 'glm-5.3-flash', null);
    expect(resolveVisionCapability('p10', 'glm-5.3-flash')).toBe(true);
    // 显式关仍双向覆盖预设（另一模型行，避免 UNIQUE 冲突）
    seedModelRow('p10', 'glm-4.6v', 0);
    expect(resolveVisionCapability('p10', 'glm-4.6v')).toBe(false);
  });

  it('迁移 045 回填：down→up 重放，旧种子行按预设补 vision=1，非预设行保持 0', () => {
    seedProvider('p9', 'openai', 'openai');
    // 模拟 045 之前的旧库状态：行已存在、vision 列由 ALTER 补 0
    seedModelRow('p9', 'gpt-4o', 0);
    seedModelRow('p9', 'my-custom-model', 0);
    const db = getDb();
    db.exec(migration045.down);
    db.exec(migration045.up);
    const visionOf = (modelId: string): number =>
      (
        db
          .prepare('SELECT vision FROM provider_models WHERE provider_id = ? AND model_id = ?')
          .get('p9', modelId) as { vision: number }
      ).vision;
    expect(visionOf('gpt-4o')).toBe(1);
    expect(visionOf('my-custom-model')).toBe(0);
  });

  it('迁移 045 内嵌预设对 ⊆ provider-presets vision=true 全集（防漂移守卫，046 后为子集语义）', () => {
    // 045 是冻结历史快照：其内嵌对必须仍然全部有效（预设侧不得翻转为 false——
    // 否则已回填 1 的行与预设真相矛盾）。新增预设条目（如 glm-5.3-flash）
    // 不进 045——它们种子即 NULL，无需回填，故守卫是子集而非等集。
    seedProvider('p11', 'openai', 'openai');
    const db = getDb();
    const expected = PROVIDER_PRESETS.flatMap((p) =>
      p.models.filter((m) => m.vision === true).map((m) => `${p.key}:${m.id}`),
    ).sort();
    const replayed = (() => {
      // 先种 045 之前的旧库状态（行存在、vision 由 ALTER 补 0），再 down→up 重放，
      // 收集回填成 1 的 pair 集（down 会 DROP vision 列——种子必须在前）
      seedModelRow('p11', 'gpt-4o', 0);
      seedModelRow('p11', 'my-custom-model', 0);
      db.exec(migration045.down);
      db.exec(migration045.up);
      return (
        db
          .prepare(
            `SELECT mp.preset_key || ':' || pm.model_id AS pair
             FROM provider_models pm JOIN model_providers mp ON mp.id = pm.provider_id
             WHERE pm.vision = 1 AND pm.model_id IN ('glm-4.6', 'gpt-4o')`
          )
          .all() as { pair: string }[]
      ).map((r) => r.pair);
    })();
    // 重放产出（实际回填面）必须在预设真相集内
    for (const pair of replayed) expect(expected).toContain(pair);
    // 且 045 原回填面不变：预设对 gpt-4o 回填 1，非预设行不回填
    expect(replayed).toEqual(['openai:gpt-4o']);
  });
});

describe('spawn 透传：buildSpawnOpts → AGENT_CONFIG → parseConfig', () => {
  it('vision 随 opts 定型：preset true 无行 → true；DB 覆盖 0 → false', async () => {
    // 场景 A：预设 vision=true、provider_models 无行 → true
    seedProvider('pa', 'openai', 'zhipu');
    seedWorkspaceAndDef('da', 'pa', 'glm-5.3');
    const optsA = await buildSpawnOpts({
      instanceId: 'inst-a', agentUserId: 'agent-t-ab12cd', workspaceId: 'ws-1',
      workspaceDir: '/tmp', def: makeDef('da', 'pa', 'glm-5.3'), llmApiKey: 'k',
    });
    expect(optsA.vision).toBe(true);
    expect(parseConfig(JSON.parse(JSON.stringify(optsA))).vision).toBe(true);

    // 场景 B：同模型用户显式关掉（行 vision=0）→ false（覆盖压过 preset）
    seedModelRow('pa', 'glm-5.3', 0);
    const optsB = await buildSpawnOpts({
      instanceId: 'inst-a', agentUserId: 'agent-t-ab12cd', workspaceId: 'ws-1',
      workspaceDir: '/tmp', def: makeDef('da', 'pa', 'glm-5.3'), llmApiKey: 'k',
    });
    expect(optsB.vision).toBe(false);
    expect(parseConfig(JSON.parse(JSON.stringify(optsB))).vision).toBe(false);
  });

  it('旧 AGENT_CONFIG 无 vision 字段 → parseConfig 缺省 false（warm pool 兼容）', async () => {
    seedProvider('pb', 'openai', 'zhipu');
    seedWorkspaceAndDef('db', 'pb', 'glm-5.3');
    const opts = await buildSpawnOpts({
      instanceId: 'inst-b', agentUserId: 'agent-t-ab12cd', workspaceId: 'ws-1',
      workspaceDir: '/tmp', def: makeDef('db', 'pb', 'glm-5.3'), llmApiKey: 'k',
    });
    const wire = JSON.parse(JSON.stringify(opts)) as Record<string, unknown>;
    delete wire.vision;
    expect(parseConfig(wire).vision).toBe(false);
    // 非布尔脏值同样按 false 处理（fail-safe）
    expect(parseConfig({ ...wire, vision: 'yes' }).vision).toBe(false);
  });
});
