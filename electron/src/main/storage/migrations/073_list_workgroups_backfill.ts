// electron/src/main/storage/migrations/073_list_workgroups_backfill.ts
// 1.10.1 agent 工作组路由面：list_workgroups（只读发现工具）并入公共默认集
// ——052 同式只加不减幂等回填。病灶（2026-11-09 会话实测）：工具以
// defaultOn:false 上线，存量 agent 定义的 default_tools 无此条 → 工具对
// 全部存量 agent 不可见（agent 自己的 todo 里写「无 list_workgroups 工具可查」），
// 用户重启也无感。defaultOn:true + 本迁移双改（新定义走 SAFE_MINIMUM_TOOLS、
// 存量定义走本回填）。名单与 catalog 一致性由 073 测试锁（回填后含 list_workgroups）。
import type { Migration } from './index';

const TOOL_REF = 'list_workgroups';

export const migration073: Migration = {
  version: 73,
  sql: `
-- 1.10.1 list_workgroups 公共默认集加法回填（只加不减，幂等）
UPDATE agent_definitions AS ad
SET default_tools = COALESCE((
  SELECT json_group_array(json_object('kind', 'builtin', 'ref', ref))
  FROM (
    SELECT DISTINCT ref FROM (
      SELECT json_extract(j.value, '$.ref') AS ref
      FROM json_each(COALESCE(ad.default_tools, '[]')) AS j
      WHERE json_extract(j.value, '$.ref') IS NOT NULL
      UNION
      SELECT '${TOOL_REF}' AS ref
    )
  )
), '[]')
`,
};
