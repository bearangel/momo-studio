// electron/tests/oauth/token.test.ts
//
// token 端点三操作的真实链路测试：本地 http.createServer 充当令牌端点，
// 不 mock fetch（项目测试保真度规则：只 mock 进程/网络边界，且此处连边界都用真实 socket）。
// 覆盖 brief 用例 + 补强：extraParams 透传、缺失 expires_in、非 JSON 响应、
// 非回环端点拒绝、refresh 非 invalid_grant 错误、撤销失败吞错、basic 认证头编码。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exchangeCode, refreshTokens, revokeToken } from '../../src/main/oauth/protocol/token';

let server: http.Server;
let base = '';
let lastBody = '';
let lastAuth = '';
let lastMethod = '';
let lastPath = '';
let respond: { status: number; body: unknown; raw?: string } = { status: 200, body: {} };

beforeEach(async () => {
  lastBody = '';
  lastAuth = '';
  lastMethod = '';
  lastPath = '';
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += String(c);
    });
    req.on('end', () => {
      lastBody = body;
      lastAuth = req.headers.authorization ?? '';
      lastMethod = req.method ?? '';
      lastPath = req.url ?? '';
      res.writeHead(respond.status, { 'content-type': 'application/json' });
      res.end(respond.raw ?? JSON.stringify(respond.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  // 全局 fetch 走 keep-alive，不主动断开会让 server.close 等到 keepAliveTimeout
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const exchangeReq = {
  tokenEndpoint: '',
  clientId: 'cid',
  clientAuthMethod: 'none' as const,
  code: 'the-code',
  codeVerifier: 'the-verifier',
  redirectUri: 'http://127.0.0.1:51789/callback',
  extraParams: {},
  allowInsecureTls: false,
};

describe('exchangeCode', () => {
  it('发 form-urlencoded 并解析响应（含 expires_in → 本地 ISO）', async () => {
    respond = {
      status: 200,
      body: {
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'repo',
      },
    };
    const before = Date.now();
    const set = await exchangeCode({ ...exchangeReq, tokenEndpoint: `${base}/token` });
    expect(lastMethod).toBe('POST');
    expect(lastPath).toBe('/token');
    expect(lastBody).toContain('grant_type=authorization_code');
    expect(lastBody).toContain('code=the-code');
    expect(lastBody).toContain('code_verifier=the-verifier');
    expect(lastBody).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A51789%2Fcallback');
    expect(lastBody).toContain('client_id=cid');
    expect(set.accessToken).toBe('at');
    expect(set.refreshToken).toBe('rt');
    expect(set.tokenType).toBe('Bearer');
    expect(set.scope).toBe('repo');
    expect(set.expiresAt).not.toBeNull();
    const expiresAtMs = Date.parse(set.expiresAt ?? '');
    expect(Math.abs(expiresAtMs - (before + 3600_000))).toBeLessThan(10_000);
  });

  it('client_secret_post 把 secret 放 body', async () => {
    respond = { status: 200, body: { access_token: 'at' } };
    await exchangeCode({
      ...exchangeReq,
      tokenEndpoint: `${base}/token`,
      clientAuthMethod: 'client_secret_post',
      clientSecret: 'sec',
    });
    expect(lastBody).toContain('client_secret=sec');
  });

  it('client_secret_basic 用 Authorization 头且做 URL 编码', async () => {
    respond = { status: 200, body: { access_token: 'at' } };
    await exchangeCode({
      ...exchangeReq,
      tokenEndpoint: `${base}/token`,
      clientAuthMethod: 'client_secret_basic',
      clientSecret: 's c',
    });
    expect(lastAuth.startsWith('Basic ')).toBe(true);
    expect(Buffer.from(lastAuth.slice(6), 'base64').toString()).toBe('cid:s%20c');
    // basic 方式不再把 client_id/client_secret 塞进 body
    expect(lastBody).not.toContain('client_id=');
    expect(lastBody).not.toContain('client_secret=');
  });

  it('extraParams 合并进 body（可覆盖默认字段）', async () => {
    respond = { status: 200, body: { access_token: 'at' } };
    await exchangeCode({
      ...exchangeReq,
      tokenEndpoint: `${base}/token`,
      extraParams: { audience: 'https://api.example.com', resource: 'r1' },
    });
    expect(lastBody).toContain('audience=https%3A%2F%2Fapi.example.com');
    expect(lastBody).toContain('resource=r1');
  });

  it('缺 access_token 抛 token_exchange_failed', async () => {
    respond = { status: 200, body: { token_type: 'Bearer' } };
    await expect(
      exchangeCode({ ...exchangeReq, tokenEndpoint: `${base}/token` })
    ).rejects.toMatchObject({ code: 'token_exchange_failed' });
  });

  it('缺 expires_in 时 expiresAt 为 null（不过期）且 refresh_token 缺失为 null', async () => {
    respond = { status: 200, body: { access_token: 'at' } };
    const set = await exchangeCode({ ...exchangeReq, tokenEndpoint: `${base}/token` });
    expect(set.expiresAt).toBeNull();
    expect(set.refreshToken).toBeNull();
    expect(set.scope).toBeNull();
  });

  it('400 + invalid_grant 抛 token_exchange_failed 且 detail 带错误码', async () => {
    respond = { status: 400, body: { error: 'invalid_grant', error_description: 'bad code' } };
    await expect(
      exchangeCode({ ...exchangeReq, tokenEndpoint: `${base}/token` })
    ).rejects.toMatchObject({
      code: 'token_exchange_failed',
      detail: 'invalid_grant',
      message: 'bad code',
    });
  });

  it('非 JSON 响应体（2xx 空/HTML）同样抛 token_exchange_failed', async () => {
    respond = { status: 200, body: {}, raw: '<html>not json</html>' };
    await expect(
      exchangeCode({ ...exchangeReq, tokenEndpoint: `${base}/token` })
    ).rejects.toMatchObject({ code: 'token_exchange_failed' });
  });

  it('网络层失败（连接被拒）也归为 token_exchange_failed 而非裸 TypeError', async () => {
    // 先占一个空闲端口再释放——目标端口无监听即确定性拒绝连接
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await expect(
      exchangeCode({ ...exchangeReq, tokenEndpoint: `http://127.0.0.1:${port}/token` })
    ).rejects.toMatchObject({ code: 'token_exchange_failed' });
  });

  it('非 https 且非回环端点直接拒绝（不发请求）', async () => {
    await expect(
      exchangeCode({ ...exchangeReq, tokenEndpoint: 'http://example.com/token' })
    ).rejects.toMatchObject({ code: 'insecure_endpoint', detail: 'http://example.com/token' });
    expect(lastBody).toBe('');
  });
});

describe('refreshTokens', () => {
  const refreshReq = {
    tokenEndpoint: '',
    clientId: 'cid',
    clientAuthMethod: 'none' as const,
    refreshToken: 'rt-old',
    extraParams: {},
    allowInsecureTls: false,
  };

  it('grant_type=refresh_token；响应无 refresh_token 时返回 null（调用方保留旧值）', async () => {
    respond = { status: 200, body: { access_token: 'at2', expires_in: 60 } };
    const set = await refreshTokens({ ...refreshReq, tokenEndpoint: `${base}/token` });
    expect(lastBody).toContain('grant_type=refresh_token');
    expect(lastBody).toContain('refresh_token=rt-old');
    expect(set.accessToken).toBe('at2');
    expect(set.refreshToken).toBeNull();
  });

  it('invalid_grant 抛 needs_reauth', async () => {
    respond = { status: 400, body: { error: 'invalid_grant' } };
    await expect(
      refreshTokens({ ...refreshReq, tokenEndpoint: `${base}/token` })
    ).rejects.toMatchObject({ code: 'needs_reauth', detail: 'invalid_grant' });
  });

  it('非 invalid_grant 的 4xx 抛 refresh_failed 且 detail 带错误码', async () => {
    respond = { status: 401, body: { error: 'invalid_client' } };
    await expect(
      refreshTokens({ ...refreshReq, tokenEndpoint: `${base}/token` })
    ).rejects.toMatchObject({ code: 'refresh_failed', detail: 'invalid_client' });
  });

  it('5xx 抛 refresh_failed（可重试）', async () => {
    respond = { status: 503, body: {} };
    await expect(
      refreshTokens({ ...refreshReq, tokenEndpoint: `${base}/token` })
    ).rejects.toMatchObject({ code: 'refresh_failed' });
  });
});

describe('revokeToken', () => {
  it('POST token 到撤销端点', async () => {
    respond = { status: 200, body: {} };
    await revokeToken({
      revocationEndpoint: `${base}/revoke`,
      token: 'at',
      tokenTypeHint: 'access_token',
      clientId: 'cid',
      clientAuthMethod: 'none',
      allowInsecureTls: false,
    });
    expect(lastMethod).toBe('POST');
    expect(lastPath).toBe('/revoke');
    expect(lastBody).toContain('token=at');
    expect(lastBody).toContain('token_type_hint=access_token');
  });

  it('撤销失败（5xx / 非回环端点）不抛错——尽力而为', async () => {
    respond = { status: 500, body: { error: 'server_error' } };
    await expect(
      revokeToken({
        revocationEndpoint: `${base}/revoke`,
        token: 'at',
        tokenTypeHint: 'refresh_token',
        clientId: 'cid',
        clientAuthMethod: 'none',
        allowInsecureTls: false,
      })
    ).resolves.toBeUndefined();

    await expect(
      revokeToken({
        revocationEndpoint: 'http://example.com/revoke',
        token: 'at',
        tokenTypeHint: 'access_token',
        clientId: 'cid',
        clientAuthMethod: 'none',
        allowInsecureTls: false,
      })
    ).resolves.toBeUndefined();
  });

  it('client_secret_basic 同样作用于撤销请求', async () => {
    respond = { status: 200, body: {} };
    await revokeToken({
      revocationEndpoint: `${base}/revoke`,
      token: 'rt',
      tokenTypeHint: 'refresh_token',
      clientId: 'cid',
      clientAuthMethod: 'client_secret_basic',
      clientSecret: 's:c',
      allowInsecureTls: false,
    });
    expect(Buffer.from(lastAuth.slice(6), 'base64').toString()).toBe('cid:s%3Ac');
  });
});
