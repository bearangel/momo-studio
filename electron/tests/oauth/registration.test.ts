// electron/tests/oauth/registration.test.ts
//
// 动态客户端注册（RFC 7591）与授权 URL 构造的真实链路测试：本地 http.createServer
// 充当注册端点，不 mock fetch（测试保真度规则：只 mock 进程/网络边界，此处连边界都用真实 socket）。
// 覆盖 brief 用例 + 补强：R2 约束（注册 POST 禁跟重定向，3xx 归一 registration_failed 且
// 目标端点不被真实打到）、认证方式归一（未知值 → none）、无 secret → null、scope 缺省不发送、
// 非 JSON 响应、注册端点非回环明文拒绝、授权端点准入、extraParams 覆盖默认值。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerClient } from '../../src/main/oauth/protocol/registration';
import { buildAuthorizationUrl } from '../../src/main/oauth/protocol/authorize';

let server: http.Server;
let base = '';
let lastBody: Record<string, unknown> = {};
let lastMethod = '';
let lastContentType = '';
let respond: { status: number; body: unknown; raw?: string; headers?: Record<string, string> } = {
  status: 201,
  body: {},
};

/** 独立临时服务器（重定向用例需要第二个端点观察是否被真实打到） */
async function listen(
  handler: http.RequestListener,
): Promise<{ server: http.Server; base: string }> {
  const s = http.createServer(handler);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return { server: s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

async function closeServer(s: http.Server): Promise<void> {
  // 全局 fetch 走 keep-alive，不主动断开会让 server.close 等到 keepAliveTimeout
  s.closeAllConnections();
  await new Promise<void>((resolve) => s.close(() => resolve()));
}

beforeEach(async () => {
  lastBody = {};
  lastMethod = '';
  lastContentType = '';
  // 测试隔离：respond 是跨用例共享的模块级状态，必须每条用例前复位
  respond = { status: 201, body: {} };
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += String(c);
    });
    req.on('end', () => {
      lastMethod = req.method ?? '';
      lastContentType = req.headers['content-type'] ?? '';
      try {
        const parsed: unknown = JSON.parse(body || '{}');
        lastBody =
          typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)
            : {};
      } catch {
        lastBody = {};
      }
      res.writeHead(respond.status, {
        'content-type': 'application/json',
        ...respond.headers,
      });
      res.end(respond.raw ?? JSON.stringify(respond.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await closeServer(server);
});

const baseReq = {
  registrationEndpoint: '',
  redirectUris: ['http://127.0.0.1:51789/callback'],
  clientName: 'Momo Studio',
  scopes: 'repo read',
  allowInsecureTls: false,
};

describe('registerClient', () => {
  it('POST 注册并解析 client_id / secret / auth method', async () => {
    respond = {
      status: 201,
      body: {
        client_id: 'dcr-1',
        client_secret: 's',
        token_endpoint_auth_method: 'client_secret_post',
      },
    };
    const result = await registerClient({
      ...baseReq,
      registrationEndpoint: `${base}/register`,
    });
    expect(lastMethod).toBe('POST');
    expect(lastContentType).toContain('application/json');
    expect(lastBody.redirect_uris).toEqual(['http://127.0.0.1:51789/callback']);
    expect(lastBody.client_name).toBe('Momo Studio');
    expect(lastBody.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(lastBody.response_types).toEqual(['code']);
    expect(lastBody.token_endpoint_auth_method).toBe('none');
    expect(lastBody.scope).toBe('repo read');
    expect(result).toEqual({
      clientId: 'dcr-1',
      clientSecret: 's',
      authMethod: 'client_secret_post',
    });
  });

  it('缺 client_id 抛 registration_failed', async () => {
    respond = { status: 201, body: {} };
    await expect(
      registerClient({ ...baseReq, registrationEndpoint: `${base}/register` }),
    ).rejects.toMatchObject({ code: 'registration_failed' });
  });

  it('400 错误响应抛 registration_failed', async () => {
    respond = { status: 400, body: { error: 'invalid_redirect_uri' } };
    await expect(
      registerClient({ ...baseReq, registrationEndpoint: `${base}/register` }),
    ).rejects.toMatchObject({ code: 'registration_failed' });
  });

  it('400 响应体即便含 client_id 仍抛 registration_failed（非 2xx 闸门回归锁）', async () => {
    respond = { status: 400, body: { client_id: 'evil' } };
    await expect(
      registerClient({ ...baseReq, registrationEndpoint: `${base}/register` }),
    ).rejects.toMatchObject({ code: 'registration_failed' });
  });

  it('无 secret 且认证方式为 none 时返回 null / none', async () => {
    respond = { status: 201, body: { client_id: 'dcr-2' } };
    const result = await registerClient({
      ...baseReq,
      registrationEndpoint: `${base}/register`,
    });
    expect(result).toEqual({ clientId: 'dcr-2', clientSecret: null, authMethod: 'none' });
  });

  it('未知 token_endpoint_auth_method 归一为 none（client_secret_basic 保留）', async () => {
    respond = {
      status: 201,
      body: { client_id: 'dcr-3', client_secret: 's3', token_endpoint_auth_method: 'private_key_jwt' },
    };
    await expect(
      registerClient({ ...baseReq, registrationEndpoint: `${base}/register` }),
    ).resolves.toEqual({ clientId: 'dcr-3', clientSecret: 's3', authMethod: 'none' });

    respond = {
      status: 201,
      body: { client_id: 'dcr-4', client_secret: 's4', token_endpoint_auth_method: 'client_secret_basic' },
    };
    await expect(
      registerClient({ ...baseReq, registrationEndpoint: `${base}/register` }),
    ).resolves.toEqual({ clientId: 'dcr-4', clientSecret: 's4', authMethod: 'client_secret_basic' });
  });

  it('scopes 为空时不发送 scope 字段', async () => {
    respond = { status: 201, body: { client_id: 'dcr-5' } };
    await registerClient({
      ...baseReq,
      registrationEndpoint: `${base}/register`,
      scopes: '',
    });
    expect('scope' in lastBody).toBe(false);
  });

  it('非 JSON 响应视为注册失败', async () => {
    respond = { status: 201, body: {}, raw: 'not-json' };
    await expect(
      registerClient({ ...baseReq, registrationEndpoint: `${base}/register` }),
    ).rejects.toMatchObject({ code: 'registration_failed' });
  });

  it('3xx 重定向不被跟随，归一 registration_failed 且目标端点零请求（R2）', async () => {
    let targetHits = 0;
    const target = await listen((_req, res) => {
      targetHits += 1;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ client_id: 'evil' }));
    });
    try {
      respond = {
        status: 302,
        body: {},
        headers: { location: `${target.base}/redirected` },
      };
      await expect(
        registerClient({ ...baseReq, registrationEndpoint: `${base}/register` }),
      ).rejects.toMatchObject({ code: 'registration_failed' });
      expect(targetHits).toBe(0);
    } finally {
      await closeServer(target.server);
    }
  });

  it('注册端点非回环明文时拒绝（insecure_endpoint）', async () => {
    await expect(
      registerClient({ ...baseReq, registrationEndpoint: 'http://example.com/register' }),
    ).rejects.toMatchObject({ code: 'insecure_endpoint' });
  });

  it('网络失败归一为 registration_failed', async () => {
    const closed = await listen((_req, res) => res.end());
    await closeServer(closed.server);
    await expect(
      registerClient({ ...baseReq, registrationEndpoint: `${closed.base}/register` }),
    ).rejects.toMatchObject({ code: 'registration_failed' });
  });
});

const authorizeBase = {
  authorizationEndpoint: 'https://a.example.com/authorize',
  clientId: 'cid',
  redirectUri: 'http://127.0.0.1:51789/callback',
  scopes: 'repo read',
  state: 'st',
  codeChallenge: 'ch',
  resource: null as string | null,
  extraParams: {} as Record<string, string>,
};

describe('buildAuthorizationUrl', () => {
  it('含必需参数与 resource/extra', () => {
    const url = buildAuthorizationUrl({
      ...authorizeBase,
      resource: 'https://mcp.example.com',
      extraParams: { prompt: 'consent' },
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('cid');
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:51789/callback');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toBe('ch');
    expect(parsed.searchParams.get('state')).toBe('st');
    expect(parsed.searchParams.get('scope')).toBe('repo read');
    expect(parsed.searchParams.get('resource')).toBe('https://mcp.example.com');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
  });

  it('scope / resource 缺省时不出现，extraParams 可覆盖默认值', () => {
    const url = buildAuthorizationUrl({
      ...authorizeBase,
      scopes: '',
      resource: null,
      extraParams: { prompt: 'login', response_type: 'code-override' },
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.has('scope')).toBe(false);
    expect(parsed.searchParams.has('resource')).toBe(false);
    expect(parsed.searchParams.get('prompt')).toBe('login');
    expect(parsed.searchParams.get('response_type')).toBe('code-override');
  });

  it('授权端点非回环明文时拒绝（insecure_endpoint）', () => {
    expect(() =>
      buildAuthorizationUrl({ ...authorizeBase, authorizationEndpoint: 'http://example.com/authorize' }),
    ).toThrowError(expect.objectContaining({ code: 'insecure_endpoint' }));
  });
});
