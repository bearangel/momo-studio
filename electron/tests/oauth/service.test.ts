// electron/tests/oauth/service.test.ts
//
// OAuth 编排层回归锁：begin / 手动回调完成 / 复用 / 取消 / 断开 / 删除 / 预设表。
// 令牌端点与 userinfo 用真实本地 http server（不打 vi.mock('fetch')，保真测试）。
// DB 重度用例，按仓库规范用 --pool=forks 单目录跑。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl, __resetKeychainImplForTest } from '../../src/main/storage/keychain';
import {
  beginAuthorization, completeWithManualCallback, listConnectionViews,
  disconnect, removeConnection, setOAuthChangeListener, cancelAuthorization,
} from '../../src/main/oauth/service';
import { listPresets, loadPreset } from '../../src/main/oauth/presets';

const tmpRoot = path.join(os.tmpdir(), `ap-oauth-service-${Date.now()}-${process.pid}`);
const vault = new Map<string, string>();

let server: http.Server;
let base = '';

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  vault.clear();
  setKeychainImpl({
    setSecret: async (k, v) => { vault.set(k, v); },
    getSecret: async (k) => vault.get(k) ?? null,
    deleteSecret: async (k) => { vault.delete(k); },
  });
  setOAuthChangeListener(null);

  server = http.createServer((req, res) => {
    if (req.url === '/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer',
      }));
      return;
    }
    if (req.url === '/userinfo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ login: 'bearangel' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  setOAuthChangeListener(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  __resetKeychainImplForTest();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

const manual = {
  displayName: 'Local AS',
  authorizationEndpoint: '',
  tokenEndpoint: '',
  clientId: 'cid',
  scopes: 'repo',
  userinfoEndpoint: null as string | null,
  clientAuthMethod: 'none' as const,
  redirectHost: '127.0.0.1',
  redirectPort: null as number | null,
  allowInsecureTls: false,
  extraAuthorizeParams: {},
  extraTokenParams: {},
};

async function createConnection(): Promise<string> {
  const begin = await beginAuthorization({
    manual: {
      ...manual,
      authorizationEndpoint: `${base}/authorize`,
      tokenEndpoint: `${base}/token`,
    },
  });
  const state = new URL(begin.authorizationUrl!).searchParams.get('state')!;
  const view = await completeWithManualCallback({
    pendingId: begin.pendingId!,
    input: `${begin.redirectUri}?code=a&state=${state}`,
  });
  return view.id;
}

describe('manual 授权全链', () => {
  it('begin 返回授权 URL；手动回调完成并落库 + 落密钥 + userinfo 账号名', async () => {
    const begin = await beginAuthorization({
      manual: {
        ...manual,
        authorizationEndpoint: `${base}/authorize`,
        tokenEndpoint: `${base}/token`,
        userinfoEndpoint: `${base}/userinfo`,
      },
    });
    expect(begin.pendingId).toBeTruthy();
    expect(begin.authorizationUrl).toContain('/authorize?');
    expect(begin.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const state = new URL(begin.authorizationUrl!).searchParams.get('state')!;
    const view = await completeWithManualCallback({
      pendingId: begin.pendingId!,
      input: `${begin.redirectUri}?code=abc&state=${state}`,
    });
    expect(view.displayName).toBe('Local AS');
    expect(view.accountLabel).toBe('bearangel');
    expect(view.status).toBe('connected');
    expect(vault.get(`oauth.${view.id}.access_token`)).toBe('at-1');
    expect(vault.get(`oauth.${view.id}.refresh_token`)).toBe('rt-1');
    expect(listConnectionViews()).toHaveLength(1);
  });

  it('同一 providerKey 第二次授权复用已有连接', async () => {
    const created = await createConnection();
    const second = await beginAuthorization({
      manual: {
        ...manual,
        authorizationEndpoint: `${base}/authorize`,
        tokenEndpoint: `${base}/token`,
      },
    });
    expect(second.existingConnectionId).toBe(created);
    expect(second.pendingId).toBeNull();
    expect(second.authorizationUrl).toBeNull();
  });

  it('state 不匹配不消耗 pending（可重试）', async () => {
    const begin = await beginAuthorization({
      manual: {
        ...manual,
        authorizationEndpoint: `${base}/authorize`,
        tokenEndpoint: `${base}/token`,
      },
    });
    await expect(completeWithManualCallback({
      pendingId: begin.pendingId!,
      input: 'http://127.0.0.1:1/callback?code=x&state=bad',
    })).rejects.toMatchObject({ code: 'authorization_cancelled' });
    const state = new URL(begin.authorizationUrl!).searchParams.get('state')!;
    const view = await completeWithManualCallback({
      pendingId: begin.pendingId!, input: `${begin.redirectUri}?code=ok&state=${state}`,
    });
    expect(view.id).toBeTruthy();
  });

  it('cancel 后 pending 不可再用', async () => {
    const begin = await beginAuthorization({
      manual: {
        ...manual,
        authorizationEndpoint: `${base}/authorize`,
        tokenEndpoint: `${base}/token`,
      },
    });
    await cancelAuthorization(begin.pendingId!);
    await expect(completeWithManualCallback({ pendingId: begin.pendingId!, input: 'abc' }))
      .rejects.toMatchObject({ code: 'authorization_cancelled' });
  });

  it('密钥环写入失败时回滚连接行并报 keychain_unavailable', async () => {
    setKeychainImpl({
      setSecret: async (k) => {
        if (k.endsWith('.access_token')) throw new Error('no secret service');
      },
      getSecret: async (k) => vault.get(k) ?? null,
      deleteSecret: async (k) => { vault.delete(k); },
    });
    const begin = await beginAuthorization({
      manual: {
        ...manual,
        authorizationEndpoint: `${base}/authorize`,
        tokenEndpoint: `${base}/token`,
      },
    });
    const state = new URL(begin.authorizationUrl!).searchParams.get('state')!;
    await expect(completeWithManualCallback({
      pendingId: begin.pendingId!, input: `${begin.redirectUri}?code=x&state=${state}`,
    })).rejects.toMatchObject({ code: 'keychain_unavailable' });
    // 回滚：不得留下无凭据的孤儿连接行
    expect(listConnectionViews()).toHaveLength(0);
  });
});

describe('presets', () => {
  it('内置三项；loadPreset 命中预设，未知名返回 null', () => {
    expect(listPresets().map((p) => p.key)).toEqual(['github', 'google', 'notion']);
    expect(loadPreset('github')?.authorizationEndpoint)
      .toBe('https://github.com/login/oauth/authorize');
    expect(loadPreset('nope')).toBeNull();
  });

  it('presetKey 空 client_id 且无动态注册端点 → registration_failed', async () => {
    await expect(beginAuthorization({ presetKey: 'github' }))
      .rejects.toMatchObject({ code: 'registration_failed' });
  });
});

describe('disconnect / removeConnection', () => {
  it('disconnect 清密钥、置 revoked、绑定保留、事件触发', async () => {
    const id = await createConnection();
    getDb()
      .prepare(`INSERT INTO mcp_definitions (id, name, version, transport, command, args, oauth_connection_id)
                VALUES ('m1', 'gh', '1.0.0', 'streamable_http', '', '[]', ?)`)
      .run(id);
    const events: string[] = [];
    setOAuthChangeListener((cid, kind) => events.push(`${cid}:${kind}`));
    const result = await disconnect(id);
    expect(result.affectedMcpNames).toEqual(['gh']);
    expect(vault.get(`oauth.${id}.access_token`)).toBeUndefined();
    const [view] = listConnectionViews();
    expect(view?.status).toBe('revoked');
    const row = getDb().prepare('SELECT oauth_connection_id FROM mcp_definitions WHERE id = ?')
      .get('m1') as { oauth_connection_id: string };
    expect(row.oauth_connection_id).toBe(id);
    expect(events).toContain(`${id}:revoked`);
  });

  it('removeConnection 被引用时拒绝（no_connection）', async () => {
    const id = await createConnection();
    getDb()
      .prepare(`INSERT INTO mcp_definitions (id, name, version, transport, command, args, oauth_connection_id)
                VALUES ('m1', 'gh', '1.0.0', 'streamable_http', '', '[]', ?)`)
      .run(id);
    await expect(removeConnection(id)).rejects.toMatchObject({ code: 'no_connection' });
    expect(listConnectionViews()).toHaveLength(1);
  });

  it('removeConnection 无引用时彻底删除并清密钥', async () => {
    const id = await createConnection();
    expect(await removeConnection(id)).toEqual({ affectedMcpNames: [] });
    expect(listConnectionViews()).toHaveLength(0);
    expect(vault.get(`oauth.${id}.access_token`)).toBeUndefined();
  });
});
