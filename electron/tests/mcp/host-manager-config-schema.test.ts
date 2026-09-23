// electron/tests/mcp/host-manager-config-schema.test.ts
//
// P2.2 Task 1：mcp_definitions.config_schema 列读写测试。
//   - remote 定义带 configSchema 注册 → getMcpConfig / listRegistered 回读深等
//     （JSON 序列化往返不丢形状——含 x-from 分流元数据）
//   - schema 缺省注册 → 回读 undefined（DB 兜底 '{}' 视为无）+ DB 行锁 '{}'
//   - 错误路径专项（momo-test-rules 铁律 3）：
//       DB 行 config_schema 坏 JSON → 读回 undefined 不抛（+ warn）
//       DB 行 config_schema 合法 JSON 但非 plain object（数组等）→ 同上
//
// DB 隔离沿用仓库既定模式（照抄 host-manager-remote.test.ts）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - runMigrations() 经 getDb() 单例建表（真实跑全量迁移，含 040）
//   - closeDb() 在 afterEach 复位单例
//   - 脏数据用例直接经 getDb() 造行（注册链路必然写合法值，
//     只有脏数据路径能覆盖 JSON 容错）
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

const tmpRoot = path.join(os.tmpdir(), `ap-mcp-config-schema-test-${Date.now()}`);

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

describe('mcp_definitions.config_schema 读写（P2.2 Task 1）', () => {
  it('remote 定义带 configSchema 注册 → getMcpConfig / listRegistered 回读深等', () => {
    const schema = {
      required: ['k'],
      properties: {
        k: { title: 'K', description: '字段 k', 'x-from': 'header' as const },
      },
    };
    registerMcpDefinition({
      id: 'r1',
      name: 'schema-mcp',
      version: '1.0.0',
      transport: 'streamable_http',
      command: '',
      args: [],
      url: 'https://x.test/mcp',
      configSchema: schema,
      source: 'smithery',
    });
    const cfg = getMcpConfig('schema-mcp');
    // 深等——JSON 序列化往返不丢形状（含 x-from 分流元数据，Task 4 表单回填依赖）
    expect(cfg?.configSchema).toEqual(schema);
    expect(
      listRegistered().find((m) => m.name === 'schema-mcp')?.configSchema,
    ).toEqual(schema);
  });

  it('schema 缺省注册 → 回读 undefined（"{}" 视为无）+ DB 行锁 "{}"', () => {
    registerMcpDefinition({
      id: 'r2',
      name: 'plain-remote',
      version: '1.0.0',
      transport: 'streamable_http',
      command: '',
      args: [],
      url: 'https://x.test/mcp',
    });
    expect(getMcpConfig('plain-remote')?.configSchema).toBeUndefined();
    expect(
      listRegistered().find((m) => m.name === 'plain-remote')?.configSchema,
    ).toBeUndefined();
    // 锁 DB 侧不变量：缺省落 '{}'（NOT NULL DEFAULT 兜底语义，读取侧还原 undefined）
    const row = getDb()
      .prepare('SELECT config_schema FROM mcp_definitions WHERE name = ?')
      .get('plain-remote') as { config_schema: string };
    expect(row.config_schema).toBe('{}');
  });

  it('stdio 定义带 configSchema 同样可写读（列不分 transport，统一落库）', () => {
    registerMcpDefinition({
      id: 's1',
      name: 'stdio-with-schema',
      version: '1.0.0',
      command: 'npx',
      args: ['-y', 'mcp-server-fs'],
      configSchema: { properties: { token: { title: 'Token' } } },
    });
    expect(getMcpConfig('stdio-with-schema')?.configSchema).toEqual({
      properties: { token: { title: 'Token' } },
    });
  });

  it('DB 行 config_schema 坏 JSON → 读回 undefined 不抛', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO mcp_definitions (id, name, version, transport, command, url, config_schema)
       VALUES ('c1', 'corrupt-schema', '1.0.0', 'streamable_http', '', 'https://x.test/mcp', '{not json')`,
    ).run();
    const cfg = getMcpConfig('corrupt-schema');
    expect(cfg?.configSchema).toBeUndefined();
    expect(() => listRegistered()).not.toThrow();
    expect(
      listRegistered().find((m) => m.name === 'corrupt-schema')?.configSchema,
    ).toBeUndefined();
  });

  it('DB 行 config_schema 合法 JSON 但非 plain object → 读回 undefined 不抛', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO mcp_definitions (id, name, version, transport, command, url, config_schema)
       VALUES ('c2', 'array-schema', '1.0.0', 'streamable_http', '', 'https://x.test/mcp', '["required"]')`,
    ).run();
    expect(getMcpConfig('array-schema')?.configSchema).toBeUndefined();
    expect(
      listRegistered().find((m) => m.name === 'array-schema')?.configSchema,
    ).toBeUndefined();
  });
});
