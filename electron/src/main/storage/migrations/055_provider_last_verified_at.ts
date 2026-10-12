// 055_provider_last_verified_at.ts
//
// model_providers 加 last_verified_at 列（走查 2026-10-12 D7）。
//
// 背景：设置页允许不验证直接保存供应商（与引导页「验证通过才创建」策略
// 不一致）——假 key 静默入库，直到首条消息才爆 401。加列记录最近一次
// 「检查连接 / 验证并继续」成功时刻；NULL = 从未验证，UI 挂「未验证」
// warning 徽标（不禁保存，风险可见即可）。存量行全 NULL = 默认未验证，
// 用户验证一次即消。

export interface Migration055 {
  version: number;
  up: string;
}

export const migration055: Migration055 = {
  version: 55,
  up: `
-- v55：供应商最近验证时刻（NULL = 从未验证，UI 显示「未验证」徽标）
ALTER TABLE model_providers ADD COLUMN last_verified_at TEXT;
`,
};
