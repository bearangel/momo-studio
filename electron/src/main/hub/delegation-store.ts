// hub 委派本地账本——kv_store key 'hub_delegations'（taskId → 运行记录映射）。
// MC1 元数据落点裁定：sessions.settings_json 的读侧（getSessionSettings）只归一
// maxToolCalls/conflictStrategy 两键、合并写会静默丢弃未知字段——不是安全扩展点；
// 委派标记（taskId↔sessionId 关联、byNode 留痕、本地终态）落 hub 域自有 kv
// （config-store 同款纪律），会话行本身保持普通 collab 会话（标题=任务书摘要）。
import type { Database } from 'better-sqlite3';

/** 本地运行态（与 hub 账本六态不同——本地只有「在跑/终态」语义；
 *  1.10.0 平行模式前置两态：draft=草稿已落板待安排、arranged=已安排待执行） */
export type DelegationLocalState = 'draft' | 'arranged' | 'running' | 'done' | 'failed' | 'cancelled';

export interface DelegationRecord {
  taskId: string;
  /** MC1 委派会话 id（本机 sessions 表行）；平行草稿落板时为 ''（安排执行后回填） */
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  title: string;
  /** 派单节点 id（审计留痕） */
  byNode: string;
  state: DelegationLocalState;
  /**
   * 1.10.0 平行模式草稿标记（spec 2026-11-05 §5.2）：draft=true 时 sessionId
   * 允许为 ''（未安排无会话）；监督器按 localTaskId 行状态机推进。
   */
  draft?: true;
  /** 1.10.0：草稿对应的本地 tasks 行 id（监督器定位锚） */
  localTaskId?: string;
  /** 1.10.0：组归属（绑定解析/审计） */
  groupId?: string;
  /**
   * failed 终态人话原因（M2.3 P2-1）——与 runner 上报 hub 的 failed 载荷 reason
   * 同源（本机落值不经 hub 中转），worker 本机看板卡 title 全文数据源。
   * 可选：缺席 = 老数据（P2-1 前落库）或无因失败，消费方回退现状不空白。
   */
  reason?: string;
  createdAt: number;
  updatedAt: number;
}

const KEY = 'hub_delegations';

export interface HubDelegationStore {
  get(taskId: string): DelegationRecord | null;
  upsert(record: DelegationRecord): void;
  updateState(taskId: string, state: DelegationLocalState, reason?: string): void;
  list(): DelegationRecord[];
}

function parseAll(raw: string | undefined): Map<string, DelegationRecord> {
  const out = new Map<string, DelegationRecord>();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out;
    for (const v of Object.values(parsed)) {
      if (typeof v !== 'object' || v === null) continue;
      const r = v as Partial<DelegationRecord>;
      if (
        typeof r.taskId === 'string' && typeof r.sessionId === 'string' &&
        typeof r.workspaceId === 'string' && typeof r.workspaceName === 'string' &&
        typeof r.title === 'string' && typeof r.byNode === 'string' &&
        (r.state === 'draft' || r.state === 'arranged' || r.state === 'running' || r.state === 'done' || r.state === 'failed' || r.state === 'cancelled') &&
        typeof r.createdAt === 'number' && typeof r.updatedAt === 'number'
      ) {
        // reason 仅字符串落形（P2-1——progress store waiting 同款纪律：老数据无
        // 此字段零改写，异形值剥除不渗入持久化面）
        const rec = r as DelegationRecord;
        if (typeof rec.reason !== 'string') delete rec.reason;
        // 1.10.0 草稿三可选字段保守落形（非草稿记录剥除；draft 记录 sessionId
        // 允许 ''——形态见 DelegationRecord.draft 注释）
        if (rec.draft === true) {
          rec.draft = true;
          if (typeof rec.localTaskId !== 'string') delete rec.localTaskId;
          if (typeof rec.groupId !== 'string') delete rec.groupId;
        } else {
          delete rec.draft;
          delete rec.localTaskId;
          delete rec.groupId;
        }
        out.set(r.taskId, rec);
      }
    }
  } catch {
    // 脏 JSON 容错：整表按空处理（委派可重派，不炸读取方）
  }
  return out;
}

export function createHubDelegationStore(db: Database): HubDelegationStore {
  const load = (): Map<string, DelegationRecord> => {
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(KEY) as { value: string } | undefined;
    return parseAll(row?.value);
  };
  const save = (records: Map<string, DelegationRecord>): void => {
    const obj: Record<string, DelegationRecord> = {};
    for (const [k, v] of records) obj[k] = v;
    db.prepare(`INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(KEY, JSON.stringify(obj));
  };
  return {
    get(taskId) {
      return load().get(taskId) ?? null;
    },
    upsert(record) {
      const records = load();
      records.set(record.taskId, record);
      save(records);
    },
    updateState(taskId, state, reason) {
      const records = load();
      const prev = records.get(taskId);
      if (!prev) return;
      const next: DelegationRecord = { ...prev, state, updatedAt: Date.now() };
      if (state === 'failed' && typeof reason === 'string') next.reason = reason;
      records.set(taskId, next);
      save(records);
    },
    list() {
      return [...load().values()];
    },
  };
}
