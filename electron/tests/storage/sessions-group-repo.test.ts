// electron/tests/storage/sessions-group-repo.test.ts
//
// session_groups CRUD + 置顶/归组写函数测试（spec 2026-10-22 §4.1）。
// 覆盖：建组 position 步进 / 删组事务（组内会话回落未分组）/ 置顶切换 /
//       置顶与分组独立（删组后置顶会话仍置顶）/ insertSession sessionType 落列。
//
// DB 隔离沿用仓库既定模式（照抄 sessions-repo.test.ts）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - runMigrations() 跑到最新（067：session_groups 表 + sessions 三新列）
//   - closeDb() 在 afterEach 复位单例；foreign_keys = ON 由生产 db.ts 统一设置
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertSession, getSession, insertSessionGroup, listSessionGroups,
  renameSessionGroup, deleteSessionGroup, setSessionPinned, setSessionGroup,
  setSessionGroupColor, GROUP_COLOR_PALETTE,
} from '../../src/main/storage/sessions/repo';

const tmpRoot = path.join(os.tmpdir(), `ap-session-group-repo-${Date.now()}`);
const WS = 'ws-g';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // workspaces 列集以现行 sessions-repo.test.ts 为准（含 description / icon_emoji）
  getDb().prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(WS, 'ws', '', '/tmp/ws', 0, '@owner:s', '📁');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('session_groups CRUD', () => {
  it('建组 position 依次 +1024；列表按 position 升序', () => {
    const a = insertSessionGroup(WS, 'A');
    const b = insertSessionGroup(WS, 'B');
    expect(a.position).toBe(1024);
    expect(b.position).toBe(2048);
    expect(listSessionGroups(WS).map((g) => g.name)).toEqual(['A', 'B']);
  });

  it('重命名组', () => {
    const g = insertSessionGroup(WS, '旧名');
    renameSessionGroup(g.id, '新名');
    expect(listSessionGroups(WS)[0]!.name).toBe('新名');
  });

  it('删组事务：组内会话 group_id 回落 NULL；置顶会话删组后仍置顶（Review Focus #4）', () => {
    const g = insertSessionGroup(WS, 'G');
    const s = insertSession({ workspaceId: WS, title: 't', sessionType: 'collab' });
    setSessionGroup(s.id, g.id);
    setSessionPinned(s.id, true);
    deleteSessionGroup(g.id);
    const after = getSession(s.id)!;
    expect(after.groupId).toBeNull();
    expect(after.pinnedAt).not.toBeNull();
    expect(listSessionGroups(WS)).toEqual([]);
  });
});

describe('置顶/归组写函数', () => {
  it('setSessionPinned 切换：置顶写时间戳、取消回 NULL', () => {
    const s = insertSession({ workspaceId: WS, title: 't' });
    setSessionPinned(s.id, true);
    expect(getSession(s.id)!.pinnedAt).not.toBeNull();
    setSessionPinned(s.id, false);
    expect(getSession(s.id)!.pinnedAt).toBeNull();
  });

  it('insertSession sessionType 落列；缺省为 NULL', () => {
    const a = insertSession({ workspaceId: WS, title: 'a', sessionType: 'quick' });
    const b = insertSession({ workspaceId: WS, title: 'b' });
    expect(getSession(a.id)!.sessionType).toBe('quick');
    expect(getSession(b.id)!.sessionType).toBeNull();
  });
});

describe('组色（spec §4.4，预览 A rev2 批准定值）', () => {
  it('连建 7 组颜色 = palette[(n-1) % 6] 循环（第 7 组回到 palette[0]）', () => {
    const names = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];
    const groups = names.map((n) => insertSessionGroup(WS, n));
    const expected = [...GROUP_COLOR_PALETTE, GROUP_COLOR_PALETTE[0]!];
    expect(groups.map((g) => g.color)).toEqual(expected);
  });

  it('setSessionGroupColor 落库读回', () => {
    const g = insertSessionGroup(WS, 'G');
    setSessionGroupColor(g.id, '#AB12CD');
    expect(listSessionGroups(WS)[0]!.color).toBe('#AB12CD');
  });
});
