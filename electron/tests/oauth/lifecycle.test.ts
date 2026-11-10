// electron/tests/oauth/lifecycle.test.ts
//
// OAuth 生命周期回归锁：主动刷新 / 单飞 / 轮换 / 失败分类 / 扫描器。
// 令牌端点用真实本地 http server（不打 vi.mock('fetch')，保真测试）。
// DB 重度用例，按仓库规范用 --pool=forks 单目录跑。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, __resetKeychainImplForTest } from '../../src/main/storage/keychain';
import { insertConnection, getConnection, updateConnection } from '../../src/main/oauth/store';
import { accessTokenKey, refreshTokenKey } from '../../src/main/oauth/keys';
import {
  ensureFreshAccessToken,
  startOAuthLifecycle,
  stopOAuthLifecycle,
  setOAuthLifecycleTestHooks,
  __resetOAuthLifecycleForTest,
} from '../../src/main/oauth/lifecycle';
import {
  setOAuthChangeListener,
  __resetOAuthServiceForTest,
} from '../../src/main/oauth/service';

const tmpRoot = path.join(os.tmpdir(), `ap-oauth-life-${Date.now()}-${process.pid}`);
const vault = new Map<string, string>();

let server: http.Server;
let base = '';
let tokenCalls = 0;
let tokenResponse: { status: number; body: unknown } = { status: 200, body: {} };
/** 一次性响应队列：非空时优先于 tokenResponse（模拟「先失败后成功」） */
const queuedResponses: Array<{ status: number; body: unknown }> = [];
/** 变更事件采集（锁住 emitOAuthChange 契约） */
const changes: Array<{ id: string; kind: string }> = [];

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  vault.clear();
  tokenCalls = 0;
  queuedResponses.length = 0;
  changes.length = 0;
  setKeychainImpl({
    setSecret: async (k, v) => { vault.set(k, v); },
    getSecret: async (k) => vault.get(k) ?? null,
    deleteSecret: async (k) => { vault.delete(k); },
  });
  setOAuthChangeListener((id, kind) => { changes.push({ id, kind }); });
  server = http.createServer((req, res) => {
    tokenCalls += 1;
    const payload = queuedResponses.shift() ?? tokenResponse;
    res.writeHead(payload.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  stopOAuthLifecycle();
  __resetOAuthLifecycleForTest();
  __resetOAuthServiceForTest();
  __resetKeychainImplForTest();
  // 全局 fetch 走 keep-alive，不主动断开会让 server.close 等到 keepAliveTimeout（同 token.test.ts）
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function seed(expiresInMs: number | null): string {
  const conn = insertConnection({
    providerKey: 'pk',
    displayName: 'T',
    authorizationEndpoint: 'https://unused.example.com/a',
    tokenEndpoint: `${base}/token`,
    clientId: 'cid',
    scopes: '',
    expiresAt: expiresInMs === null ? null : new Date(Date.now() + expiresInMs).toISOString(),
  });
  vault.set(accessTokenKey(conn.id), 'old-at');
  vault.set(refreshTokenKey(conn.id), 'old-rt');
  return conn.id;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('ensureFreshAccessToken', () => {
  it('临近过期时刷新并轮换 refresh_token', async () => {
    const id = seed(60_000); // 1 分钟后过期 < 5 分钟阈值
    tokenResponse = {
      status: 200,
      body: { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 },
    };
    const token = await ensureFreshAccessToken(id);
    expect(token).toBe('new-at');
    expect(tokenCalls).toBe(1);
    expect(vault.get(accessTokenKey(id))).toBe('new-at');
    expect(vault.get(refreshTokenKey(id))).toBe('new-rt');
    expect(getConnection(id)?.expiresAt).not.toBeNull();
    expect(changes).toContainEqual({ id, kind: 'refreshed' });
  });

  it('未临近过期不刷新', async () => {
    const id = seed(3600_000);
    expect(await ensureFreshAccessToken(id)).toBe('old-at');
    expect(tokenCalls).toBe(0);
  });

  it('无 expiresAt 视为不过期，不刷新', async () => {
    const id = seed(null);
    expect(await ensureFreshAccessToken(id)).toBe('old-at');
    expect(tokenCalls).toBe(0);
  });

  it('并发 3 次只发 1 个刷新请求（单飞）', async () => {
    const id = seed(60_000);
    tokenResponse = { status: 200, body: { access_token: 'new-at', expires_in: 3600 } };
    const results = await Promise.all([
      ensureFreshAccessToken(id),
      ensureFreshAccessToken(id),
      ensureFreshAccessToken(id),
    ]);
    expect(results).toEqual(['new-at', 'new-at', 'new-at']);
    expect(tokenCalls).toBe(1);
  });

  it('响应无 refresh_token 时保留旧值', async () => {
    const id = seed(60_000);
    tokenResponse = { status: 200, body: { access_token: 'new-at', expires_in: 3600 } };
    await ensureFreshAccessToken(id);
    expect(vault.get(refreshTokenKey(id))).toBe('old-rt');
  });

  it('invalid_grant 置 needs_reauth 并抛错', async () => {
    const id = seed(60_000);
    tokenResponse = { status: 400, body: { error: 'invalid_grant' } };
    await expect(ensureFreshAccessToken(id)).rejects.toMatchObject({ code: 'needs_reauth' });
    expect(getConnection(id)?.status).toBe('needs_reauth');
    expect(changes).toContainEqual({ id, kind: 'needs_reauth' });
  });

  it('已 revoked 的连接拒绝刷新（needs_reauth）', async () => {
    const id = seed(60_000);
    updateConnection(id, { status: 'revoked' });
    await expect(ensureFreshAccessToken(id)).rejects.toMatchObject({ code: 'needs_reauth' });
    expect(tokenCalls).toBe(0);
  });

  it('已 needs_reauth 的连接即便未临近过期也拒绝交付令牌', async () => {
    const id = seed(3600_000);
    updateConnection(id, { status: 'needs_reauth' });
    await expect(ensureFreshAccessToken(id)).rejects.toMatchObject({ code: 'needs_reauth' });
    expect(tokenCalls).toBe(0);
  });

  it('连接不存在抛 no_connection（不动 DB、不发请求）', async () => {
    await expect(ensureFreshAccessToken('no-such-id')).rejects.toMatchObject({
      code: 'no_connection',
    });
    expect(tokenCalls).toBe(0);
  });

  it('凭据缺失（access_token 密文不在）落 needs_reauth 并通知', async () => {
    const id = seed(60_000);
    vault.delete(accessTokenKey(id));
    await expect(ensureFreshAccessToken(id)).rejects.toMatchObject({ code: 'needs_reauth' });
    expect(tokenCalls).toBe(0);
    expect(getConnection(id)?.status).toBe('needs_reauth');
    expect(changes).toContainEqual({ id, kind: 'needs_reauth' });
  });
});

describe('失败分类与退避', () => {
  it('5xx 连续失败：退避 2 次后耗尽，落 needs_reauth 并抛 refresh_failed', async () => {
    const waits: number[] = [];
    setOAuthLifecycleTestHooks({
      waitBeforeRetry: async (attempt) => { waits.push(attempt); },
    });
    const id = seed(60_000);
    tokenResponse = { status: 503, body: { error: 'temporarily_unavailable' } };
    await expect(ensureFreshAccessToken(id)).rejects.toMatchObject({ code: 'refresh_failed' });
    expect(tokenCalls).toBe(3);
    expect(waits).toEqual([0, 1]);
    expect(getConnection(id)?.status).toBe('needs_reauth');
    expect(changes).toContainEqual({ id, kind: 'needs_reauth' });
  });

  it('单次失败后退避重试成功 → 保持 connected 且不置 needs_reauth', async () => {
    setOAuthLifecycleTestHooks({ waitBeforeRetry: async () => {} });
    const id = seed(60_000);
    queuedResponses.push({ status: 500, body: {} });
    tokenResponse = { status: 200, body: { access_token: 'recovered-at', expires_in: 3600 } };
    expect(await ensureFreshAccessToken(id)).toBe('recovered-at');
    expect(tokenCalls).toBe(2);
    expect(getConnection(id)?.status).toBe('connected');
    expect(changes).not.toContainEqual({ id, kind: 'needs_reauth' });
  });
});

describe('startOAuthLifecycle', () => {
  it('启动即扫描临近过期连接，重复启动幂等，stop 可清理', async () => {
    const id = seed(60_000);
    tokenResponse = { status: 200, body: { access_token: 'swept-at', expires_in: 3600 } };
    startOAuthLifecycle();
    startOAuthLifecycle(); // 幂等：不应重复登记计时器/重复扫描
    await waitFor(() => tokenCalls === 1);
    expect(vault.get(accessTokenKey(id))).toBe('swept-at');
    expect(changes).toContainEqual({ id, kind: 'refreshed' });
    stopOAuthLifecycle();
    stopOAuthLifecycle(); // 幂等
    // 刷新后 expiresAt 已推到 1 小时后，再等一小段也不应有新请求
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tokenCalls).toBe(1);
  });

  it('扫描器跳过 revoked / needs_reauth 连接', async () => {
    const revokedId = seed(60_000);
    updateConnection(revokedId, { status: 'revoked' });
    const pendingId = seed(60_000);
    updateConnection(pendingId, { status: 'needs_reauth' });
    startOAuthLifecycle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(tokenCalls).toBe(0);
  });
});
