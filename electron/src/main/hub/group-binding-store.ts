// electron/src/main/hub/group-binding-store.ts
//
// 平行组承接空间绑定的本地权威（spec 2026-11-05 §4.2）：group_id → workspace_id。
// hub 侧另有按名登记（组内可见/委派前置闸）——两侧各存各的：hub 按名（对外
// 展示与守卫），本地按 id（草稿落点与 applyTo:'binding' 镜像解析——workspaceId
// 不受改名/同名影响）。写入路径唯一：hub:groupBind IPC（RPC 成功后本地 upsert），
// 删除路径唯一：hub:groupUnbind（RPC 成功后本地 delete）。
import { getDb } from '../storage/db';

interface BindingRow {
  group_id: string;
  workspace_id: string;
  updated_at: number;
}

export interface GroupBindingStore {
  get(groupId: string): { workspaceId: string } | null;
  upsert(groupId: string, workspaceId: string): void;
  remove(groupId: string): void;
  list(): Array<{ groupId: string; workspaceId: string }>;
}

export function createGroupBindingStore(db: ReturnType<typeof getDb>): GroupBindingStore {
  const load = (): Map<string, BindingRow> => {
    const rows = db.prepare('SELECT group_id, workspace_id, updated_at FROM hub_group_bindings').all() as BindingRow[];
    return new Map(rows.map((r) => [r.group_id, r]));
  };
  return {
    get(groupId) {
      const row = db
        .prepare('SELECT workspace_id FROM hub_group_bindings WHERE group_id = ?')
        .get(groupId) as { workspace_id: string } | undefined;
      return row ? { workspaceId: row.workspace_id } : null;
    },
    upsert(groupId, workspaceId) {
      db.prepare(
        `INSERT INTO hub_group_bindings (group_id, workspace_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET workspace_id = excluded.workspace_id, updated_at = excluded.updated_at`,
      ).run(groupId, workspaceId, Date.now());
    },
    remove(groupId) {
      db.prepare('DELETE FROM hub_group_bindings WHERE group_id = ?').run(groupId);
    },
    list() {
      return [...load().values()].map((r) => ({ groupId: r.group_id, workspaceId: r.workspace_id }));
    },
  };
}
