// electron/src/main/storage/migrations/044_session_file_reads.ts
//
// Migration 044：session_file_reads 表（2026-09-26 Read-before-Edit 会话级
// 持久化 + 内容指纹守门）。
//
// 背景：读账本原为主进程内存态、按 streamSessionId（回合）划分——每个新回合
// 清零、app 重启全丢，而对话上下文跨回合/跨重启延续，agent「以为读过」→
// 编辑被高频误拒；同时纯集合判定读后漂移（bash/外部改动）不设防。
//
// 方案：读记录按 session 持久化（跨回合/跨重启有效），附读取时内容 sha1
// 指纹——编辑时当前指纹不匹配则拦截并要求重读（把仪式性守门升级为防漂移
// 守门）。子 agent 读取不解锁编辑（fresh-session 语义由 tracker 层保证）。
//
// down 为真 DROP TABLE（模块内供测试直调；迁移数组只接 .up）。

export interface Migration044 {
  version: number;
  up: string;
  down: string;
}

export const migration044: Migration044 = {
  version: 44,
  up: `
    CREATE TABLE IF NOT EXISTS session_file_reads (
      session_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      read_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, path)
    );
  `.trim(),
  down: `
    DROP TABLE IF EXISTS session_file_reads;
  `.trim(),
};
