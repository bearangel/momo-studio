// electron/tests/oauth/token.test.ts
//
// token 端点三操作的真实链路测试：本地 http.createServer 充当令牌端点，
// 不 mock fetch（项目测试保真度规则：只 mock 进程/网络边界，且此处连边界都用真实 socket）。
// 覆盖 brief 用例 + 补强：extraParams 透传、缺失 expires_in、非 JSON 响应、
// 非回环端点拒绝、refresh 非 invalid_grant 错误、撤销失败吞错、basic 认证头编码。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exchangeCode, refreshTokens, revokeToken } from '../../src/main/oauth/protocol/token';
import { resolveFetch, type FetchInit } from '../../src/main/oauth/protocol/http';

let server: http.Server;
let base = '';
let lastBody = '';
let lastAuth = '';
let lastMethod = '';
let lastPath = '';
let respond: { status: number; body: unknown; raw?: string } = { status: 200, body: {} };

/** 独立临时服务器（重定向类用例需要第二个端点观察是否被真实打到） */
async function listen(
  handler: http.RequestListener
): Promise<{ server: http.Server; base: string }> {
  const s = http.createServer(handler);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return { server: s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

async function closeServer(s: http.Server): Promise<void> {
  s.closeAllConnections();
  await new Promise<void>((resolve) => s.close(() => resolve()));
}

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

  it('307 重定向不跟随：目标服务器零请求，exchange 抛 token_exchange_failed', async () => {
    let secondHits = 0;
    const second = await listen((_req, res) => {
      secondHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'leaked' }));
    });
    const redirector = await listen((_req, res) => {
      res.writeHead(307, { location: `${second.base}/token` });
      res.end();
    });

    try {
      await expect(
        exchangeCode({ ...exchangeReq, tokenEndpoint: `${redirector.base}/token` })
      ).rejects.toMatchObject({ code: 'token_exchange_failed' });
      expect(secondHits).toBe(0);
    } finally {
      await closeServer(redirector.server);
      await closeServer(second.server);
    }
  });

  it('expires_in 为 1e400（JSON 解析成 Infinity）时 expiresAt=null，不抛 RangeError', async () => {
    respond = { status: 200, body: {}, raw: '{"access_token":"at","expires_in":1e400}' };
    const set = await exchangeCode({ ...exchangeReq, tokenEndpoint: `${base}/token` });
    expect(set.accessToken).toBe('at');
    expect(set.expiresAt).toBeNull();
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

  it('撤销端 307 重定向同样不跟随：目标零请求且不抛错', async () => {
    let secondHits = 0;
    const second = await listen((_req, res) => {
      secondHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const redirector = await listen((_req, res) => {
      res.writeHead(307, { location: `${second.base}/revoke` });
      res.end();
    });

    try {
      await expect(
        revokeToken({
          revocationEndpoint: `${redirector.base}/revoke`,
          token: 'at',
          tokenTypeHint: 'access_token',
          clientId: 'cid',
          clientAuthMethod: 'none',
          allowInsecureTls: false,
        })
      ).resolves.toBeUndefined();
      expect(secondHits).toBe(0);
    } finally {
      await closeServer(redirector.server);
      await closeServer(second.server);
    }
  });
});

describe('resolveFetch（不安全 TLS 通道接线）', () => {
  // 回归锁（host 约束，spec §10/§14）：allowInsecureTls 是连接级标志（由 MCP 资源 URL
  // 是否为 http:// 回环派生），不得把「跳过证书校验」带给非回环主机——否则回环 MCP +
  // 远端 https AS 的常见本地研发组合会把 access/refresh token 与 client_secret 发到
  // 未验证 TLS 上。接线证明用 stub 捕获 dispatcher 注入情况（真实降级 socket 本地
  // 无法提供 https，不在此覆盖）。
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 捕获型 fetch stub：记录每次调用的 url 与 dispatcher 注入情况 */
  function captureFetch(): { seen: Array<{ url: string; dispatcher: unknown }> } {
    const seen: Array<{ url: string; dispatcher: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      async (url: string, init: FetchInit): Promise<Response> => {
        seen.push({ url, dispatcher: init.dispatcher });
        return new Response(JSON.stringify({ access_token: 'at' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    );
    return { seen };
  }

  it('allowInsecureTls=false 不传 dispatcher（默认校验通道）', async () => {
    const { seen } = captureFetch();
    await resolveFetch(false)('https://as.example.com/token', { method: 'POST' });
    expect(seen[0]?.dispatcher).toBeUndefined();
  });

  it('allowInsecureTls=true 对非回环 URL 钳制为 verified fetch（dispatcher: undefined）', async () => {
    const { seen } = captureFetch();
    await resolveFetch(true)('https://auth.example.com/token', { method: 'POST' });
    expect(seen[0]?.url).toBe('https://auth.example.com/token');
    expect(seen[0]?.dispatcher).toBeUndefined();
  });

  it('allowInsecureTls=true 对回环 URL 仍注入 undici Agent 且复用同一实例', async () => {
    const { seen } = captureFetch();
    await resolveFetch(true)('http://127.0.0.1:18443/token', { method: 'POST' });
    await resolveFetch(true)('http://127.0.0.1:18443/token', { method: 'POST' });
    expect(seen[0]?.dispatcher).toBeDefined();
    expect(seen[0]?.dispatcher).toBe(seen[1]?.dispatcher);
  });
});
