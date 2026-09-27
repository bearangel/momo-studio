// 迁移 046：provider_models.vision 三态化（2026-09-26 图片识别 P0 修复）
//
// 背景：045 引入的 vision 列是 NOT NULL DEFAULT 0，导致两类误判——
//   1. 聚合商标题行（如 zai-org/GLM-5.3，用户加模型时的列默认值 0）被
//      resolveVisionCapability 当作「用户显式关闭」，即便模型本身多模态；
//   2. 预设表未来 vision 翻转（false→true）无法传导到已种子行（T2 评审遗留项）。
// 语义修正为三态：1=用户显式开 / 0=用户显式关 / NULL=未决定（回退预设表）。
//
// SQLite 不能 ALTER 列的 NOT NULL/DEFAULT——走建新表-拷贝-替换。
// 拷贝映射：旧 1 → 1（显式开保留）；旧 0 → NULL（列默认值不是用户意愿，
// 「视觉输入」开关与 045 回填是仅有的两个 1 来源，其余 0 一律未决定）。
// 用户在开关上线（2026-09-26 当天）后手动关过某模型的极小概率误归 NULL
// 可接受——重开一次开关即恢复显式关。
export const migration046 = {
  version: 46,
  up: `
CREATE TABLE provider_models_v046 (
  provider_id TEXT NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  added_at INTEGER NOT NULL,
  context_window INTEGER,
  thinking_json TEXT,
  vision INTEGER,
  PRIMARY KEY (provider_id, model_id)
);
INSERT INTO provider_models_v046 (provider_id, model_id, enabled, added_at, context_window, thinking_json, vision)
  SELECT provider_id, model_id, enabled, added_at, context_window, thinking_json,
         CASE WHEN vision = 1 THEN 1 ELSE NULL END
  FROM provider_models;
DROP TABLE provider_models;
ALTER TABLE provider_models_v046 RENAME TO provider_models;
  `.trim(),
  down: `
    -- 三态化不可逆（NULL 语义无法映射回 0/1 二值）；回滚 = 恢复 045 二值列
    ALTER TABLE provider_models RENAME TO provider_models_v046_broken;
  `.trim(),
};
