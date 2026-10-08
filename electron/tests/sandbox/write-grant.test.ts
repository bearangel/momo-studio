// electron/tests/sandbox/write-grant.test.ts
// write-grant 存储层（spec §3/§4）：KV 两键读写、两层合成、生命周期清理。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  grantWriteDirs,
  revokeWriteDir,
  getGrantedDirs,
  listWorkspaceGrants,
  clearSessionGrants,
  __clearWriteGrantsForTest,
} from '../../src/main/sandbox/write-grant';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { deleteSession } from '../../src/main/storage/sessions/repo';
import { deleteWorkspace } from '../../src/main/workspace/crud';

const tmpRoot = path.join(os.tmpdir(), `write-grant-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  __clearWriteGrantsForTest();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('write-grant 存储（spec §3/§4）', () => {
  it('grantWriteDirs 归一化存储：~/ 前缀展开 + 去重', () => {
    const home = os.homedir();
    grantWriteDirs('session', 's-1', ['~/.cargo', `${home}/.cargo`, '/opt/local/lib']);
    const dirs = getGrantedDirs('s-1', null);
    // ~/ 展开与绝对路径字面重复 → 归一去重后 2 条
    expect(dirs).toHaveLength(2);
    expect(dirs).toContain(path.join(home, '.cargo'));
    expect(dirs).toContain('/opt/local/lib');
  });

  it('会话层 ∪ 工作空间层合并；null 键跳过该层', () => {
    grantWriteDirs('session', 's-1', ['/tmp/a']);
    grantWriteDirs('workspace', 'w-1', ['/tmp/b']);
    expect(getGrantedDirs('s-1', 'w-1').sort()).toEqual(['/tmp/a', '/tmp/b']);
    expect(getGrantedDirs(null, 'w-1')).toEqual(['/tmp/b']);
    expect(getGrantedDirs('s-1', null)).toEqual(['/tmp/a']);
    expect(getGrantedDirs(null, null)).toEqual([]);
  });

  it('revokeWriteDir 移除单条；不存在的 dir no-op', () => {
    grantWriteDirs('workspace', 'w-1', ['/tmp/a', '/tmp/b']);
    revokeWriteDir('workspace', 'w-1', '/tmp/a');
    expect(getGrantedDirs(null, 'w-1')).toEqual(['/tmp/b']);
    expect(() => revokeWriteDir('workspace', 'w-1', '/nope')).not.toThrow();
  });

  it('KV 持久：落库形状为 JSON 数组（重启语义）', () => {
    grantWriteDirs('session', 's-1', ['/tmp/x']);
    const row = getDb()
      .prepare("SELECT value FROM kv_store WHERE key = 'sandbox_write_grant_session_s-1'")
      .get() as { value: string };
    expect(JSON.parse(row.value)).toEqual(['/tmp/x']);
  });

  it('listWorkspaceGrants 列出全部工作空间授权', () => {
    grantWriteDirs('workspace', 'w-1', ['/tmp/a']);
    grantWriteDirs('workspace', 'w-2', ['/tmp/b']);
    const all = listWorkspaceGrants().sort((x, y) => x.workspaceId.localeCompare(y.workspaceId));
    expect(all).toEqual([
      { workspaceId: 'w-1', dirs: ['/tmp/a'] },
      { workspaceId: 'w-2', dirs: ['/tmp/b'] },
    ]);
  });

  it('生命周期：clearSessionGrants + deleteSession 挂接清理（spec §4）', () => {
    grantWriteDirs('session', 's-1', ['/tmp/a']);
    clearSessionGrants('s-1');
    expect(getGrantedDirs('s-1', null)).toEqual([]);
    // deleteSession 挂接验证：授权后走会话删除路径
    grantWriteDirs('session', 's-2', ['/tmp/b']);
    deleteSession('s-2');
    expect(getGrantedDirs('s-2', null)).toEqual([]);
    const cnt = getDb()
      .prepare("SELECT COUNT(*) AS c FROM kv_store WHERE key = 'sandbox_write_grant_session_s-2'")
      .get() as { c: number };
    expect(cnt.c).toBe(0);
  });

  it('生命周期：deleteWorkspace 级联删 sessions（FK CASCADE）不绕过会话键清理（终审 I3）', () => {
    grantWriteDirs('session', 's-ws-cas-1', ['/tmp/a']);
    grantWriteDirs('session', 's-ws-cas-2', ['/tmp/b']);
    grantWriteDirs('workspace', 'w-cas', ['/tmp/c']);
    getDb()
      .prepare('INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)')
      .run('w-cas', '级联测试', '/tmp/none', 'u-test');
    for (const sid of ['s-ws-cas-1', 's-ws-cas-2']) {
      getDb()
        .prepare('INSERT INTO sessions (id, workspace_id, title, title_auto, kind, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
        .run(sid, 'w-cas', 't', 'chat', Date.now(), Date.now());
    }
    deleteWorkspace('w-cas');
    // ws 键 + 其下全部 session 键都消失（CASCADE 路径不残留）
    const cnt = getDb()
      .prepare("SELECT COUNT(*) c FROM kv_store WHERE key LIKE 'sandbox_write_grant_%'")
      .get() as { c: number };
    expect(cnt.c).toBe(0);
  });

  it('生命周期：deleteWorkspace 挂接清理工作空间键', () => {
    grantWriteDirs('workspace', 'w-del', ['/tmp/a']);
    getDb()
      .prepare('INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)')
      .run('w-del', '临时测试空间', '/tmp/none', 'u-test');
    deleteWorkspace('w-del');
    expect(getGrantedDirs(null, 'w-del')).toEqual([]);
    const cnt = getDb()
      .prepare("SELECT COUNT(*) AS c FROM kv_store WHERE key = 'sandbox_write_grant_ws_w-del'")
      .get() as { c: number };
    expect(cnt.c).toBe(0);
  });
});
