// electron/tests/migrations/063-remove-p2p-lsp-residue.test.ts
//
// P2P/LSP 移除（migration 063）测试：
//   - up：tasks.source_node_id 列消失；messages 的 lan/hub 镜像行删除（local 保留）；
//     agent_definitions.default_tools 的 lsp_* 引用剔除（其余引用与行零触碰）
//   - down：source_node_id 列恢复（数据不回填——子系统已删，无消费者）
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migration063 } from '../../src/main/storage/migrations/063_remove_p2p_lsp_residue';

/** 063 前的形状：tasks 带 source_node_id、messages 含 lan/hub 行、default_tools 含 lsp 引用 */
function buildLegacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      source_node_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      room_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      body TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'local'
    );
    CREATE TABLE agent_definitions (
      id TEXT PRIMARY KEY NOT NULL,
      default_tools TEXT
    );
    INSERT INTO tasks (id, title, status, source_node_id, created_at) VALUES
      ('t1', '本地', 'draft', NULL, 1),
      ('t2', '远端镜像', 'draft', 'node-abc', 1);
    INSERT INTO messages (id, room_id, sender, body, source) VALUES
      ('m1', 's1', 'owner', '本地行', 'local'),
      ('m2', 's1', 'remote:n1', 'lan 镜像', 'lan'),
      ('m3', 's1', 'remote:n1', 'hub 镜像', 'hub');
    INSERT INTO agent_definitions (id, default_tools) VALUES
      ('d1', '${JSON.stringify([
        { kind: 'builtin', ref: 'read_file' },
        { kind: 'builtin', ref: 'lsp_diagnostics' },
        { kind: 'builtin', ref: 'bash' },
        { kind: 'builtin', ref: 'lsp_find_references' },
      ])}'),
      ('d2', '${JSON.stringify([{ kind: 'builtin', ref: 'webfetch' }])}'),
      ('d3', NULL);
  `);
  return db;
}

function taskColumns(db: Database.Database): string[] {
  return (
    db.prepare("PRAGMA table_info('tasks')").all() as { name: string }[]
  ).map((c) => c.name);
}

describe('migration 063（P2P/LSP 残留清理）', () => {
  it('up：source_node_id 列消失、lan/hub 消息删除、lsp 引用剔除', () => {
    const db = buildLegacyDb();
    db.exec(migration063.up);

    expect(taskColumns(db)).not.toContain('source_node_id');
    expect(db.prepare('SELECT COUNT(*) c FROM tasks').get()).toMatchObject({ c: 2 });

    const sources = (
      db.prepare('SELECT source FROM messages ORDER BY id').all() as { source: string }[]
    ).map((r) => r.source);
    expect(sources).toEqual(['local']);

    const d1 = JSON.parse(
      (db.prepare("SELECT default_tools FROM agent_definitions WHERE id='d1'").get() as { default_tools: string }).default_tools,
    ) as Array<{ ref: string }>;
    expect(d1.map((t) => t.ref)).toEqual(['read_file', 'bash']);
    // 无 lsp 引用与 NULL 行零触碰
    const d2 = db.prepare("SELECT default_tools FROM agent_definitions WHERE id='d2'").get() as { default_tools: string };
    expect(JSON.parse(d2.default_tools)).toEqual([{ kind: 'builtin', ref: 'webfetch' }]);
    expect(
      db.prepare("SELECT default_tools FROM agent_definitions WHERE id='d3'").get(),
    ).toMatchObject({ default_tools: null });
    db.close();
  });

  it('down：source_node_id 列恢复（空列，无数据回填）', () => {
    const db = buildLegacyDb();
    db.exec(migration063.up);
    db.exec(migration063.down);
    expect(taskColumns(db)).toContain('source_node_id');
    expect(
      db.prepare('SELECT COUNT(*) c FROM tasks WHERE source_node_id IS NOT NULL').get(),
    ).toMatchObject({ c: 0 });
    db.close();
  });
});
