// electron/tests/browser/settings-store.test.ts
//
// BrowserSettingsStore 测试（v2.7 McpBrowser Task 6）：
//   读侧——未知 wsId 全默认 / 坏 JSON 列容错（空数组 + warn）/ trust 脏值回退 ask
//   写侧——读写往返 / 部分 patch 合并语义 / 域名条目写入归一化全分支
//          （trim / 去 scheme / 去端口 / 小写 / 丢空——T1 review 裁定，binding）
//   错误路径——非法 trust 枚举 throw / 写不存在的 workspace 外键违规 throw
//
// fixture 照 tests/journal/store.test.ts：AP_USER_DATA_DIR 注入临时目录 +
// runMigrations 真实建库（含 v34）——刻意不手搓 workspace_settings 简化表，
// 简化 fixture 会掩盖列名/约束漂移（momo-test-rules 铁律 1）。
// mock 边界：仅 logger（warn 断言）；db 与被测 store 全真实。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../src/main/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from '../../src/main/logger';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { createBrowserSettingsStore } from '../../src/main/browser/settings-store';
import type { DB } from 'better-sqlite3';

const tmpRoot = path.join(os.tmpdir(), `ap-browser-settings-${Date.now()}`);

let db: DB;

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES ('ws-A', 'WS', '', '/tmp', 0, '@owner:s', '📁')`,
  ).run();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('BrowserSettingsStore.read', () => {
  it('未知 wsId → 全默认（ask / false / [] / [] / false / 380）', () => {
    const store = createBrowserSettingsStore(db);
    expect(store.read('ws-unknown')).toEqual({
      trust: 'ask',
      evaluateEnabled: false,
      blacklist: [],
      whitelist: [],
      sidebarCollapsed: false,
      sidebarWidth: 380,
    });
  });

  it('坏 JSON 列 → 空数组 + logger.warn（不 throw）', () => {
    db.prepare(
      `INSERT INTO workspace_settings (workspace_id, browser_domain_blacklist, browser_domain_whitelist)
       VALUES ('ws-A', 'not-json{{', '{"broken"')`,
    ).run();
    const store = createBrowserSettingsStore(db);
    const settings = store.read('ws-A');
    expect(settings.blacklist).toEqual([]);
    expect(settings.whitelist).toEqual([]);
    // 两列各 warn 一次（列名可辨识，便于定位脏数据）
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(2);
  });

  it('合法 JSON 但非数组（{"a":1}）→ 空数组 + warn（parseListColumn「非数组」分支）', () => {
    db.prepare(
      `INSERT INTO workspace_settings (workspace_id, browser_domain_blacklist)
       VALUES ('ws-A', '{"a":1}')`,
    ).run();
    const store = createBrowserSettingsStore(db);
    expect(store.read('ws-A').blacklist).toEqual([]);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
  });

  it('数组含非字符串元素（[1,"a"]）→ 过滤保留纯字符串项（不 throw 不混入数字）', () => {
    db.prepare(
      `INSERT INTO workspace_settings (workspace_id, browser_domain_whitelist)
       VALUES ('ws-A', '[1,"a"]')`,
    ).run();
    const store = createBrowserSettingsStore(db);
    expect(store.read('ws-A').whitelist).toEqual(['a']);
    // 非字符串元素被静默过滤（filter 类型守卫，无 warn——解析层只对整体失败 warn）
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('trust 脏值（库内非法枚举）→ 回退 ask + warn', () => {
    db.prepare(
      `INSERT INTO workspace_settings (workspace_id, trust_browser) VALUES ('ws-A', 'maybe')`,
    ).run();
    const store = createBrowserSettingsStore(db);
    expect(store.read('ws-A').trust).toBe('ask');
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
  });
});

describe('BrowserSettingsStore.write', () => {
  it('全量读写往返（六字段回显一致）', () => {
    const store = createBrowserSettingsStore(db);
    store.write('ws-A', {
      trust: 'always',
      evaluateEnabled: true,
      blacklist: ['evil.com'],
      whitelist: ['good.com'],
      sidebarCollapsed: true,
      sidebarWidth: 512,
    });
    expect(store.read('ws-A')).toEqual({
      trust: 'always',
      evaluateEnabled: true,
      blacklist: ['evil.com'],
      whitelist: ['good.com'],
      sidebarCollapsed: true,
      sidebarWidth: 512,
    });
  });

  it('部分 patch 合并语义：未给字段保持既有值不被覆盖', () => {
    const store = createBrowserSettingsStore(db);
    store.write('ws-A', { trust: 'deny' });
    store.write('ws-A', { sidebarWidth: 420 });
    const settings = store.read('ws-A');
    expect(settings.trust).toBe('deny'); // 第一次写保持
    expect(settings.sidebarWidth).toBe(420); // 第二次写生效
    expect(settings.evaluateEnabled).toBe(false); // 未动 → 默认
    expect(settings.blacklist).toEqual([]); // 未动 → 默认
    expect(settings.sidebarCollapsed).toBe(false); // 未动 → 默认
  });

  it('域名条目写入归一化全分支：trim / 去 scheme / 去端口 / 小写 / 丢空', () => {
    const store = createBrowserSettingsStore(db);
    store.write('ws-A', {
      blacklist: [
        '  https://Evil.COM  ', // trim + scheme + 小写
        'evil.com:8080', // 去端口
        'http://sub.Example.com:443', // scheme + 端口 + 小写（组合分支）
        'GOOD.com', // 仅小写
        '   ', // trim 后空 → 丢弃
      ],
      whitelist: ['//Loose.com'], // 协议相对 // 前缀
    });
    const settings = store.read('ws-A');
    expect(settings.blacklist).toEqual(['evil.com', 'evil.com', 'sub.example.com', 'good.com']);
    expect(settings.whitelist).toEqual(['loose.com']);
  });

  it('非法 trust 枚举 → throw（IPC 无类型边界 fail-fast）', () => {
    const store = createBrowserSettingsStore(db);
    expect(() => {
      store.write('ws-A', { trust: 'nope' as 'ask' });
    }).toThrow(/信任级别/);
    // 脏值未落库（行不存在，读回默认）
    expect(store.read('ws-A').trust).toBe('ask');
  });

  it('写不存在的 workspace → 外键违规 throw（错误路径）', () => {
    const store = createBrowserSettingsStore(db);
    expect(() => {
      store.write('ws-ghost', { trust: 'always' });
    }).toThrow(/FOREIGN KEY/);
  });
});
