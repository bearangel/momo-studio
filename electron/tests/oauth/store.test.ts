// electron/tests/oauth/store.test.ts
//
// OAuth 数据层回归锁：连接 CRUD + 复用判定 + keychain 键族。
// DB 重度用例，按仓库规范用 --pool=forks 单目录跑。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, __resetKeychainImplForTest } from '../../src/main/storage/keychain';
import {
  insertConnection,
  getConnection,
  listConnections,
  findReusable,
  updateConnection,
  deleteConnection,
} from '../../src/main/oauth/store';
import {
  accessTokenKey,
  refreshTokenKey,
  clientSecretKey,
  saveTokenSet,
  loadTokenSet,
  clearTokenSet,
} from '../../src/main/oauth/keys';

const tmpRoot = path.join(os.tmpdir(), `ap-oauth-store-${Date.now()}-${process.pid}`);
const vault = new Map<string, string>();

beforeEach(() => {
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
});

afterEach(() => {
  __resetKeychainImplForTest();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

const base = {
  providerKey: 'https://auth.example.com|cid||repo read',
  displayName: 'Example',
  authorizationEndpoint: 'https://auth.example.com/authorize',
  tokenEndpoint: 'https://auth.example.com/token',
  clientId: 'cid',
  scopes: 'repo read',
  source: 'manual' as const,
};

describe('oauth store', () => {
  it('插入后可读，默认值正确', () => {
    const c = insertConnection(base);
    expect(c.redirectHost).toBe('127.0.0.1');
    expect(c.redirectPort).toBeNull();
    expect(c.allowInsecureTls).toBe(false);
    expect(c.status).toBe('connected');
    expect(c.clientAuthMethod).toBe('none');
    expect(c.accountLabel).toBe('');
    expect(c.extraAuthorizeParams).toEqual({});
    expect(c.extraTokenParams).toEqual({});
    expect(getConnection(c.id)?.displayName).toBe('Example');
  });

  it('findReusable 只返回 connected 且未过期的连接', () => {
    const c = insertConnection({
      ...base,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(findReusable(base.providerKey)?.id).toBe(c.id);
    updateConnection(c.id, { status: 'needs_reauth' });
    expect(findReusable(base.providerKey)).toBeNull();
  });

  it('findReusable 对过期连接返回 null', () => {
    insertConnection({ ...base, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(findReusable(base.providerKey)).toBeNull();
  });

  it('findReusable 无 expires_at 视为不过期', () => {
    const c = insertConnection(base);
    expect(findReusable(base.providerKey)?.id).toBe(c.id);
  });

  it('list 按创建时间倒序', () => {
    insertConnection({ ...base, providerKey: 'pk-a', displayName: 'A' });
    insertConnection({ ...base, providerKey: 'pk-b', displayName: 'B' });
    expect(listConnections().map((c) => c.displayName)).toEqual(['B', 'A']);
  });

  it('list 空库返回空数组', () => {
    expect(listConnections()).toEqual([]);
  });

  it('getConnection 不存在返回 null', () => {
    expect(getConnection('missing')).toBeNull();
  });

  it('token 三键写入/读取/清理', async () => {
    const c = insertConnection(base);
    await saveTokenSet(c.id, {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: null,
      tokenType: 'Bearer',
      scope: 'repo',
    });
    expect(vault.get(accessTokenKey(c.id))).toBe('at');
    expect(vault.get(refreshTokenKey(c.id))).toBe('rt');
    expect((await loadTokenSet(c.id))?.refreshToken).toBe('rt');
    await clearTokenSet(c.id);
    expect(await loadTokenSet(c.id)).toBeNull();
    expect(vault.has(refreshTokenKey(c.id))).toBe(false);
  });

  it('saveTokenSet 无 refreshToken 时清掉旧 refresh 键', async () => {
    const c = insertConnection(base);
    await saveTokenSet(c.id, {
      accessToken: 'at1',
      refreshToken: 'rt1',
      expiresAt: null,
      tokenType: 'Bearer',
      scope: null,
    });
    await saveTokenSet(c.id, {
      accessToken: 'at2',
      refreshToken: null,
      expiresAt: null,
      tokenType: 'Bearer',
      scope: null,
    });
    expect((await loadTokenSet(c.id))?.accessToken).toBe('at2');
    expect((await loadTokenSet(c.id))?.refreshToken).toBeNull();
    expect(vault.has(refreshTokenKey(c.id))).toBe(false);
  });

  it('loadTokenSet 无 access token 返回 null', async () => {
    expect(await loadTokenSet('missing')).toBeNull();
  });

  it('updateConnection 只写已知列，未知键忽略', () => {
    const c = insertConnection(base);
    // 未知键在运行时传入——验证 PATCHABLE 白名单不把未知字段拼进 SQL
    updateConnection(c.id, { bogusColumn: 'x' } as unknown as Parameters<typeof updateConnection>[1]);
    const after = getConnection(c.id);
    expect(after?.displayName).toBe('Example');
    expect(after?.clientId).toBe('cid');
  });

  it('updateConnection 写入白名单列', () => {
    const c = insertConnection(base);
    const refreshed = new Date().toISOString();
    updateConnection(c.id, {
      status: 'needs_reauth',
      expiresAt: refreshed,
      lastRefreshedAt: refreshed,
      accountLabel: 'me@example.com',
      clientId: 'cid-2',
      clientAuthMethod: 'client_secret_post',
    });
    const after = getConnection(c.id);
    expect(after?.status).toBe('needs_reauth');
    expect(after?.expiresAt).toBe(refreshed);
    expect(after?.lastRefreshedAt).toBe(refreshed);
    expect(after?.accountLabel).toBe('me@example.com');
    expect(after?.clientId).toBe('cid-2');
    expect(after?.clientAuthMethod).toBe('client_secret_post');
  });

  it('deleteConnection 同时清密钥', async () => {
    const c = insertConnection(base);
    await saveTokenSet(c.id, {
      accessToken: 'at',
      refreshToken: null,
      expiresAt: null,
      tokenType: 'Bearer',
      scope: null,
    });
    deleteConnection(c.id);
    expect(getConnection(c.id)).toBeNull();
    // clearTokenSet 为 fire-and-forget，等一个微任务批次落定
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vault.has(accessTokenKey(c.id))).toBe(false);
    expect(vault.has(refreshTokenKey(c.id))).toBe(false);
    expect(vault.has(clientSecretKey(c.id))).toBe(false);
  });

  it('deleteConnection 不存在的 id 不抛错', () => {
    expect(() => deleteConnection('missing')).not.toThrow();
  });
});
