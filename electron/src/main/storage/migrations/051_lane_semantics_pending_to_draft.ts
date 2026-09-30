// electron/src/main/storage/migrations/051_lane_semantics_pending_to_draft.ts
//
// Migration 051：泳道语义重构（spec docs/specs/2026-09-30-board-lane-semantics-design.md §4.5）。
//
// 两件事：
//   - UPDATE tasks SET status='draft' WHERE status='pending'——pending 状态退役
//     （定时不再经 pending 中转：「启动」直接入队 assigned + scheduled_at，
//     由 executor 闸门表达「排队中等到点」）。带定时存量 scheduled_at 原样
//     保留，用户启动时闸门消费（过去时间立即跑，未来时间等到点）。
//   - DROP COLUMN board_position——迁移 050 上线事故补救：050 的 up 中
//     tx-wrapped DROP 语句因脚本事故丢失，且 050 已按 ADD-only 版本应用到
//     存量库（schema_migrations 已记录版本 50 不会重跑）；DROP 收敛到本迁移，
//     新库（047 建列 → 051 删）与存量库（列残留 → 051 删）统一愈合。
//
// down 为反向重建（模块内供测试直调；迁移数组只接 .up，042-050 同款约定）。
// 显式事务包裹沿 050 纪律：DROP COLUMN 的隐式自事务表重建路径在
// better-sqlite3 + worker_threads（vitest threads 池）下会放大 SIGSEGV 概率。

export interface Migration051 {
  version: number;
  up: string;
  down: string;
}

export const migration051: Migration051 = {
  version: 51,
  up: `
    BEGIN;
    UPDATE tasks SET status='draft' WHERE status='pending';
    ALTER TABLE tasks DROP COLUMN board_position;
    COMMIT;
  `,
  down: `
    ALTER TABLE tasks ADD COLUMN board_position REAL;
    UPDATE tasks SET status='pending' WHERE status='draft' AND scheduled_at IS NOT NULL;
  `,
};
