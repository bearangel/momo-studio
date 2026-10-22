// electron/tests/im/session-group-ipc.test.ts
//
// 会话分组 / 置顶七通道契约锁（spec 2026-10-22 §7 + 预览 A rev2 组色）：
//   sessionGroup:list / create / rename / delete / setColor
//   session:setPinned / session:moveToGroup（handler 同址注册在
//   im/session-group.ipc.handlers.ts——语义属 session，通道名按 spec §7）
//
// 范式（照抄 tests/task/groups-ipc.test.ts）：vi.mock('electron') 用 hoisted
// Map 捕获 ipcMain.handle 注册表后 handler 直调；repo 层与真实 SQLite 完整
// 运行（mock 只收窄到进程边界——momo-test-rules：真实语义优先）。
// DB 隔离沿用 tests/storage/sessions-group-repo.test.ts 模式（临时目录 +
// runMigrations + closeDb 复位单例）。
//
// 覆盖：七通道注册面 / create 空名中文报错 / CRUD 全链路 / list 的
// workspace 隔离 / setColor 合法 hex 落库与非法值中文报错 /
// moveToGroup 跨 workspace 与会话不存在错误路径 /
// groupId=null 合法移出分组 / setPinned 落库与取消回 NULL。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface IpcHandler {
  (event: unknown, ...args: unknown[]): Promise<unknown> | unknown;
}

/** hoisted 状态捕获 ipcMain.handle 注册的 handler 集合 */
const handlers = vi.hoisted(() => new Map<string, IpcHandler>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: IpcHandler): void => {
      handlers.set(channel, fn);
    },
  },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { registerSessionGroupIpcHandlers } from '../../src/main/im/session-group.ipc.handlers';
import { insertSession, getSession } from '../../src/main/storage/sessions/repo';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-session-group-ipc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
const WS = 'ws-i';
const WS2 = 'ws-i2';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // workspaces 列集沿用 sessions-group-repo.test.ts（现行列集）
  const insertWs = getDb().prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertWs.run(WS, 'ws-i', '', '/tmp/ws-i', 0, '@owner:s', '📁');
  insertWs.run(WS2, 'ws-i2', '', '/tmp/ws-i2', 0, '@owner:s', '📁');
  handlers.clear();
  registerSessionGroupIpcHandlers();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 直调注册到的 handler（handler 均为 async → 返回 Promise，错误路径走 rejects） */
const call = (ch: string, ...args: unknown[]): Promise<unknown> =>
  handlers.get(ch)!(null, ...args) as Promise<unknown>;

describe('七通道注册面（spec §7 + 预览 A rev2 组色）', () => {
  it('sessionGroup 五通道 + session:setPinned / session:moveToGroup 全部注册', () => {
    for (const ch of [
      'sessionGroup:list',
      'sessionGroup:create',
      'sessionGroup:rename',
      'sessionGroup:delete',
      'sessionGroup:setColor',
      'session:setPinned',
      'session:moveToGroup',
    ]) {
      expect(handlers.has(ch), ch).toBe(true);
    }
  });
});

describe('sessionGroup:create / rename 空名（spec §7「空名报错」）', () => {
  it('create 空串 / 纯空白 → 中文报错', async () => {
    await expect(call('sessionGroup:create', WS, '')).rejects.toThrow('分组名不能为空');
    await expect(call('sessionGroup:create', WS, '   ')).rejects.toThrow('分组名不能为空');
  });

  it('rename 空串 / 纯空白 → 同一中文报错（共用名守卫）', async () => {
    const g = (await call('sessionGroup:create', WS, 'G')) as { id: string };
    await expect(call('sessionGroup:rename', g.id, '  ')).rejects.toThrow('分组名不能为空');
  });

  it('建组返回 SessionGroupRow：名去首尾空白，position 首组为 1024（repo 步进契约）', async () => {
    const g = (await call('sessionGroup:create', WS, '  G  ')) as { name: string; position: number };
    expect(g.name).toBe('G');
    expect(g.position).toBe(1024);
  });
});

