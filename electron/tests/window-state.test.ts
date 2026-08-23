// electron/tests/window-state.test.ts
//
// 窗口状态持久化测试（P2 Task 1）。
// 覆盖：save/load 往返保真 / 无记录返回 null / clampToDisplays 越界坐标剔除
//       （外接屏拔掉后残留坐标防窗口消失）/ 损坏记录（非法 JSON、缺宽高）防御。
//
// DB 隔离沿用仓库既定模式（参考 tests/storage/sessions-repo.test.ts）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - runMigrations() 建表（kv_store 自 v1 起存在）
//   - closeDb() 在 afterEach 复位单例
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../src/main/storage/db';
import {
  saveWindowState,
  loadWindowState,
  clampToDisplays,
  type WindowState,
  type WorkAreaRect,
} from '../src/main/window-state';

const tmpRoot = path.join(os.tmpdir(), `ap-window-state-${Date.now()}`);
const KEY = 'window_state';

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

describe('window-state 持久化', () => {
  it('saveWindowState / loadWindowState 往返保真', () => {
    const state: WindowState = { x: 100, y: 200, width: 1280, height: 800, maximized: true };
    saveWindowState(state);
    expect(loadWindowState()).toEqual(state);
  });

  it('loadWindowState 无记录时返回 null', () => {
    expect(loadWindowState()).toBeNull();
  });

  it('clampToDisplays 剔除超出所有屏幕 workArea 的坐标（防窗口消失），保留尺寸', () => {
    // 单屏 1920x1080（模拟外接屏拔掉后只剩主屏）
    const displays: WorkAreaRect[] = [{ x: 0, y: 0, width: 1920, height: 1080 }];

    // 场景 1：坐标落在已不存在的屏（x=2000 越界）→ 丢弃 x/y，保留尺寸
    const offscreen = clampToDisplays(
      { x: 2000, y: 500, width: 1280, height: 800, maximized: false },
      displays,
    );
    expect(offscreen).toEqual({ x: null, y: null, width: 1280, height: 800, maximized: false });

    // 场景 2：坐标在屏内 → 原样保留
    const onscreen = clampToDisplays(
      { x: 100, y: 100, width: 1280, height: 800, maximized: false },
      displays,
    );
    expect(onscreen).toEqual({ x: 100, y: 100, width: 1280, height: 800, maximized: false });

    // 场景 3：多屏时任一屏命中即保留（副屏 workArea x 偏移 1920）
    const dual: WorkAreaRect[] = [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 2560, height: 1440 },
    ];
    const onSecond = clampToDisplays(
      { x: 2000, y: 500, width: 1280, height: 800, maximized: false },
      dual,
    );
    expect(onSecond).toEqual({ x: 2000, y: 500, width: 1280, height: 800, maximized: false });
  });

  it('loadWindowState 记录损坏（非法 JSON / 缺宽高）时返回 null，不抛错', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    ).run(KEY, '{not valid json');
    expect(loadWindowState()).toBeNull();

    db.prepare(`UPDATE kv_store SET value = ? WHERE key = ?`).run(
      JSON.stringify({ x: 1, y: 2, maximized: true }),
      KEY,
    );
    expect(loadWindowState()).toBeNull();
  });
});
