// electron/tests/oauth/mcp-adapter.test.ts
//
// Task 11：MCP OAuth 适配器回归锁（spec §9）。
//   - applyMcpMaterial：纯函数直接测——http header 覆盖手填 / stdio env 合并 / 不改入参
//   - resolveMcpAuthMaterial：DB + keychain 注入（store.test.ts 同款模式）——
//     http → Bearer header；stdio → 指定 envVar 注入；错误路径专项：
//     缺 envVar（含纯空白）、连接不存在、连接失效
//   - wireMcpOAuth：真实 HTTP MCP fixture（oauth-binding.test.ts 同款）——
//     绑定注入生效 / 未绑定零注入 / 绑定不存在连接启动失败 /
//     池契约：实例存续期不重新解析 token
// DB 重度用例，按仓库规范用 --pool=forks 单目录跑。不记录任何 token 值。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  setKeychainImpl,
  __resetKeychainImplForTest,
} from '../../src/main/storage/keychain';
import { insertConnection } from '../../src/main/oauth/store';
import { saveTokenSet } from '../../src/main/oauth/keys';
import { OAuthFailure } from '../../src/main/oauth/types';
import {
  applyMcpMaterial,
  resolveMcpAuthMaterial,
  wireMcpOAuth,
} from '../../src/main/oauth/adapters/mcp';
import {
  getMcpConfig,
  getOrStartMcp,
  setMcpAuthResolver,
  setMcpOAuthBinding,
} from '../../src/main/mcp/host-manager';
import type { McpServerConfig } from '../../src/main/mcp/types';

// ---------- 纯函数用例的静态 config ----------

const httpConfig: McpServerConfig = {
  id: 'm1', name: 'gh', version: '1.0.0', transport: 'streamable_http',
  command: '', args: [], url: 'https://mcp.example.com', headers: { 'X-Existing': '1' },
};

const stdioConfig: McpServerConfig = {
  id: 'm2', name: 'local', version: '1.0.0', transport: 'stdio',
  command: 'node', args: ['server.js'], env: { PATH: '/usr/bin' },
};

describe('applyMcpMaterial', () => {
  it('http：Authorization 注入且不覆盖其他 header，url 不变', () => {
    const out = applyMcpMaterial(httpConfig, {
      connectionId: 'c1',
      headers: { Authorization: 'Bearer at' },
    });
    expect(out.headers).toEqual({ 'X-Existing': '1', Authorization: 'Bearer at' });
    expect(out.url).toBe(httpConfig.url);
  });

  it('http：OAuth 覆盖手填 Authorization', () => {
    const out = applyMcpMaterial(
      { ...httpConfig, headers: { Authorization: 'Bearer manual' } },
      { connectionId: 'c1', headers: { Authorization: 'Bearer oauth' } },
    );
    expect(out.headers?.Authorization).toBe('Bearer oauth');
  });

  it('stdio：env 合并，不覆盖 PATH', () => {
    const out = applyMcpMaterial(stdioConfig, {
      connectionId: 'c1',
      env: { GITHUB_TOKEN: 'at' },
    });
    expect(out.env).toEqual({ PATH: '/usr/bin', GITHUB_TOKEN: 'at' });
  });

  it('不修改入参（返回新对象）', () => {
    applyMcpMaterial(httpConfig, { connectionId: 'c1', headers: { Authorization: 'Bearer at' } });
    applyMcpMaterial(stdioConfig, { connectionId: 'c1', env: { GITHUB_TOKEN: 'at' } });
    expect(httpConfig.headers).toEqual({ 'X-Existing': '1' });
    expect(stdioConfig.env).toEqual({ PATH: '/usr/bin' });
  });

  it('空材料（无 headers/env）返回等值新对象（边界空值专项）', () => {
    const out = applyMcpMaterial(httpConfig, { connectionId: 'c1' });
    expect(out).toEqual(httpConfig);
    expect(out).not.toBe(httpConfig);
  });
});

// ---------- DB + keychain 注入（store.test.ts 同款模式） ----------

