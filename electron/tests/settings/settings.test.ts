// electron/tests/settings/settings.test.ts
//
// v1.4 settings/crud 测试：全局/房间配置 CRUD + 优先级解析。
// DB 隔离采用仓库既定模式：process.env.AP_USER_DATA_DIR 指向临时目录 + closeDb 复位单例。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import {
  getGlobalSettings,
  updateGlobalSettings,
  getRoomSettings,
  updateRoomSettings,
  resolveMaxToolCalls,
} from '../../src/main/settings/crud';

const tmpRoot = path.join(os.tmpdir(), `ap-settings-test-${Date.now()}`);

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

  describe('房间配置', () => {
    it('默认 max_tool_calls = null（继承全局）', () => {
      const s = getRoomSettings('!room1:server');
      expect(s.maxToolCalls).toBeNull();
    });

    it('更新房间 max_tool_calls', () => {
      updateRoomSettings('!room1:server', { maxToolCalls: 20 });
      expect(getRoomSettings('!room1:server').maxToolCalls).toBe(20);
    });

    it('清回 null（继承全局）', () => {
      updateRoomSettings('!room1:server', { maxToolCalls: 20 });
      updateRoomSettings('!room1:server', { maxToolCalls: null });
      expect(getRoomSettings('!room1:server').maxToolCalls).toBeNull();
    });
  });

  describe('resolveMaxToolCalls 优先级', () => {
    it('房间级覆盖全局', () => {
      updateGlobalSettings({ maxToolCalls: 10 });
      updateRoomSettings('!room1:server', { maxToolCalls: 50 });
      expect(resolveMaxToolCalls('!room1:server')).toBe(50);
    });

    it('房间 null 继承全局', () => {
      updateGlobalSettings({ maxToolCalls: 30 });
      expect(resolveMaxToolCalls('!room1:server')).toBe(30);
    });

    it('全局和房间都未设 → 默认 10', () => {
      expect(resolveMaxToolCalls('!room1:server')).toBe(10);
    });
  });
});
