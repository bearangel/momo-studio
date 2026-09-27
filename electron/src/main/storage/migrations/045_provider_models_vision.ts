// electron/src/main/storage/migrations/045_provider_models_vision.ts
//
// Migration 045：provider_models 加 vision 列（2026-09-26 图片输入多模态
// spec §3.3 用户自建模型能力覆盖）。
//
// 语义：vision 是 (provider, model) 级布尔能力，用户可在模型编辑 UI 双向
// 覆盖预设表（PresetModel.vision）。解析链（spawn-helpers
// resolveVisionCapability 单点）：provider_models.vision → PresetModel.vision
// → false。
//
// 回填：045 之前已种库的预设模型行经 ALTER 补的 DEFAULT 0 会被解析链当作
// 「用户显式关闭」——与预设真相（如 gpt-4o vision=true）相悖。故 up 附带
// 一次按 (preset_key, model_id) 对的回填 UPDATE，把旧库种子行对齐预设表。
//
// 预设对清单刻意内嵌为本模块常量（与 index.ts BUILTIN_TOOL_REFS 同款约定：
// migration SQL 必须是自包含纯字符串，不 import provider-presets）；与
// provider-presets.ts 的一致性由 spawn-helpers-vision.test.ts 防漂移守卫锁定
// （增删 vision 条目时两处同步改）。
//
// down 为真 DROP COLUMN（SQLite ≥ 3.35 支持，沿用 040 模式；模块内供测试
// 直调，迁移数组只接 .up）。

export interface Migration045 {
  version: number;
  up: string;
  down: string;
}

/**
 * 预设表中 vision=true 的 (preset_key, model_id) 全集（2026-09-26 spec §3.1）。
 * 导出供 spawn-helpers-vision.test.ts 与 provider-presets.ts 交叉核对。
 */
export const MIGRATION045_PRESET_VISION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['zhipu', 'glm-5.3'],
  ['zhipu', 'glm-4.6v'],
  ['zhipu', 'glm-4.6v-flash'],
  ['deepseek', 'deepseek-v4-flash'],
  ['moonshot', 'kimi-k3'],
  ['moonshot', 'kimi-k2.6'],
  ['dashscope', 'qwen3-max'],
  ['dashscope', 'qwen-plus'],
  ['volcano-ark', 'doubao-seed-1-6-250615'],
  ['volcano-ark', 'doubao-seed-1-6-flash-250615'],
  ['openai', 'gpt-5.2'],
  ['openai', 'gpt-5.1'],
  ['openai', 'gpt-5-mini'],
  ['openai', 'gpt-4.1'],
  ['openai', 'gpt-4o'],
  ['anthropic', 'claude-opus-4-5'],
  ['anthropic', 'claude-sonnet-4-5'],
  ['anthropic', 'claude-haiku-4-5'],
  ['gemini', 'gemini-3.1-pro-preview'],
  ['gemini', 'gemini-3-flash-preview'],
  ['xai', 'grok-4.6'],
  ['mistral', 'magistral-medium-latest'],
  ['groq', 'qwen/qwen3.8-27b'],
];

/** 内嵌对 → SQL VALUES 字面量（key/model 均为安全 ASCII 标识符，无引号转义需求） */
const PAIRS_SQL = MIGRATION045_PRESET_VISION_PAIRS.map(
  ([k, m]) => `('${k}', '${m}')`,
).join(', ');

export const migration045: Migration045 = {
  version: 45,
  up: `
    -- 用户级 vision 覆盖位（0=关闭/未知，1=开启）；行值双向压过预设表
    ALTER TABLE provider_models ADD COLUMN vision INTEGER NOT NULL DEFAULT 0;

    -- 旧库回填：既有预设种子行按 (preset_key, model_id) 对齐预设表 vision=true
    WITH preset_vision(preset_key, model_id) AS (VALUES ${PAIRS_SQL})
    UPDATE provider_models SET vision = 1
    WHERE rowid IN (
      SELECT pm.rowid FROM provider_models pm
      JOIN model_providers mp ON mp.id = pm.provider_id
      JOIN preset_vision v ON v.preset_key = mp.preset_key AND v.model_id = pm.model_id
    );
  `.trim(),
  down: `
    ALTER TABLE provider_models DROP COLUMN vision;
  `.trim(),
};
