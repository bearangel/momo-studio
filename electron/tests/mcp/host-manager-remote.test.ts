// electron/tests/mcp/host-manager-remote.test.ts
//
// P2 Task 2：mcp_definitions 二态读写（stdio / streamable_http）测试。
//   - remote 定义注册 → getMcpConfig 读回 transport/url/headers（command 空串占位）
//   - stdio 定义缺省 transport 不受影响（存量行为兼容）
//   - listRegistered 返回二态字段与 source 扩展值（smithery）
//   - 错误路径专项（momo-test-rules 铁律 3）：
//       remote url 非 https → 注册抛错
//       DB 行 transport 非法值 → 读回白名单外回退 'stdio'
//       DB 行 headers_json 坏 JSON → 读回 undefined 不抛（+ warn）
//       DB 行 headers_json 合法 JSON 但非 plain object（数组等）→ 同上
//
// DB 隔离沿用仓库既定模式（照抄 mcp-list-registered.test.ts）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - runMigrations() 经 getDb() 单例建表（真实跑全量迁移，含 038）
//   - closeDb() 在 afterEach 复位单例
//   - 非法行 / 坏 JSON 用例直接经 getDb() 造行（注册链路必然写合法值，
//     只有脏数据路径能覆盖白名单与 JSON 容错）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  registerMcpDefinition,
  getMcpConfig,
  listRegistered,
} from '../../src/main/mcp/host-manager';

const tmpRoot = path.join(os.tmpdir(), `ap-mcp-remote-test-${Date.now()}`);

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

describe('mcp_definitions 二态读写（P2 remote transport）', () => {
  it('注册 remote 定义 → getMcpConfig 读回 transport/url/headers', () => {
    registerMcpDefinition({
      id: 'r1', name: 'remote-weather', version: '1.0.0',
      transport: 'streamable_http', command: '', args: [],
      url: 'https://mcp.example.com/weather',
      headers: { Authorization: 'Bearer tk' },
      source: 'custom',
    });
    const cfg = getMcpConfig('remote-weather');
    expect(cfg?.transport).toBe('streamable_http');
    expect(cfg?.url).toBe('https://mcp.example.com/weather');
    expect(cfg?.headers).toEqual({ Authorization: 'Bearer tk' });
    expect(cfg?.command).toBe(''); // NOT NULL 占位
  });

  it('注册 stdio 定义不受影响（缺省 transport）', () => {
    registerMcpDefinition({
      id: 's1', name: 'fs', version: '1.0.0',
      command: 'npx', args: ['-y', 'mcp-server-fs'], source: 'smithery',
    });
    const cfg = getMcpConfig('fs');
    expect(cfg?.transport).toBe('stdio');
    expect(cfg?.command).toBe('npx');
    // 锁 stdio 行 NULL 不变量：url / headers_json 仅 remote 形态落值
    const row = getDb()
      .prepare('SELECT url, headers_json FROM mcp_definitions WHERE name = ?')
      .get('fs') as { url: string | null; headers_json: string | null };
    expect(row.url).toBeNull();
    expect(row.headers_json).toBeNull();
  });

  it('listRegistered 返回二态字段与 source 扩展值', () => {
    registerMcpDefinition({
      id: 'r2', name: 'ms-2', version: '1.0.0',
      transport: 'streamable_http', command: '', args: [],
      url: 'https://x.test/mcp', source: 'smithery',
    });
    const row = listRegistered().find((m) => m.name === 'ms-2');
    expect(row?.source).toBe('smithery');
    expect(row?.transport).toBe('streamable_http');
    expect(row?.url).toBe('https://x.test/mcp');
  });

  it('remote url 非 https → 注册抛错（安全边界）', () => {
    expect(() =>
      registerMcpDefinition({
        id: 'bad', name: 'bad-remote', version: '1.0.0',
        transport: 'streamable_http', command: '', args: [],
        url: 'http://x.test/mcp',
      }),
    ).toThrow(/https/);
    // 校验失败的定义不得落库
    expect(getMcpConfig('bad-remote')).toBeNull();
  });

  it('remote 缺 url → 注册抛错', () => {
    expect(() =>
      registerMcpDefinition({
        id: 'bad2', name: 'no-url', version: '1.0.0',
        transport: 'streamable_http', command: '', args: [],
      }),
    ).toThrow(/url/);
  });

  it('DB 行 transport 白名单外 → 读回回退 stdio', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO mcp_definitions (id, name, version, transport, command)
       VALUES ('w1', 'weird', '1.0.0', 'websocket', 'npx foo')`,
    ).run();
    expect(getMcpConfig('weird')?.transport).toBe('stdio');
    expect(listRegistered().find((m) => m.name === 'weird')?.transport).toBe('stdio');
  });

  it('DB 行 headers_json 坏 JSON → 读回 headers undefined 不抛', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO mcp_definitions (id, name, version, transport, command, url, headers_json)
       VALUES ('h1', 'corrupt', '1.0.0', 'streamable_http', '', 'https://x.test/mcp', '{not json')`,
    ).run();
    const cfg = getMcpConfig('corrupt');
    expect(cfg?.headers).toBeUndefined();
    expect(() => listRegistered()).not.toThrow();
    expect(listRegistered().find((m) => m.name === 'corrupt')?.headers).toBeUndefined();
  });

  it('DB 行 headers_json 合法 JSON 但非 plain object → 读回 headers undefined 不抛', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO mcp_definitions (id, name, version, transport, command, url, headers_json)
       VALUES ('h2', 'array-headers', '1.0.0', 'streamable_http', '', 'https://x.test/mcp', '["a","b"]')`,
    ).run();
    expect(getMcpConfig('array-headers')?.headers).toBeUndefined();
    expect(listRegistered().find((m) => m.name === 'array-headers')?.headers).toBeUndefined();
  });

  it('注册含 cwd 的 stdio 定义 → getMcpConfig / listRegistered 读回 cwd 精确值', () => {
    registerMcpDefinition({
      id: 'c1', name: 'bundle-mcp', version: '1.0.0',
      command: 'node', args: ['server/index.js'], source: 'custom',
      cwd: '/tmp/some-bundle-dir',
    });
    const cfg = getMcpConfig('bundle-mcp');
    expect(cfg?.cwd).toBe('/tmp/some-bundle-dir');
    expect(listRegistered().find((m) => m.name === 'bundle-mcp')?.cwd).toBe(
      '/tmp/some-bundle-dir',
    );
  });

  it('注册不含 cwd 的定义 → 读回 cwd undefined 且 DB 行 NULL（存量零变化）', () => {
    registerMcpDefinition({
      id: 'c2', name: 'plain-mcp', version: '1.0.0',
      command: 'npx', args: ['-y', 'mcp-server-fs'], source: 'custom',
    });
    expect(getMcpConfig('plain-mcp')?.cwd).toBeUndefined();
    expect(listRegistered().find((m) => m.name === 'plain-mcp')?.cwd).toBeUndefined();
    // 锁 DB 侧不变量：缺省 cwd 落 NULL（spawn 透传据此判定零变化）
    const row = getDb()
      .prepare('SELECT cwd FROM mcp_definitions WHERE name = ?')
      .get('plain-mcp') as { cwd: string | null };
    expect(row.cwd).toBeNull();
  });
});
