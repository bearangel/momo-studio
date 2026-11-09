// 075_global_tool_budget_default_unlimited.ts
//
// 全局工具调用上限默认值 50 → -1 无限（2026-11-09 设置优化）。
//
// 背景：DEFAULT_MAX_TOOL_CALLS 常量已改为 -1，但 updateGlobalSettings 的
// 读改写合并会把当时默认值 50 烤进 kv_store 的 global_settings JSON——
// 从未显式配置过预算的存量库也带着 maxToolCalls=50，仅改常量对它们不生效。
//
// 升级语义：只把「旧默认值痕迹」（=50）升为新默认 -1；用户显式自定义的
// 其他值（20/100/0/-1）一律不动。误伤面 = 显式选择恰为 50 的用户——
// 50 是旧默认值，显式选它多来自「旧默认照抄」场景（可经设置页改回）。

export interface Migration075 {
  version: number;
  up: string;
}

export const migration075: Migration075 = {
  version: 75,
  up: `
-- v75：全局工具预算默认 50 → -1 无限（仅升级旧默认痕迹，显式自定义值不动）
UPDATE kv_store
SET value = json_set(value, '$.maxToolCalls', -1)
WHERE key = 'global_settings'
  AND json_extract(value, '$.maxToolCalls') = 50;
`,
};
