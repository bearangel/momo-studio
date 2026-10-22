// electron/src/main/storage/migrations/068_session_group_color.ts
//
// 会话分组组色列（预览 A rev2 批准定值，spec 2026-10-22 §4.4 组色系统）：
// 存量组按 (position, created_at, id) 序 6 色轮转回填；此后建组由 repo 定值，不再推断。
export const version = 68;
export const up = `
ALTER TABLE session_groups ADD COLUMN color TEXT NULL;
UPDATE session_groups SET color = CASE
  ((SELECT COUNT(*) FROM session_groups g2
    WHERE (g2.position, g2.created_at, g2.id) <= (session_groups.position, session_groups.created_at, session_groups.id)) - 1) % 6
  WHEN 0 THEN '#5E6AD2' WHEN 1 THEN '#23835C' WHEN 2 THEN '#B7791F'
  WHEN 3 THEN '#D33F49' WHEN 4 THEN '#6E56CF' ELSE '#3E8F8C' END;
`;