const tmpRoot = path.join(os.tmpdir(), `ap-oauth-mcp-adapter-${Date.now()}-${process.pid}`);
const vault = new Map<string, string>();

let server: http.Server;
let base = '';
let lastAuth = '';
let initializeCount = 0;

const baseConn = {
  providerKey: 'https://auth.example.com|cid||repo read',
  displayName: 'Example',
  authorizationEndpoint: 'https://auth.example.com/authorize',
  tokenEndpoint: 'https://auth.example.com/token',
  clientId: 'cid',
  scopes: 'repo read',
  source: 'manual' as const,
};

/** 种入凭据：expiresAt null = 永不触发刷新，ensureFresh 走 loadTokenSet 直取 */
async function seedToken(connectionId: string, accessToken: string): Promise<void> {
  await saveTokenSet(connectionId, {
    accessToken,
    refreshToken: 'rt',
    expiresAt: null,
    tokenType: 'Bearer',
    scope: 'repo',
  });
}

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  vault.clear();
  setKeychainImpl({
    setSecret: async (k, v) => {
      vault.set(k, v);
    },
    getSecret: async (k) => vault.get(k) ?? null,
    deleteSecret: async (k) => {
      vault.delete(k);
    },
  });
  // HTTP MCP fixture：真实 JSON-RPC initialize 握手，记录 Authorization 与握手次数
  lastAuth = '';
  initializeCount = 0;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => {
      lastAuth = req.headers.authorization ?? '';
      const msg = JSON.parse(body || '{}') as { id?: number; method?: string };
      if (msg.method === 'initialize') {
        initializeCount += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } }));
        return;
      }
      if (msg.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }));
        return;
      }
      res.writeHead(202);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  getDb()
    .prepare(
      `INSERT INTO mcp_definitions (id, name, version, transport, command, args)
       VALUES ('m1', 'fixture', '1.0.0', 'streamable_http', '', '[]')`,
    )
    .run();
});

