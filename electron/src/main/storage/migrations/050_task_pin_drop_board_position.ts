// electron/src/main/storage/migrations/050_task_pin_drop_board_position.ts
//
// Migration 050：看板顶置字段 + 手动排序退役（2026-09-30 预览确认的设计）。
//
// 背景：boardPosition 手动排序对用户不可见（「哪些任务被拖过」无任何线索），
// 新建任务落位不可预期、查找成本高。排序模型收敛为：
//   顶置组（pinned_at 倒序，最近 pin 的最顶）→ 未顶置组（created_at 倒序）
// 顶置 = 卡片右键「顶置/取消顶置」（全状态可用），拖拽只保留跨列状态流转
// 与跨泳道换组，同列同组拖动 no-op。
//
// 两件事：
//   - ADD COLUMN pinned_at INTEGER（NULL=未顶置；pin 时写 Date.now()，
//     排序键即 pin 时间）
//   - DROP COLUMN board_position——上线事故修正：本迁移 up 中的
//     tx-wrapped DROP 语句因脚本事故丢失，且已按 ADD-only 版本应用到
//     存量库（版本 50 已记录不可重跑）；DROP 实际由迁移 051 执行
//     （新库/存量库统一愈合），本文件 up 如实只含 ADD。
//
// down 为反向重建（模块内供测试直调；迁移数组只接 .up，042-049 同款约定）。

export interface Migration050 {
  version: number;
  up: string;
  down: string;
}

export const migration050: Migration050 = {
  version: 50,
  up: `
    ALTER TABLE tasks ADD COLUMN pinned_at INTEGER;
    -- DROP COLUMN 显式事务包裹：SQLite 隐式自事务的表重建路径在
    -- better-sqlite3 + worker_threads（vitest threads 池）下确定性触发
    -- SIGSEGV（provider-crud.test 单文件可稳定复现；显式 BEGIN/COMMIT
    -- 避开该路径，2026-09-30 实测）
  `,
  down: `
    ALTER TABLE tasks ADD COLUMN board_position REAL;
    ALTER TABLE tasks DROP COLUMN pinned_at;
  `,
};
