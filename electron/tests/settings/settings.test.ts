// electron/tests/settings/settings.test.ts
//
// v1.4 settings/crud 测试：全局/会话配置 CRUD + 优先级解析。
// v23：room_settings 表已删除，会话级配置存 sessions.settings_json（经 crud 转调 sessions repo）。
// DB 隔离采用仓库既定模式：process.env.AP_USER_DATA_DIR 指向临时目录 + closeDb 复位单例。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  getGlobalSettings,
  updateGlobalSettings,
  getSessionSettings,
  updateSessionSettings,
  resolveMaxToolCalls,
} from '../../src/main/settings/crud';
import { insertSession } from '../../src/main/storage/sessions/repo';

const tmpRoot = path.join(os.tmpdir(), `ap-settings-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // sessions.workspace_id 外键依赖
  getDb()
    .prepare(
      `INSERT INTO workspaces
         (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('ws1', 'WS', '', '/tmp', 0, '@owner:s', '📁');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('settings/crud', () => {
  describe('全局配置', () => {
    it('默认 maxToolCalls = 10', () => {
      const s = getGlobalSettings();
      expect(s.maxToolCalls).toBe(10);
    });

    it('更新 maxToolCalls', () => {
      updateGlobalSettings({ maxToolCalls: 50 });
      expect(getGlobalSettings().maxToolCalls).toBe(50);
    });

    it('部分更新不丢其他字段', () => {
      updateGlobalSettings({ maxToolCalls: 50 });
      updateGlobalSettings({});
      expect(getGlobalSettings().maxToolCalls).toBe(50);
    });
  });

  describe('会话配置', () => {
    it('默认 maxToolCalls = null（继承全局）', () => {
      const s = insertSession({ workspaceId: 'ws1', title: '会话 1' });
      expect(getSessionSettings(s.id).maxToolCalls).toBeNull();
    });

    it('更新会话 maxToolCalls', () => {
      const s = insertSession({ workspaceId: 'ws1', title: '会话 1' });
      updateSessionSettings(s.id, { maxToolCalls: 20 });
      expect(getSessionSettings(s.id).maxToolCalls).toBe(20);
    });

    it('清回 null（继承全局）', () => {
      const s = insertSession({ workspaceId: 'ws1', title: '会话 1' });
      updateSessionSettings(s.id, { maxToolCalls: 20 });
      updateSessionSettings(s.id, { maxToolCalls: null });
      expect(getSessionSettings(s.id).maxToolCalls).toBeNull();
    });
  });

  describe('会话冲突策略 conflictStrategy', () => {
    it('默认 conflictStrategy = ask', () => {
      const s = insertSession({ workspaceId: 'ws1', title: '会话 2' });
      expect(getSessionSettings(s.id).conflictStrategy).toBe('ask');
    });

    it('更新 conflictStrategy', () => {
      const s = insertSession({ workspaceId: 'ws1', title: '会话 2' });
      updateSessionSettings(s.id, { conflictStrategy: 'preempt' });
      expect(getSessionSettings(s.id).conflictStrategy).toBe('preempt');
    });

    it('部分更新 conflictStrategy 不影响 maxToolCalls', () => {
      const s = insertSession({ workspaceId: 'ws1', title: '会话 2' });
      updateSessionSettings(s.id, { maxToolCalls: 5 });
      updateSessionSettings(s.id, { conflictStrategy: 'queue' });
      const cfg = getSessionSettings(s.id);
      expect(cfg.maxToolCalls).toBe(5);
      expect(cfg.conflictStrategy).toBe('queue');
    });
  });

  describe('resolveMaxToolCalls 优先级', () => {
    it('会话级覆盖全局', () => {
      const s = insertSession({ workspaceId: 'ws1', title: '会话 1' });
      updateGlobalSettings({ maxToolCalls: 10 });
      updateSessionSettings(s.id, { maxToolCalls: 50 });
      expect(resolveMaxToolCalls(s.id)).toBe(50);
    });

    it('会话 null 继承全局', () => {
      const s = insertSession({ workspaceId: 'ws1', title: '会话 1' });
      updateGlobalSettings({ maxToolCalls: 30 });
      expect(resolveMaxToolCalls(s.id)).toBe(30);
    });

    it('全局和会话都未设 → 默认 10', () => {
      const s = insertSession({ workspaceId: 'ws1', title: '会话 1' });
      expect(resolveMaxToolCalls(s.id)).toBe(10);
    });
  });
});
