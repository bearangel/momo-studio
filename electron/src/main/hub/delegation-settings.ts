// hub 委派执行设置（接受开关 / 并发上限 / HITL 无人确认超时）——kv_store key
// 'hub_delegation_settings'。config-store 同款读写纪律：脏 JSON 容错回缺省；
// maxConcurrent 写入时夹取 [1,8]；hitlTimeoutMinutes 夹取 [1,120]（M2.1 T11 /
// RM-M21-4：超时配置位=节点互联·委派节，默认 15 分钟）。
import type { Database } from 'better-sqlite3';

export interface HubDelegationSettings {
  /** 是否接受其他节点派来的委派任务（关闭 = 一律 declined） */
  acceptTasks: boolean;
  /** 同时执行的委派任务上限（超出 declined） */
  maxConcurrent: number;
  /** HITL 无人确认超时（分钟）：委派会话持续等待用户确认超此值 → 自动拒
   *  （applyRunPolicy readonly + steer 保守指令）；双倍超时兜底 failed。 */
  hitlTimeoutMinutes: number;
}

const KEY = 'hub_delegation_settings';
const DEFAULTS: HubDelegationSettings = { acceptTasks: true, maxConcurrent: 2, hitlTimeoutMinutes: 15 };
const MIN_CONCURRENT = 1;
const MAX_CONCURRENT = 8;
const MIN_HITL_TIMEOUT = 1;
const MAX_HITL_TIMEOUT = 120;

export interface HubDelegationSettingsStore {
  read(): HubDelegationSettings;
  write(input: HubDelegationSettings): HubDelegationSettings;
}

function clampConcurrent(n: number): number {
  if (!Number.isFinite(n)) return DEFAULTS.maxConcurrent;
  return Math.min(MAX_CONCURRENT, Math.max(MIN_CONCURRENT, Math.round(n)));
}

function clampHitlTimeout(n: number): number {
  if (!Number.isFinite(n)) return DEFAULTS.hitlTimeoutMinutes;
  return Math.min(MAX_HITL_TIMEOUT, Math.max(MIN_HITL_TIMEOUT, Math.round(n)));
}

export function createHubDelegationSettingsStore(db: Database): HubDelegationSettingsStore {
  const read = (): HubDelegationSettings => {
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(KEY) as { value: string } | undefined;
    if (!row) return { ...DEFAULTS };
    try {
      const parsed = JSON.parse(row.value) as Partial<HubDelegationSettings>;
      return {
        acceptTasks: typeof parsed.acceptTasks === 'boolean' ? parsed.acceptTasks : DEFAULTS.acceptTasks,
        maxConcurrent: typeof parsed.maxConcurrent === 'number' ? clampConcurrent(parsed.maxConcurrent) : DEFAULTS.maxConcurrent,
        hitlTimeoutMinutes:
          typeof parsed.hitlTimeoutMinutes === 'number' ? clampHitlTimeout(parsed.hitlTimeoutMinutes) : DEFAULTS.hitlTimeoutMinutes,
      };
    } catch {
      return { ...DEFAULTS }; // 脏数据容错（config-store 同款读侧纪律）
    }
  };
  return {
    read,
    write(input) {
      const normalized: HubDelegationSettings = {
        acceptTasks: input.acceptTasks === true,
        maxConcurrent: clampConcurrent(input.maxConcurrent),
        hitlTimeoutMinutes: clampHitlTimeout(input.hitlTimeoutMinutes),
      };
      db.prepare(`INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(KEY, JSON.stringify(normalized));
      return normalized;
    },
  };
}
