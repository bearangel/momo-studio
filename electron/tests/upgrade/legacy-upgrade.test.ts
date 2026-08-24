// electron/tests/upgrade/legacy-upgrade.test.ts
//
// P5 Task 1：v1.x 旧库检测 + 自动导出 + 备份重置 测试。
//
// 构造方式沿用 migrations 测试的 applyUpTo 模式（见 023-sessions.test.ts）：
// 用 better-sqlite3 在临时目录（AP_USER_DATA_DIR 隔离，同 storage/db.test.ts）
// 顺序 exec loadMigrations() 中 version <= 22 的 SQL，得到一个 1.x 终态库
//（messages.room_id / agent_definitions 旧列名俱在），再种子数据后跑编排。
//
// 断言要点（对应 task brief）：
//   1. 旧库：sessions/*.md 两份 + agent-definitions.json 两条 + state.db 改名 .bak
//   2. kv 标记延迟：编排后原路径无新库文件；runMigrations 后写 kv 才生效
//   3. WAL 场景：未 checkpoint 数据在 -wal 里，只读导出仍可读 + 备份含 -wal/-shm
//   4. 非旧库（无库 / v24 库 / 垃圾文件）→ null 且零副作用
//   5. 导出异常不阻塞升级（mock legacy-export 抛错 → 备份重置仍完成）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

// 导出失败注入开关：vi.mock 工厂是 hoisted 的，用可变对象传 flag。
// 其余测试透传 actual 实现，行为不受影响。
const exportShouldThrow = { flag: false };
vi.mock('../../src/main/upgrade/legacy-export', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/main/upgrade/legacy-export')>();
  return {
    ...actual,
    exportLegacyData: (dbPath: string, outDir: string) => {
      if (exportShouldThrow.flag) throw new Error('模拟导出失败');
      return actual.exportLegacyData(dbPath, outDir);
    },
  };
});