afterEach(async () => {
  setMcpAuthResolver(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  __resetKeychainImplForTest();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('resolveMcpAuthMaterial', () => {
  it('http：返回 Bearer Authorization，expiresAt 透传连接行值', async () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const c = insertConnection({ ...baseConn, expiresAt });
    await seedToken(c.id, 'at-token');
    const material = await resolveMcpAuthMaterial(c.id, {
      url: 'https://mcp.example.com',
      transport: 'streamable_http',
    });
    expect(material).toEqual({
      connectionId: c.id,
      headers: { Authorization: 'Bearer at-token' },
      expiresAt,
    });
  });

  it('stdio：token 注入指定环境变量，不产生 headers', async () => {
    const c = insertConnection({ ...baseConn, expiresAt: null });
    await seedToken(c.id, 'at-token');
    const material = await resolveMcpAuthMaterial(c.id, {
      transport: 'stdio',
      envVar: 'GH_TOKEN',
    });
    expect(material.connectionId).toBe(c.id);
    expect(material.env).toEqual({ GH_TOKEN: 'at-token' });
    expect(material.headers).toBeUndefined();
  });

  it('transport 缺省按 stdio 处理（带 envVar 走 env，不带则报错）', async () => {
    const c = insertConnection({ ...baseConn, expiresAt: null });
    await seedToken(c.id, 'at-token');
    const material = await resolveMcpAuthMaterial(c.id, { envVar: 'GH_TOKEN' });
    expect(material.env).toEqual({ GH_TOKEN: 'at-token' });
    await expect(resolveMcpAuthMaterial(c.id, {})).rejects.toMatchObject({
      name: 'OAuthFailure',
      code: 'oauth_env_var_required',
    });
  });

  it('stdio 缺 envVar → oauth_env_var_required（错误路径专项）', async () => {
    const c = insertConnection({ ...baseConn, expiresAt: null });
    await seedToken(c.id, 'at-token');
    await expect(
      resolveMcpAuthMaterial(c.id, { transport: 'stdio' }),
    ).rejects.toMatchObject({ name: 'OAuthFailure', code: 'oauth_env_var_required' });
  });

  it('stdio envVar 纯空白 → 同样 oauth_env_var_required（边界空值专项）', async () => {
    const c = insertConnection({ ...baseConn, expiresAt: null });
    await seedToken(c.id, 'at-token');
    await expect(
      resolveMcpAuthMaterial(c.id, { transport: 'stdio', envVar: '   ' }),
    ).rejects.toBeInstanceOf(OAuthFailure);
  });

  it('连接不存在 → no_connection（错误路径专项）', async () => {
    await expect(
      resolveMcpAuthMaterial('no-such-conn', { transport: 'streamable_http' }),
    ).rejects.toMatchObject({ name: 'OAuthFailure', code: 'no_connection' });
  });

  it('连接已失效 → ensureFreshAccessToken 的 needs_reauth 透传（错误路径专项）', async () => {
    const c = insertConnection({ ...baseConn, status: 'needs_reauth', expiresAt: null });
    await seedToken(c.id, 'at-token');
    await expect(
      resolveMcpAuthMaterial(c.id, { transport: 'streamable_http' }),
    ).rejects.toMatchObject({ name: 'OAuthFailure', code: 'needs_reauth' });
  });
});

describe('wireMcpOAuth', () => {
  it('绑定的 http MCP 启动时注入 Bearer token（headers 真实生效）', async () => {
    const c = insertConnection({ ...baseConn, expiresAt: null });
    await seedToken(c.id, 'at-wire');
    getDb().prepare('UPDATE mcp_definitions SET url = ? WHERE id = ?').run(`${base}/mcp`, 'm1');
    setMcpOAuthBinding('fixture', c.id, null);
    wireMcpOAuth();
    const client = await getOrStartMcp('ws-wire', getMcpConfig('fixture')!);
    expect(lastAuth).toBe('Bearer at-wire');
    await client.disconnect();
  });

  it('未绑定连接的 MCP 不注入（Authorization 为空，零开销路径）', async () => {
    getDb().prepare('UPDATE mcp_definitions SET url = ? WHERE id = ?').run(`${base}/mcp`, 'm1');
    wireMcpOAuth();
    const client = await getOrStartMcp('ws-unbound', getMcpConfig('fixture')!);
    expect(client.isConnected).toBe(true);
    expect(lastAuth).toBe('');
    await client.disconnect();
  });

  it('绑定不存在的连接 → 启动失败且 no_connection 透传（错误路径专项）', async () => {
    getDb().prepare('UPDATE mcp_definitions SET url = ? WHERE id = ?').run(`${base}/mcp`, 'm1');
    setMcpOAuthBinding('fixture', 'no-such-conn', null);
    wireMcpOAuth();
    await expect(getOrStartMcp('ws-err', getMcpConfig('fixture')!)).rejects.toMatchObject({
      name: 'OAuthFailure',
      code: 'no_connection',
    });
  });

  it('池契约：池内实例存续期不重新解析 token（复用实例、不重复握手）', async () => {
    const c = insertConnection({ ...baseConn, expiresAt: null });
    await seedToken(c.id, 'at-v1');
    getDb().prepare('UPDATE mcp_definitions SET url = ? WHERE id = ?').run(`${base}/mcp`, 'm1');
    setMcpOAuthBinding('fixture', c.id, null);
    wireMcpOAuth();
    const first = await getOrStartMcp('ws-pool', getMcpConfig('fixture')!);
    expect(lastAuth).toBe('Bearer at-v1');
    // keychain 换新 token：连接存续期间解析器不再被调用——到期换 token 由服务层
    // 先 evictMcpsByConnection 驱逐（Task 14 的 setOAuthChangeListener 已接线）
    await seedToken(c.id, 'at-v2');
    const second = await getOrStartMcp('ws-pool', getMcpConfig('fixture')!);
    expect(second).toBe(first);
    expect(initializeCount).toBe(1);
    expect(lastAuth).toBe('Bearer at-v1');
    await first.disconnect();
  });
});
