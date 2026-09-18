// electron/src/main/storage/migrations/037_v2_1_office_tools_builtin.ts
//
// v2.1 Migration 037：builtin agent defaultTools 同步 office 八工具。
//
// 模式与 v32（032_v2.3_builtin_apply_patch.ts）完全一致：
//   - 列名 default_tools，JSON 对象数组 [{"kind":"builtin","ref":"..."}]
//   - json_insert '$[#]' 末尾追加（不用 json_group_array 重建——会对 TEXT 二次
//     编码损坏数据）
//   - NOT EXISTS 守卫幂等（已含该 ref 的行不再命中）
//
// 仅追加 source='builtin' 行（custom 行不动）。down 不主动清理（forward-only）。

export interface Migration037 {
  version: number;
  up: string;
  down: string;
}

const OFFICE_TOOLS = [
  'office_read',
  'office_read_cells',
  'office_create_excel',
  'office_write_excel',
  'office_create_doc',
  'office_create_ppt',
  'office_create_pdf',
  'office_copy',
] as const;

export const migration037: Migration037 = {
  version: 37,
  up: `
    -- builtin agent defaultTools 扩展：追加 office 八工具（若缺失）。
    -- json_extract(value, '$.ref')：default_tools 存 {kind, ref} 对象数组，
    -- 命中判定看 ref 字段而非整个元素。
${OFFICE_TOOLS.map(
  (tool) => `    UPDATE agent_definitions
    SET default_tools = json_insert(
      default_tools,
      '$[#]',
      json_object('kind', 'builtin', 'ref', '${tool}')
    )
    WHERE source = 'builtin'
      AND NOT EXISTS (
        SELECT 1 FROM json_each(default_tools)
        WHERE json_extract(json_each.value, '$.ref') = '${tool}'
      );`,
).join('\n')}
  `.trim(),
  down: `
    -- 不主动清理 office 工具（forward-only）
    SELECT 1;
  `.trim(),
};
