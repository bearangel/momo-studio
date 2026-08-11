// electron/tests/mcp/mcp-list-registered.test.ts
//
// v1.6 Task 6：listRegistered / deleteRegistered 测试。
//   - listRegistered 返回所有已注册 MCP，含 source 区分（marketplace / custom）
//   - registerMcpDefinition 缺省 source 时默认 marketplace（DB 列默认值）
//   - deleteRegistered 仅 custom 可删；marketplace 抛错提示用卸载按钮
//   - deleteRegistered 不存在的 name 静默跳过
//
// DB 隔离沿用仓库既定模式（参考 016-assignment-capabilities.test.ts）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - runMigrations() 经 getDb() 单例建表
//   - closeDb() 在 afterEach 复位单例
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import {
  registerMcpDefinition,
  listRegistered,
  deleteRegistered,
} from '../../src/main/mcp/host-manager';

const tmpRoot = path.join(os.tmpdir(), `ap-mcp-list-test-${Date.now()}`);

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

describe('mcp listRegistered / deleteRegistered', () => {
  it('listRegistered 返回所有已注册 MCP 含 source 区分', () => {
    registerMcpDefinition({
      id: '1',
      name: 'a',
      version: '1',
      command: 'npx',
      args: [],
      source: 'marketplace',
    });
    registerMcpDefinition({
      id: '2',
      name: 'b',
      version: '1',
      command: 'node',
      args: [],
      source: 'custom',
    });
    const list = listRegistered();
    expect(list).toHaveLength(2);
    expect(list.find((m) => m.name === 'a')?.source).toBe('marketplace');
    expect(list.find((m) => m.name === 'b')?.source).toBe('custom');
  });

  it('registerMcpDefinition 缺省 source 时默认 marketplace', () => {
    registerMcpDefinition({ id: '1', name: 'a', version: '1', command: 'npx', args: [] });
    const list = listRegistered();
    expect(list[0].source).toBe('marketplace');
  });

  it('deleteRegistered 仅 custom 可删；marketplace 抛错', () => {
    registerMcpDefinition({
      id: '1',
      name: 'mp',
      version: '1',
      command: 'npx',
      args: [],
      source: 'marketplace',
    });
    registerMcpDefinition({
      id: '2',
      name: 'cu',
      version: '1',
      command: 'node',
      args: [],
      source: 'custom',
    });
    expect(() => deleteRegistered('mp')).toThrow(/marketplace/);
    deleteRegistered('cu');
    expect(listRegistered()).toHaveLength(1);
  });

  it('deleteRegistered 不存在的 name 静默跳过', () => {
    expect(() => deleteRegistered('nonexistent')).not.toThrow();
  });
});
