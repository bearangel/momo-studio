// electron/src/main/audit/quota.ts
//
// 审计日志容量配额：字节估算 + 超限滚动删除。
//
// 估算公式：bytes = 文本列长度和 + rowCount × 400（行开销常数——SQLite 行头 +
// 索引 + B-tree 页摊销的量级近似，追求量级正确而非精确）。
//
// 配额优先级：workspaces.audit_quota_mb（v24 列）> global_settings.auditQuotaMb
// （默认 100）。超限时按 5000 行批次删 timestamp 最旧的记录，循环直至占用
// ≤ quota × 0.95——留 5% 滞回防抖动，避免占用贴线时每次写入都触发删除。

import { getDb } from '../storage/db';
import { getGlobalSettings } from '../settings/crud';

/** 单行固定开销估计（字节） */
const ROW_OVERHEAD_BYTES = 400;
/** 滚动删除批次大小：单条 DELETE 的 LIMIT，避免大事务长时间持锁 */
const DELETE_BATCH = 5000;
/** 滞回系数：删到配额的 95% 即停 */
const HYSTERESIS = 0.95;

interface AuditSizeRow {
  rowCount: number;
  textSum: number;
}

function querySize(workspaceId: string): AuditSizeRow {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS rowCount,
              COALESCE(SUM(LENGTH(tool_name) + LENGTH(input_summary)
                           + LENGTH(output_summary) + LENGTH(agent_bot_user_id)), 0) AS textSum
       FROM tool_calls WHERE workspace_id = ?`,
    )
    .get(workspaceId) as AuditSizeRow;
}

/** 估算某 workspace 的审计占用字节数（文本和 + 行数 × 400） */
export function estimateAuditBytes(workspaceId: string): number {
  const { rowCount, textSum } = querySize(workspaceId);
  return textSum + rowCount * ROW_OVERHEAD_BYTES;
}

/** 解析某 workspace 的生效配额（MB）：workspace 覆盖 > 全局设置 > 默认 100 */
export function resolveAuditQuotaMb(workspaceId: string): number {
  const ws = getDb()
    .prepare('SELECT audit_quota_mb AS quota FROM workspaces WHERE id = ?')
    .get(workspaceId) as { quota: number | null } | undefined;
  if (ws && typeof ws.quota === 'number' && ws.quota > 0) return ws.quota;
  // getGlobalSettings 内置 auditQuotaMb 默认 100（settings/crud.ts）
  return getGlobalSettings().auditQuotaMb;
}

/**
 * 设置 workspace 级配额（MB）。quotaMb = null 清除覆盖（回退全局）。
 * 非正数或 workspace 不存在时抛错（audit:setQuota IPC 直接透传给 renderer）。
 */
export function setAuditQuota(workspaceId: string, quotaMb: number | null): void {
  if (
    quotaMb !== null &&
    (typeof quotaMb !== 'number' || !Number.isFinite(quotaMb) || quotaMb <= 0)
  ) {
    throw new Error(`审计配额必须为正数（MB），收到：${String(quotaMb)}`);
  }
  const res = getDb()
    .prepare('UPDATE workspaces SET audit_quota_mb = ? WHERE id = ?')
    .run(quotaMb, workspaceId);
  if (res.changes === 0) {
    throw new Error(`workspace 不存在：${workspaceId}`);
  }
}

export interface AuditQuotaInfo {
  /** 生效配额（MB，已按 ws > 全局 > 默认 解析） */
  quotaMb: number;
  /** 估算占用字节数 */
  usedBytes: number;
  rowCount: number;
}

/** 读取配额与占用（audit:getQuota IPC 数据源） */
export function getAuditQuotaInfo(workspaceId: string): AuditQuotaInfo {
  const { rowCount } = querySize(workspaceId);
  return {
    quotaMb: resolveAuditQuotaMb(workspaceId),
    usedBytes: estimateAuditBytes(workspaceId),
    rowCount,
  };
}

/**
 * 执行滚动删除：占用超配额（> quotaMb MB）时按批次删最旧记录，直至 ≤ 95% 配额。
 * 返回本次删除的行数；未超限返回 0。batchSize 仅为可测试性暴露，生产路径恒为 5000。
 */
export function enforceAuditQuota(workspaceId: string, batchSize: number = DELETE_BATCH): number {
  const quotaBytes = resolveAuditQuotaMb(workspaceId) * 1024 * 1024;
  if (estimateAuditBytes(workspaceId) <= quotaBytes) return 0;
  const targetBytes = quotaBytes * HYSTERESIS;
  const del = getDb().prepare(
    `DELETE FROM tool_calls WHERE workspace_id = ?
     AND id IN (SELECT id FROM tool_calls WHERE workspace_id = ?
                ORDER BY timestamp ASC LIMIT ?)`,
  );
  let deleted = 0;
  while (estimateAuditBytes(workspaceId) > targetBytes) {
    const res = del.run(workspaceId, workspaceId, batchSize);
    if (res.changes === 0) break;
    deleted += res.changes;
  }
  return deleted;
}
