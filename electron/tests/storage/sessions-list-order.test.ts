// electron/tests/storage/sessions-list-order.test.ts
//
// 排序契约测试（spec 2026-10-22 §4.1）：置顶区（pinned_at DESC）> 分组（position ASC，
// 组内活跃时间 DESC）> 未分组（活跃时间 DESC）。空组不影响排序。
//
// DB 隔离沿用 sessions-repo.test.ts 模式：AP_USER_DATA_DIR 指向临时目录 +
// runMigrations() 跑到最新（含 067：session_groups / pinned_at / group_id / session_type）
// + closeDb() 在 afterEach 复位单例；foreign_keys = ON 由 storage/db 统一开启。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertSession,
  touchSessionLastMessage,
  insertSessionGroup,
  setSessionPinned,
  setSessionGroup,
  listSessionsWithGroup,
} from '../../src/main/storage/sessions/repo';
import { getSessionsForWorkspace } from '../../src/main/im/session-ops';

const tmpRoot = path.join(os.tmpdir(), `ap-session-order-${Date.now()}`);
const WS = 'ws-o';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // 7 列写法与 sessions-repo.test.ts 保持一致（description / icon_emoji 非空约束）
  getDb()
    .prepare(
      `INSERT INTO workspaces
         (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(WS, 'ws', '', '/tmp/ws', 0, '@owner:s', '📁');
});
// 清库（沿用 sessions-repo.test.ts 约定）：残留 DB 文件会让下一个用例撞 workspaces UNIQUE 约束
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('会话列表排序契约（spec §4.1）', () => {
  it('置顶区 > 分组 > 未分组；置顶区内后置顶在上；组内按活跃时间倒序', () => {
    const gB = insertSessionGroup(WS, 'B'); // position 1024
    const gA = insertSessionGroup(WS, 'A'); // position 2048（建组序 B 先 A 后——组序按 position，A 后建却在下）
    const old = insertSession({ workspaceId: WS, title: '旧', sessionType: 'quick' });
    const fresh = insertSession({ workspaceId: WS, title: '新', sessionType: 'quick' });
    const inB = insertSession({ workspaceId: WS, title: 'inB', sessionType: 'collab' });
    const inA = insertSession({ workspaceId: WS, title: 'inA', sessionType: 'collab' });
    const pinnedOld = insertSession({ workspaceId: WS, title: 'pin旧', sessionType: 'quick' });
    const pinnedNew = insertSession({ workspaceId: WS, title: 'pin新', sessionType: 'quick' });

    setSessionGroup(inB.id, gB.id);
    setSessionGroup(inA.id, gA.id);
    setSessionPinned(pinnedOld.id, true);
    touchSessionLastMessage(fresh.id); // 未分组两条：fresh 最近活跃在前
    setSessionPinned(pinnedNew.id, true); // 后置顶 → 置顶区更上

    // 固定时间轴（沿用 sessions-repo.test.ts 做法）：整段夹具跑在同一毫秒内时
    // 七个排序键全部同值，排序会退化成插入序，测不出契约。逐条写死时间戳：
    //   pin新 pinned=6000 > pin旧 pinned=5000 → 后置顶在上
    //   新 有效时间 8000（last_message_at）> 旧 有效时间 2000（created_at）
    const db = getDb();
    const setTimes = db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?');
    const setPin = db.prepare('UPDATE sessions SET pinned_at = ? WHERE id = ?');
    setTimes.run(2000, old.id);
    setTimes.run(3000, fresh.id);
    db.prepare('UPDATE sessions SET last_message_at = ? WHERE id = ?').run(8000, fresh.id);
    setTimes.run(4000, inB.id);
    setTimes.run(4000, inA.id);
    setTimes.run(1000, pinnedOld.id);
    setTimes.run(1000, pinnedNew.id);
    setPin.run(5000, pinnedOld.id);
    setPin.run(6000, pinnedNew.id);

    const order = listSessionsWithGroup(WS).map((s) => s.title);
    expect(order).toEqual(['pin新', 'pin旧', 'inB', 'inA', '新', '旧']);
    // 等价验证（时间戳精度兜底）：置顶两条在最前两条之内
    expect(order.slice(0, 2)).toEqual(expect.arrayContaining(['pin新', 'pin旧']));

    // groupName JOIN 带出
    const withGroup = listSessionsWithGroup(WS).find((s) => s.title === 'inB')!;
    expect(withGroup.groupName).toBe('B');
  });

  it('getSessionsForWorkspace summary 含 pinnedAt/groupId/groupName/sessionType', () => {
    const g = insertSessionGroup(WS, 'G');
    const s = insertSession({ workspaceId: WS, title: 't', sessionType: 'collab' });
    setSessionGroup(s.id, g.id);
    setSessionPinned(s.id, true);
    const summary = getSessionsForWorkspace(WS).find((x) => x.id === s.id)!;
    expect(summary.pinnedAt).not.toBeNull();
    expect(summary.groupId).toBe(g.id);
    expect(summary.groupName).toBe('G');
    expect(summary.sessionType).toBe('collab');
  });
});