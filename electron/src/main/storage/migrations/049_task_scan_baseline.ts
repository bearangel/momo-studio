// electron/src/main/storage/migrations/049_task_scan_baseline.ts
//
// Migration 049：任务起点扫描基线两表（未入账变更误归因根治，2026-09-29）。
//
// 背景：detector.scanUnjournaled 的 git 侧是「自上次 commit 的累计脏」，
// 账本侧是「本任务条目」——历史脏文件（任务开始前就已脏的文件）被误归因到
// 每个任务。根治法：任务首次进入 in_progress 时捕获「起点基线」（当时全部
// 脏路径 + 内容 sha256），扫描时对候选路径做基线差集归因（不在基线 = 任务
// 期间新脏；在基线且 hash 相同 = 历史脏未动，剔除；hash 不同 = 任务期间
// 再改动，列入）。
//
// 两表职责：
//   - task_scan_baseline：meta 行（每 (workspace, task) 一行）。行存在即
//     「有基线」——零脏工作区的合法空基线也有 meta 行，与「无基线」（无行）
//     可区分。degraded=1 表示捕获时 git 异常的降级基线（无 path 行，扫描
//     回退累计差集）。
//   - task_scan_baseline_path：脏路径行。content_hash 为 sha256 hex；
//     NULL = 捕获时文件不可读（已删除等）。
//
// 键契约（生产者 task/starter.ts + task/lifecycle.ts → journal/baseline.ts；
// 消费者 journal/detector.ts）：path 为 workspace 根相对 POSIX 形态，
// 与 detector 变更集同口径；content_hash 用 recorder.hashContent（sha256）。
//
// down 为真 DROP（模块内供测试直调；迁移数组只接 .up，042/048 同款约定）。

export interface Migration049 {
  version: number;
  up: string;
  down: string;
}

export const migration049: Migration049 = {
  version: 49,
  up: `
    -- 任务起点基线 meta 行：行存在即有基线（空基线与无基线可区分）
    CREATE TABLE IF NOT EXISTS task_scan_baseline (
      workspace_id TEXT NOT NULL,
      task_id      TEXT NOT NULL,
      captured_at  INTEGER NOT NULL,
      degraded     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, task_id)
    );

    -- 任务起点基线脏路径行：path 为 workspace 根相对 POSIX；
    -- content_hash = sha256 hex，NULL = 捕获时不可读
    CREATE TABLE IF NOT EXISTS task_scan_baseline_path (
      workspace_id TEXT NOT NULL,
      task_id      TEXT NOT NULL,
      path         TEXT NOT NULL,
      content_hash TEXT,
      PRIMARY KEY (workspace_id, task_id, path)
    );
  `.trim(),
  down: `
    DROP TABLE IF EXISTS task_scan_baseline_path;
    DROP TABLE IF EXISTS task_scan_baseline;
  `.trim(),
};