import {
  runLegacyUpgradeIfNeeded,
  writeLegacyUpgradeNotice,
  readUpgradeNotice,
  dismissUpgradeNotice,
} from '../../src/main/upgrade/legacy-upgrade';
import { detectLegacyDb } from '../../src/main/upgrade/legacy-detect';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = path.join(os.tmpdir(), `ap-upgrade-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  exportShouldThrow.flag = false;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 构造 1.x 终态库（应用全部 version <= 22 的 migration），返回保持打开的连接。 */
function buildLegacyV22Db(dbPath: string): DB {
  const db = new Database(dbPath);
  // v1.x getDb() 即 WAL 模式；close() 干净收尾后 -wal/-shm 被删除，
  // 剩下 WAL header 的主文件——这是真实旧库最常见的形态（SQLite 3.22+ 只读可开）
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const mark = db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)');
  for (const m of loadMigrations()) {
    if (m.version > 22) break;
    db.exec(m.sql);
    mark.run(m.version);
  }
  return db;
}

interface SeedMessage {
  id: string;
  room_id: string;
  sender: string;
  event_type: string;
  body: string;
  created_at: number;
}

function seedMessages(db: DB, rows: SeedMessage[]): void {
  const stmt = db.prepare(
    `INSERT INTO messages (id, room_id, sender, event_type, body, status, source, created_at, updated_at)
     VALUES (@id, @room_id, @sender, @event_type, @body, 'done', 'local', @created_at, @created_at)`,
  );
  for (const r of rows) stmt.run(r);
}

function seedAgentDefs(db: DB): void {
  const stmt = db.prepare(
    `INSERT INTO agent_definitions (id, name, slug, version, runtime, system_prompt, model_name, default_tools, source, description, icon_emoji)
     VALUES (?, ?, ?, '1.0.0', 'declarative', ?, ?, ?, 'custom', ?, ?)`,
  );
  stmt.run('def-1', '研究者', 'researcher', '你是研究员', 'glm-4', '[]', '负责检索', '🔍');
  stmt.run('def-2', '写手', 'writer', '你是写手', 'glm-4', '[]', '负责成文', '✍️');
}

/** 两房间 × 若干 m.room.message + 1 条 dispatch（应被导出过滤）。 */
function defaultSeedMessages(): SeedMessage[] {
  const base = 1_700_000_000_000;
  return [
    { id: 'm1', room_id: '!room-alpha:localhost', sender: '@owner:localhost', event_type: 'm.room.message', body: '第一条消息', created_at: base },
    { id: 'm2', room_id: '!room-alpha:localhost', sender: '@bot.researcher.ws.owner.x:localhost', event_type: 'm.room.message', body: '收到，开始处理', created_at: base + 1000 },
    { id: 'm3', room_id: '!room-alpha:localhost', sender: '@owner:localhost', event_type: 'm.room.message', body: '好的', created_at: base + 2000 },
    // dispatch 事件不应出现在会话导出里
    { id: 'm4', room_id: '!room-alpha:localhost', sender: '@owner:localhost', event_type: 'dispatch', body: 'ignored', created_at: base + 3000 },
    { id: 'm5', room_id: '!room-beta:localhost', sender: '@owner:localhost', event_type: 'm.room.message', body: 'Beta 房间消息', created_at: base + 4000 },
    { id: 'm6', room_id: '!room-beta:localhost', sender: '@bot.writer.ws.owner.x:localhost', event_type: 'm.room.message', body: 'Beta 回复', created_at: base + 5000 },
  ];
}

describe('detectLegacyDb', () => {
  it('文件不存在 → 非旧库 appliedMax=0', () => {
    const r = detectLegacyDb(path.join(tmpRoot, 'state.db'));
    expect(r).toEqual({ legacy: false, appliedMax: 0 });
  });

  it('v22 库 → 旧库 appliedMax=22', () => {
    const dbPath = path.join(tmpRoot, 'state.db');
    const db = buildLegacyV22Db(dbPath);
    db.close();
    expect(detectLegacyDb(dbPath)).toEqual({ legacy: true, appliedMax: 22 });
  });

  it('v24 库 → 非旧库', () => {
    const dbPath = path.join(tmpRoot, 'state.db');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24].forEach((v) =>
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(v),
    );
    db.close();
    expect(detectLegacyDb(dbPath)).toEqual({ legacy: false, appliedMax: 24 });
  });

  it('垃圾文件（非 SQLite）→ 非旧库且不抛异常', () => {
    const dbPath = path.join(tmpRoot, 'state.db');
    fs.writeFileSync(dbPath, 'this is not a sqlite database at all');
    expect(detectLegacyDb(dbPath)).toEqual({ legacy: false, appliedMax: 0 });
  });
});

describe('runLegacyUpgradeIfNeeded（旧库升级编排）', () => {
  it('旧库：导出两份 .md + agent-definitions.json，state.db 改名 .bak，返回导出目录', async () => {
    const dbPath = path.join(tmpRoot, 'state.db');
    const db = buildLegacyV22Db(dbPath);
    seedMessages(db, defaultSeedMessages());
    seedAgentDefs(db);
    db.close();

    const exportDir = await runLegacyUpgradeIfNeeded();
    expect(exportDir).toBeTruthy();
    if (exportDir === null) throw new Error('旧库场景应返回导出目录');

    // 导出目录名 upgrade-export-<YYYYMMDD-HHmmss>，位于 userData 下
    const name = path.basename(exportDir);
    expect(name).toMatch(/^upgrade-export-\d{8}-\d{6}$/);
    expect(path.dirname(exportDir)).toBe(tmpRoot);
    expect(fs.existsSync(exportDir)).toBe(true);

    // 两份会话 markdown
    const sessionsDir = path.join(exportDir, 'sessions');
    const mdFiles = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.md')).sort();
    expect(mdFiles).toHaveLength(2);

    // 每份头部含 room_id 原值 + 条数 + 时间范围；正文含消息内容；dispatch 被过滤
    const alphaName = mdFiles.find((f) => f.includes('room-alpha'));
    expect(alphaName).toBeTruthy();
    const alpha = fs.readFileSync(path.join(sessionsDir, alphaName!), 'utf-8');
    expect(alpha).toContain('!room-alpha:localhost');
    expect(alpha).toContain('第一条消息');
    expect(alpha).toContain('好的');
    expect(alpha).not.toContain('ignored');
    expect(alpha).toMatch(/实际 3 条/);
    expect(alpha).toMatch(/时间跨度/);

    const betaName = mdFiles.find((f) => f.includes('room-beta'));
    const beta = fs.readFileSync(path.join(sessionsDir, betaName!), 'utf-8');
    expect(beta).toContain('!room-beta:localhost');
    expect(beta).toContain('Beta 房间消息');

    // agent-definitions.json：数组 + meta
    const defsPath = path.join(exportDir, 'agent-definitions.json');
    expect(fs.existsSync(defsPath)).toBe(true);
    const defs = JSON.parse(fs.readFileSync(defsPath, 'utf-8')) as {
      agents: Array<{ name: string; slug: string }>;
      meta: Record<string, unknown>;
    };
    expect(defs.agents).toHaveLength(2);
    expect(defs.agents.map((a) => a.slug).sort()).toEqual(['researcher', 'writer']);
    expect(defs.meta).toBeTruthy();

    // 备份重置：原 state.db 消失，.bak 出现且旧数据可读
    expect(fs.existsSync(dbPath)).toBe(false);
    const bakPath = dbPath + '.legacy-v1.bak';
    expect(fs.existsSync(bakPath)).toBe(true);
    const bak = new Database(bakPath, { readonly: true });
    const n = bak.prepare("SELECT COUNT(*) AS n FROM messages WHERE event_type='m.room.message'").get() as { n: number };
    bak.close();
    expect(n.n).toBe(5); // 6 条种子中 1 条 dispatch 不计入

    // kv 延迟语义：编排未建新库（原路径无文件），runMigrations 后写 kv 标记
    runMigrations();
    const maxV = (getDb().prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
    expect(maxV).toBe(24);
    writeLegacyUpgradeNotice(exportDir!);
    const kv = getDb().prepare("SELECT value FROM kv_store WHERE key='legacy_upgrade_notice'").get() as { value: string };
    expect(JSON.parse(kv.value)).toEqual({ exportDir });
  });

  it('WAL 场景：未 checkpoint 数据可导出，备份含 -wal/-shm', async () => {
    const dbPath = path.join(tmpRoot, 'state.db');
    const writer = new Database(dbPath);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    const mark = writer.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)');
    for (const m of loadMigrations()) {
      if (m.version > 22) break;
      writer.exec(m.sql);
      mark.run(m.version);
    }
    seedMessages(writer, [
      { id: 'w1', room_id: '!room-wal:localhost', sender: '@owner:localhost', event_type: 'm.room.message', body: 'WAL 未落盘消息', created_at: 1_700_000_000_000 },
    ]);
    // 不 close——数据留在 -wal（autocheckpoint 关闭），模拟崩溃残留

    const exportDir = await runLegacyUpgradeIfNeeded();
    expect(exportDir).toBeTruthy();

    // 只读连接能透过 -wal 读到未 checkpoint 数据
    const sessionsDir = path.join(exportDir!, 'sessions');
    const mdFiles = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.md'));
    expect(mdFiles).toHaveLength(1);
    const content = fs.readFileSync(path.join(sessionsDir, mdFiles[0]!), 'utf-8');
    expect(content).toContain('WAL 未落盘消息');

    // 备份包含 wal/shm 三件套
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(dbPath + '.legacy-v1.bak')).toBe(true);
    expect(fs.existsSync(dbPath + '-wal.legacy-v1.bak')).toBe(true);
    expect(fs.existsSync(dbPath + '-shm.legacy-v1.bak')).toBe(true);

    writer.close(); // 事后清理（fd 指向已改名的 inode，close 即释放）
  });

  it('导出异常不阻塞升级：备份重置仍完成', async () => {
    const dbPath = path.join(tmpRoot, 'state.db');
    const db = buildLegacyV22Db(dbPath);
    seedMessages(db, defaultSeedMessages());
    seedAgentDefs(db);
    db.close();

    exportShouldThrow.flag = true;
    const exportDir = await runLegacyUpgradeIfNeeded();
    exportShouldThrow.flag = false;

    // 返回导出目录（已建），但导出内容缺失不阻塞备份
    expect(exportDir).toBeTruthy();
    expect(fs.existsSync(path.join(exportDir!, 'sessions'))).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(dbPath + '.legacy-v1.bak')).toBe(true);
  });

  it('无库文件 → null 且零副作用', async () => {
    expect(await runLegacyUpgradeIfNeeded()).toBeNull();
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it('v24 新库 → null，库文件不动', async () => {
    runMigrations();
    closeDb();
    const dbPath = path.join(tmpRoot, 'state.db');
    expect(await runLegacyUpgradeIfNeeded()).toBeNull();
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(dbPath + '.legacy-v1.bak')).toBe(false);
    expect(fs.readdirSync(tmpRoot).some((f) => f.startsWith('upgrade-export-'))).toBe(false);
  });
});

describe('readUpgradeNotice / dismissUpgradeNotice（P5 Task 2）', () => {
  it('无 kv 标记 → 返回 null', () => {
    runMigrations();
    expect(readUpgradeNotice()).toBeNull();
  });

  it('有 kv 标记 → 返回 { exportDir }', () => {
    runMigrations();
    writeLegacyUpgradeNotice('/tmp/upgrade-export-20260824-101530');
    expect(readUpgradeNotice()).toEqual({
      exportDir: '/tmp/upgrade-export-20260824-101530',
    });
  });

  it('kv 值是畸形 JSON → 返回 null（不抛错，UI 容错）', () => {
    runMigrations();
    // 直接 INSERT 非法 JSON 模拟边缘场景
    getDb()
      .prepare(
        `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
      )
      .run('legacy_upgrade_notice', 'not-json');
    expect(readUpgradeNotice()).toBeNull();
  });

  it('kv 值缺少 exportDir 字段 → 返回 null', () => {
    runMigrations();
    getDb()
      .prepare(
        `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
      )
      .run('legacy_upgrade_notice', JSON.stringify({ foo: 'bar' }));
    expect(readUpgradeNotice()).toBeNull();
  });

  it('dismissUpgradeNotice 删除 kv 标记 → 后续 read 返回 null', () => {
    runMigrations();
    writeLegacyUpgradeNotice('/tmp/upgrade-export-x');
    expect(readUpgradeNotice()).not.toBeNull();
    dismissUpgradeNotice();
    expect(readUpgradeNotice()).toBeNull();
  });

  it('dismissUpgradeNotice 无标记时幂等（不抛错）', () => {
    runMigrations();
    expect(() => dismissUpgradeNotice()).not.toThrow();
    expect(readUpgradeNotice()).toBeNull();
  });
});
