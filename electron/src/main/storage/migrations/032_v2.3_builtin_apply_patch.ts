// electron/src/main/storage/migrations/032_v2.3_builtin_apply_patch.ts
//
// v2.3 Migration v32：builtin agent defaultTools 同步 apply_patch。
//
// ⚠️ 与 brief 草稿的差异（保真修正，两者必居其一都会炸真实库）：
//   1. 列名是 default_tools（migration v3 建列，真实 schema 无 default_tools_json 列）；
//   2. 列内 JSON 是对象数组 [{"kind":"builtin","ref":"..."}]（crud.ts rowToDef 反序列化
//      为 ToolRef[]），不能插入裸字符串 'apply_patch'——否则能力白名单解析全线崩。
//
// 追加用 json_insert '$[#]'（数组末尾追加，保留既有顺序）；刻意不用
// json_each + UNION + json_group_array 重建——json_group_array 对 TEXT 入参会
// 二次编码成字符串，对象条目会被悄悄改写成转义字符串（数据损坏）。
// 幂等：NOT EXISTS 守卫（brief 指定模式）——已含 apply_patch 的行不再命中。

export interface Migration032 {
  version: number;
  up: string;
  down: string;
}

export const migration032: Migration032 = {
  version: 32,
  up: `
    -- builtin agent defaultTools 扩展：追加 apply_patch（若缺失）。
    -- json_extract(value, '$.ref')：default_tools 存 {kind, ref} 对象数组，
    -- 命中判定看 ref 字段而非整个元素。
    UPDATE agent_definitions
    SET default_tools = json_insert(
      default_tools,
      '$[#]',
      json_object('kind', 'builtin', 'ref', 'apply_patch')
    )
    WHERE source = 'builtin'
      AND NOT EXISTS (
        SELECT 1 FROM json_each(default_tools)
        WHERE json_extract(json_each.value, '$.ref') = 'apply_patch'
      );
  `.trim(),
  down: `
    -- 不主动清理 apply_patch（forward-only）
    SELECT 1;
  `.trim(),
};
