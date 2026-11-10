// electron/tests/plugin/oauth-ctx.test.ts
//
// 插件 ctx.oauth（只读）回归锁：真实 DB + 注入 keychain（vault）。
// 安全断言：listConnections 序列化结果不得含 token 值 / accessToken 字段名。
// DB 重度用例，按仓库规范用 --pool=forks 单目录跑。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, __resetKeychainImplForTest } from '../../src/main/storage/keychain';
import { insertConnection } from '../../src/main/oauth/store';
import { saveTokenSet } from '../../src/main/oauth/keys';
import { buildPluginOAuthApi } from '../../src/main/plugin/oauth-ctx';

const tmpRoot = path.join(os.tmpdir(), `ap-plugin-oauth-${Date.now()}-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const vault = new Map<string, string>();
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

describe('buildPluginOAuthApi', () => {
  it('listConnections 只返回元数据（无 token 字段）', async () => {
    const conn = insertConnection({
      providerKey: 'pk',
      displayName: 'GitHub',
      authorizationEndpoint: 'https://a/auth',
      tokenEndpoint: 'https://a/token',
      clientId: 'cid',
      accountLabel: 'bearangel',
    });
    await saveTokenSet(conn.id, {
      accessToken: 'secret-at',
      refreshToken: null,
      expiresAt: null,
      tokenType: 'Bearer',
      scope: null,
    });
    const api = buildPluginOAuthApi();
    const list = await api.listConnections();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: conn.id, displayName: 'GitHub', accountLabel: 'bearangel' });
    // 字面断言：token 值与字段名都不得出现在列表序列化结果里
    expect(JSON.stringify(list)).not.toContain('secret-at');
    expect(Object.keys(list[0]!)).not.toContain('accessToken');
  });

  it('getAccessToken 返回 token；未知 id 返回 null', async () => {
    const conn = insertConnection({
      providerKey: 'pk2',
      displayName: 'X',
      authorizationEndpoint: 'https://b/auth',
      tokenEndpoint: 'https://b/token',
      clientId: 'cid',
    });
    await saveTokenSet(conn.id, {
      accessToken: 'at-1',
      refreshToken: null,
      expiresAt: null,
      tokenType: 'Bearer',
      scope: null,
    });
    const api = buildPluginOAuthApi();
    expect(await api.getAccessToken(conn.id)).toBe('at-1');
    expect(await api.getAccessToken('missing')).toBeNull();
  });
});
