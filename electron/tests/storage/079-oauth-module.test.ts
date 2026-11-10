// electron/tests/storage/079-oauth-module.test.ts
//
// 迁移 079 专项（OAuth 模块 spec 2026-11-10 §6.2）：oauth_connections 元数据表
// 落库 + mcp_definitions 两列绑定（oauth_connection_id / oauth_env_var）。
// 断言覆盖：
//   1. 建表列全集（缺列即失败，防「只建了一半」）
//   2. MCP 存量行绑定列均为 NULL（空 = 不走 OAuth，零行为变化）
//   3. 服务端默认值逐项核对（回环主机 / 端口 NULL / 未放宽 TLS / connected / none）
//   4. JSON 列默认 '{}' 且 provider 索引存在（查询路径支撑）
//   5. 079 注册在 MIGRATIONS 末尾（前向演进单点，防版本回退）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { loadMigrations } from '../../src/main/storage/migrations';

const tmpRoot = path.join(os.tmpdir(), `ap-mig079-${Date.now()}-${process.pid}`);

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

function columns(table: string): string[] {
  const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe('migration 079 OAuth 模块', () => {
  it('建 oauth_connections 表且列齐全', () => {
    const cols = columns('oauth_connections');
    for (const c of [
      'id', 'provider_key', 'display_name', 'account_label', 'issuer',
      'authorization_endpoint', 'token_endpoint', 'registration_endpoint',
      'revocation_endpoint', 'userinfo_endpoint', 'client_id', 'client_auth_method',
      'scopes', 'resource', 'extra_authorize_params', 'extra_token_params',
      'redirect_host', 'redirect_port', 'allow_insecure_tls', 'status',
      'expires_at', 'last_refreshed_at', 'source', 'created_at', 'updated_at',
    ]) {
      expect(cols).toContain(c);
    }
  });

  it('mcp_definitions 增两列且存量行为 NULL', () => {
    const cols = columns('mcp_definitions');
    expect(cols).toContain('oauth_connection_id');
    expect(cols).toContain('oauth_env_var');
    getDb()
      .prepare(
        `INSERT INTO mcp_definitions (id, name, version, transport, command, args)
         VALUES ('m1', 'legacy', '1.0.0', 'stdio', 'echo', '[]')`,
      )
      .run();
    const row = getDb()
      .prepare('SELECT oauth_connection_id, oauth_env_var FROM mcp_definitions WHERE id = ?')
      .get('m1') as { oauth_connection_id: string | null; oauth_env_var: string | null };
    expect(row.oauth_connection_id).toBeNull();
    expect(row.oauth_env_var).toBeNull();
  });

  it('默认值正确（回环主机 / 未放宽 TLS / connected）', () => {
    getDb()
      .prepare(
        `INSERT INTO oauth_connections
           (id, provider_key, display_name, authorization_endpoint, token_endpoint,
            client_id, created_at, updated_at)
         VALUES ('c1', 'pk', 'GitHub', 'https://a/auth', 'https://a/token', 'cid', 'now', 'now')`,
      )
      .run();
    const row = getDb()
      .prepare(
        'SELECT redirect_host, redirect_port, allow_insecure_tls, status, client_auth_method FROM oauth_connections WHERE id = ?',
      )
      .get('c1') as Record<string, unknown>;
    expect(row.redirect_host).toBe('127.0.0.1');
    expect(row.redirect_port).toBeNull();
    expect(row.allow_insecure_tls).toBe(0);
    expect(row.status).toBe('connected');
    expect(row.client_auth_method).toBe('none');
  });

  it('JSON 列默认 {} / scopes 默认空串 / source 默认 manual 且 provider 索引存在', () => {
    getDb()
      .prepare(
        `INSERT INTO oauth_connections
           (id, provider_key, display_name, authorization_endpoint, token_endpoint,
            client_id, created_at, updated_at)
         VALUES ('c2', 'pk2', 'GitLab', 'https://b/auth', 'https://b/token', 'cid2', 'now', 'now')`,
      )
      .run();
    const row = getDb()
      .prepare(
        'SELECT extra_authorize_params, extra_token_params, scopes, source, account_label FROM oauth_connections WHERE id = ?',
      )
      .get('c2') as Record<string, unknown>;
    expect(row.extra_authorize_params).toBe('{}');
    expect(row.extra_token_params).toBe('{}');
    expect(row.scopes).toBe('');
    expect(row.source).toBe('manual');
    expect(row.account_label).toBe('');

    // provider_key 索引：查 sqlite_master 证明索引真实落库（不只靠 CREATE 语句存在）
    const indexes = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = 'oauth_connections'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_oauth_connections_provider');
  });

  it('079 注册为最新迁移（追加在数组末尾）', () => {
    const versions = loadMigrations().map((m) => m.version);
    expect(versions).toContain(79);
    expect(versions[versions.length - 1]).toBe(79);
    // 版本唯一性（重复注册会让 runner 静默跳过第二条，属契约破坏）
    expect(new Set(versions).size).toBe(versions.length);
  });
});
