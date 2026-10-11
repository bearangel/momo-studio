// 054_global_tool_budget_default_50.ts
//
// 全局工具调用上限默认值 10 → 50（2026-10-10 软续期特性配套）。
//
// 背景：DEFAULT_MAX_TOOL_CALLS 常量已改为 50，但 updateGlobalSettings 的
// 读改写合并会把当时默认值 10 烤进 kv_store 的 global_settings JSON——
// 从未显式配置过预算的存量库也带着 maxToolCalls=10，仅改常量对它们不生效。
//
// 升级语义：只把「旧默认值痕迹」（=10）升为新默认 50；用户显式自定义的
// 其他值（20/100/-1/0）一律不动。误伤面 = 显式选择恰为 10 的用户——
// 10 是旧默认值，几乎不存在显式选择它的场景（可经设置页改回）。

export interface Migration054 {
  version: number;
  up: string;
}

export const migration054: Migration054 = {
  version: 54,
  up: `
-- v54：全局工具预算默认 10 → 50（仅升级旧默认痕迹，显式自定义值不动）
UPDATE kv_store
SET value = json_set(value, '$.maxToolCalls', 50)
WHERE key = 'global_settings'
  AND json_extract(value, '$.maxToolCalls') = 10;
`,
};