describe('sessionGroup CRUD 全链路', () => {
  it('create → rename → list → delete 依次生效', async () => {
    const g = (await call('sessionGroup:create', WS, 'G')) as { id: string; name: string };
    expect(g.name).toBe('G');

    await call('sessionGroup:rename', g.id, 'G2');
    const list = (await call('sessionGroup:list', WS)) as Array<{ id: string; name: string }>;
    expect(list.map((x) => x.name)).toEqual(['G2']);

    await call('sessionGroup:delete', g.id);
    expect(await call('sessionGroup:list', WS)).toEqual([]);
  });

  it('list 按 workspace 隔离（别家工作空间的组不串台）', async () => {
    await call('sessionGroup:create', WS2, '别家组');
    expect(await call('sessionGroup:list', WS)).toEqual([]);
  });

  it('delete 组内会话回落未分组（事务语义与 renderer 列表一致）', async () => {
    const g = (await call('sessionGroup:create', WS, 'G')) as { id: string };
    const s = insertSession({ workspaceId: WS, title: 't' });
    await call('session:moveToGroup', s.id, g.id);

    await call('sessionGroup:delete', g.id);

    expect(getSession(s.id)!.groupId).toBeNull();
  });
});

describe('sessionGroup:setColor（组色，预览 A rev2）', () => {
  it('合法 hex 落库，list 读回', async () => {
    const g = (await call('sessionGroup:create', WS, 'G')) as { id: string };
    await call('sessionGroup:setColor', g.id, '#AB12CD');
    const list = (await call('sessionGroup:list', WS)) as Array<{ id: string; color: string }>;
    expect(list[0]!.color).toBe('#AB12CD');
  });

  it("'red' / '#GGGGGG' 非法 hex → 中文报错「颜色值格式不正确」", async () => {
    const g = (await call('sessionGroup:create', WS, 'G')) as { id: string };
    await expect(call('sessionGroup:setColor', g.id, 'red')).rejects.toThrow('颜色值格式不正确');
    await expect(call('sessionGroup:setColor', g.id, '#GGGGGG')).rejects.toThrow('颜色值格式不正确');
  });
});

describe('session:moveToGroup（spec §7「校验组属同 workspace」）', () => {
  it('跨 workspace 组 → 中文报错，会话分组不变', async () => {
    const g = (await call('sessionGroup:create', WS2, '别家组')) as { id: string };
    const s = insertSession({ workspaceId: WS, title: 't' });

    await expect(call('session:moveToGroup', s.id, g.id)).rejects.toThrow(
      '分组不存在或不属于当前会话所在工作空间',
    );
    expect(getSession(s.id)!.groupId).toBeNull();
  });

  it('同 workspace 组 → 落 group_id；groupId=null 合法移出分组（跳过校验）', async () => {
    const g = (await call('sessionGroup:create', WS, 'G')) as { id: string };
    const s = insertSession({ workspaceId: WS, title: 't' });

    await call('session:moveToGroup', s.id, g.id);
    expect(getSession(s.id)!.groupId).toBe(g.id);

    await call('session:moveToGroup', s.id, null);
    expect(getSession(s.id)!.groupId).toBeNull();
  });

  it('会话不存在 → 中文报错（错误路径）', async () => {
    const g = (await call('sessionGroup:create', WS, 'G')) as { id: string };
    await expect(call('session:moveToGroup', 'sess-404', g.id)).rejects.toThrow('会话不存在');
  });
});

describe('session:setPinned', () => {
  it('置顶落 pinned_at 时间戳；取消置顶回 NULL', async () => {
    const s = insertSession({ workspaceId: WS, title: 't' });
    const readPinned = (): number | null =>
      (getDb().prepare('SELECT pinned_at FROM sessions WHERE id = ?').get(s.id) as {
        pinned_at: number | null;
      }).pinned_at;

    await call('session:setPinned', s.id, true);
    expect(readPinned()).not.toBeNull();

    await call('session:setPinned', s.id, false);
    expect(readPinned()).toBeNull();
  });
});