// electron/tests/hub/workspace-dir-settings.test.ts
//
// 节点工作目录设置 store（2026-10-27 节点互联「工作目录」）：
//   1. 默认态：未写 → rootDir=null，effective=default=<userData>/workspaces
//   2. 写自定义 → 读回 resolve 归一；view 的 effective 跟随
//   3. 写 null → 恢复默认
//   4. 相对路径拒绝（目录选择器产物恒绝对——防半截配置落库）
//   5. 脏数据容错：坏 JSON → 回默认（config-store 同款读侧纪律）
//   6. rootDir 不存在不视为非法（首写时目录可以还没建——落位时才创建）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import {
  createHubWorkspaceDirStore,
  defaultWorkspaceRootDir,
} from '../../src/main/hub/workspace-dir-settings';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-wsdir-'));

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('createHubWorkspaceDirStore', () => {
  it('默认态：rootDir=null，effective 与 default 同为 <userData>/workspaces', () => {
    const store = createHubWorkspaceDirStore();
    const view = store.view();
    expect(view.rootDir).toBeNull();
    expect(view.defaultRootDir).toBe(path.join(tmpRoot, 'workspaces'));
    expect(view.effectiveRootDir).toBe(view.defaultRootDir);
  });

  it('写自定义根 → 读回绝对路径归一，view.effective 跟随', () => {
    const custom = path.join(tmpRoot, '我的空间根');
    const store = createHubWorkspaceDirStore();
    const view = store.write({ rootDir: path.join(custom, '..', '我的空间根') });
    expect(view.rootDir).toBe(custom); // resolve 归一
    expect(view.effectiveRootDir).toBe(custom);
    expect(store.view().rootDir).toBe(custom);
  });

  it('写 null → 恢复默认（effective=default）', () => {
    const store = createHubWorkspaceDirStore();
    store.write({ rootDir: path.join(tmpRoot, 'a') });
    const view = store.write({ rootDir: null });
    expect(view.rootDir).toBeNull();
    expect(view.effectiveRootDir).toBe(view.defaultRootDir);
  });

  it('相对路径拒绝并抛错（不落库）', () => {
    const store = createHubWorkspaceDirStore();
    expect(() => store.write({ rootDir: 'relative/dir' })).toThrow(/绝对路径/);
    expect(store.view().rootDir).toBeNull(); // 未被半截配置污染
  });

  it('脏数据容错：坏 JSON → 回默认', () => {
    getDb()
      .prepare(`INSERT INTO kv_store (key, value, updated_at) VALUES ('hub_workspace_dir', '{oops', datetime('now'))`)
      .run();
    const view = createHubWorkspaceDirStore().view();
    expect(view.rootDir).toBeNull();
    expect(view.effectiveRootDir).toBe(view.defaultRootDir);
  });

  it('defaultWorkspaceRootDir 纯函数：<userData>/workspaces', () => {
    expect(defaultWorkspaceRootDir()).toBe(path.join(tmpRoot, 'workspaces'));
  });
});
