// 076_browser_evaluate_default_on.ts
//
// 浏览器页面脚本执行（browser_evaluate）默认关闭 → 开启（2026-11-09 设置优化）。
//
// 背景：DEFAULT_BROWSER_SETTINGS.evaluateEnabled 已改为 true，但
// workspace_settings 的行由浏览器设置 store 全列读改写落库——任何一次浏览器
// 设置保存（含侧栏折叠/宽度）都会把当时的默认 false 烤进
// browser_evaluate_enabled=0。仅改常量对已有行的工作空间不生效。
//
// 升级语义：0 → 1 全量翻转。0 大概率是「从未动过」（旧默认值烤入）而非
// 「主动关闭」——列默认 0 时代两者不可区分；主动关闭过的用户重开一次即可。
// （workspace_settings 仅浏览器设置一个写入方，无其他子系统误伤面。）

export interface Migration076 {
  version: number;
  up: string;
}

export const migration076: Migration076 = {
  version: 76,
  up: `
-- v76：浏览器页面脚本执行默认 0 → 1（evaluate 开关默认开启）
UPDATE workspace_settings
SET browser_evaluate_enabled = 1
WHERE browser_evaluate_enabled = 0;
`,
};
