// electron/tests/mcp/oauth-401.test.ts
//
// Task 13：结构化 401 + OAuth 微触发测试。
//   - HttpMcpClient 客户端边界：401 抛 McpHttpError（带 status 与 www-authenticate，
//     真实 401 HTTP fixture，不 mock http/fetch）
//   - 已绑定连接的 MCP 遇 401 → host-manager 翻译为 OAuthFailure('needs_reauth')，
//     带 connectionId，且池不留死实例（下次调用可重走完整启动）
//   - bindConnectionToMcp：写绑定 + env 变量名（stdio 传 envVar）并驱逐该 MCP 池实例
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { getMcpConfig, getOrStartMcp, setMcpAuthResolver } from '../../src/main/mcp/host-manager';
import { McpHttpError, HttpMcpClient } from '../../src/main/mcp/http-client';
import { bindConnectionToMcp } from '../../src/main/oauth/mcp-trigger';

const tmpRoot = path.join(os.tmpdir(), `ap-mcp-401-${Date.now()}-${process.pid}`);

let server: http.Server;
let base = '';

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  server = http.createServer((req, res) => {
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer resource_metadata="https://auth.example.com/.well-known/oauth-protected-resource"',
    });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  getDb()
    .prepare(
      `INSERT INTO mcp_definitions (id, name, version, transport, command, args, url, oauth_connection_id)
       VALUES ('m1', 'needs-auth', '1.0.0', 'streamable_http', '', '[]', ?, 'conn-1')`,
    )
    .run(`${base}/mcp`);
});

afterEach(async () => {
  setMcpAuthResolver(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('McpHttpError', () => {
  it('客户端层 401 抛结构化错误，带 status 与 www-authenticate', async () => {
    // 直接测 HttpMcpClient：host-manager 会把 401 翻译成 OAuthFailure，
    // 结构化信息在客户端边界断言（否则该分支永远看不到）
    const client = new HttpMcpClient({
      id: 'm1', name: 'needs-auth', version: '1.0.0', transport: 'streamable_http',
      command: '', args: [], url: `${base}/mcp`,
    });
    try {
      await client.connect();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(McpHttpError);
      const httpErr = err as McpHttpError;
      expect(httpErr.status).toBe(401);
      expect(httpErr.wwwAuthenticate).toContain('resource_metadata=');
    }
  });

  it('已绑定连接遇 401 抛 needs_reauth（带 connectionId），且池不留死实例', async () => {
    setMcpAuthResolver(async (config) => config);
    await expect(getOrStartMcp('ws-1', getMcpConfig('needs-auth')!))
      .rejects.toMatchObject({ code: 'needs_reauth', connectionId: 'conn-1' });
  });
});

describe('bindConnectionToMcp', () => {
  it('写绑定并驱逐该 MCP 的全部池实例；stdio 落 envVar、http 落 null', async () => {
    // brief 的 bind 用例原 fixture 为 streamable_http 却断言 envVar='GH_TOKEN'，
    // 与「stdio 传 envVar、http 落 null」的交付语义矛盾——补 stdio 行断言
    // envVar，http 行（needs-auth）锁 null 分支（momo-test-rules 铁律 3：两分支都覆盖）
    getDb()
      .prepare(
        `INSERT INTO mcp_definitions (id, name, version, transport, command, args)
         VALUES ('m2', 'stdio-auth', '1.0.0', 'stdio', 'npx', '["-y", "stdio-mcp"]')`,
      )
      .run();
    await bindConnectionToMcp('stdio-auth', 'conn-2', 'GH_TOKEN');
    await bindConnectionToMcp('needs-auth', 'conn-1', 'GH_TOKEN');
    const stdioRow = getDb()
      .prepare('SELECT oauth_connection_id, oauth_env_var FROM mcp_definitions WHERE name = ?')
      .get('stdio-auth') as { oauth_connection_id: string; oauth_env_var: string };
    expect(stdioRow.oauth_connection_id).toBe('conn-2');
    expect(stdioRow.oauth_env_var).toBe('GH_TOKEN');
    const httpRow = getDb()
      .prepare('SELECT oauth_connection_id, oauth_env_var FROM mcp_definitions WHERE name = ?')
      .get('needs-auth') as { oauth_connection_id: string; oauth_env_var: string };
    expect(httpRow.oauth_connection_id).toBe('conn-1');
    expect(httpRow.oauth_env_var).toBeNull();
  });
});
