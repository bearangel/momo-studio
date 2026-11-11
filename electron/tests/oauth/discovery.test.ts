// electron/tests/oauth/discovery.test.ts
//
// OAuth 发现真实链路测试：本地 http.createServer 充当资源元数据与授权服务器元数据
// 端点，不 mock fetch（测试保真度规则：网络边界也用真实 socket）。
// 覆盖 brief 用例 + 补强 R2 裁定：发现 GET 不盲跟重定向——手动跟随、逐跳过
// assertEndpointAllowed、最多 5 跳；另补 issuer 尾斜杠容忍、3xx 无 Location、
// 5xx 回退等边界。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  parseResourceMetadataUrl,
  discoverAuthorizationServer,
  discoverForResource,
} from '../../src/main/oauth/protocol/discovery';
import type { FetchLike } from '../../src/main/oauth/protocol/http';

interface RouteReply {
  status?: number;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
}

let server: http.Server;
let base = '';
let routes: Record<string, RouteReply> = {};
let hits: string[] = [];

beforeEach(async () => {
  routes = {};
  hits = [];
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    hits.push(url);
    const hit = routes[url];
    if (hit === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(hit.status ?? 200, {
      'content-type': 'application/json',
      ...hit.headers,
    });
    res.end(hit.raw ?? JSON.stringify(hit.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  // 全局 fetch 走 keep-alive，不主动断开会让 server.close 等到 keepAliveTimeout
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('parseResourceMetadataUrl', () => {
  it('解析带引号的 resource_metadata', () => {
    expect(
      parseResourceMetadataUrl(
        'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
      ),
    ).toBe('https://mcp.example.com/.well-known/oauth-protected-resource');
  });

  it('无该参数返回 null', () => {
    expect(parseResourceMetadataUrl('Bearer realm="x"')).toBeNull();
    expect(parseResourceMetadataUrl('')).toBeNull();
  });

  it('容忍无引号形式', () => {
    expect(parseResourceMetadataUrl('Bearer resource_metadata=https://a.example.com/meta')).toBe(
      'https://a.example.com/meta',
    );
  });

  it('前缀同名的其它参数不误匹配（左边界）', () => {
    expect(parseResourceMetadataUrl('Bearer x_resource_metadata="https://evil.example.com/meta"')).toBeNull();
    expect(parseResourceMetadataUrl('Bearer not_a_resource_metadata="https://evil.example.com/meta"')).toBeNull();
  });

  it('逗号分隔的多参数里仍能取到', () => {
    expect(
      parseResourceMetadataUrl(
        'Bearer realm="x", resource_metadata="https://a.example.com/meta", error="invalid_token"',
      ),
    ).toBe('https://a.example.com/meta');
  });
});

describe('discoverAuthorizationServer', () => {
  it('优先 RFC 8414 路径，校验 issuer 一致', async () => {
    routes['/.well-known/oauth-authorization-server'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        scopes_supported: ['repo', 'read'],
      },
    };
    const meta = await discoverAuthorizationServer(base);
    expect(meta.authorizationEndpoint).toBe(`${base}/authorize`);
    expect(meta.tokenEndpoint).toBe(`${base}/token`);
    expect(meta.registrationEndpoint).toBe(`${base}/register`);
    expect(meta.revocationEndpoint).toBeNull();
    expect(meta.userinfoEndpoint).toBeNull();
    expect(meta.scopesSupported).toEqual(['repo', 'read']);
  });

  it('RFC 8414 404 时回退 OIDC 发现', async () => {
    routes['/.well-known/openid-configuration'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/oauth2/auth`,
        token_endpoint: `${base}/oauth2/token`,
      },
    };
    const meta = await discoverAuthorizationServer(base);
    expect(meta.tokenEndpoint).toBe(`${base}/oauth2/token`);
  });

  it('issuer 与来源不一致抛 discovery_failed', async () => {
    routes['/.well-known/oauth-authorization-server'] = {
      body: {
        issuer: 'https://evil.example.com',
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
      },
    };
    await expect(discoverAuthorizationServer(base)).rejects.toMatchObject({
      code: 'discovery_failed',
    });
  });

  it('issuer 尾斜杠容差（RFC 8414 §3.3 宽松比较）', async () => {
    routes['/.well-known/oauth-authorization-server'] = {
      body: {
        issuer: `${base}/`,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
      },
    };
    const meta = await discoverAuthorizationServer(`${base}/`);
    expect(meta.issuer).toBe(`${base}/`);
  });

  it('带路径 issuer 用 RFC 8414 路径插入式发现 AS（Keycloak /realms 形态）', async () => {
    const issuer = `${base}/realms/momo`;
    routes['/.well-known/oauth-authorization-server/realms/momo'] = {
      body: {
        issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
      },
    };
    const meta = await discoverAuthorizationServer(issuer);
    expect(meta.tokenEndpoint).toBe(`${issuer}/token`);
  });

  it('首个合法文档缺 registration_endpoint 时继续找带 DCR 的候选（tinyfish/Clerk 形态）', async () => {
    // 8414 文档合法但无 DCR；OIDC 变体反而带 registration_endpoint → 必须取后者
    routes['/.well-known/oauth-authorization-server'] = {
      body: { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` },
    };
    routes['/.well-known/openid-configuration'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
      },
    };
    const meta = await discoverAuthorizationServer(base);
    expect(meta.registrationEndpoint).toBe(`${base}/register`);
  });

  it('全部候选都缺 registration_endpoint → 返回首个合法文档（兜底不误杀）', async () => {
    routes['/.well-known/oauth-authorization-server'] = {
      body: { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` },
    };
    routes['/.well-known/openid-configuration'] = {
      body: { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token2` },
    };
    const meta = await discoverAuthorizationServer(base);
    expect(meta.tokenEndpoint).toBe(`${base}/token`);
    expect(meta.registrationEndpoint).toBeNull();
  });

  it('网络级瞬断对同一候选重试一次（不滑落 OIDC 变体）', async () => {
    const calls: string[] = [];
    const asDoc = {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
    };
    const fetchImpl: FetchLike = async (url: string) => {
      calls.push(url);
      if (calls.length === 1) throw new TypeError('terminated');
      return new Response(JSON.stringify(asDoc), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const meta = await discoverAuthorizationServer(base, fetchImpl);
    expect(meta.registrationEndpoint).toBe(`${base}/register`);
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('oauth-authorization-server');
  });

  it('RFC 8414 两条路径都 404 抛 discovery_failed', async () => {
    await expect(discoverAuthorizationServer(base)).rejects.toMatchObject({
      code: 'discovery_failed',
    });
  });

  it('非回环 http issuer 直接拒绝且零请求（R2 issuer 准入）', async () => {
    await expect(discoverAuthorizationServer('http://example.com')).rejects.toMatchObject({
      code: 'insecure_endpoint',
      detail: 'http://example.com',
    });
    await expect(discoverAuthorizationServer('http://example.com/')).rejects.toMatchObject({
      code: 'insecure_endpoint',
    });
    expect(hits).toEqual([]);
  });

  it('元数据里的非回环 http 端点被拒（insecure_endpoint）', async () => {
    routes['/.well-known/oauth-authorization-server'] = {
      body: {
        issuer: base,
        authorization_endpoint: 'http://example.com/authorize',
        token_endpoint: `${base}/token`,
      },
    };
    await expect(discoverAuthorizationServer(base)).rejects.toMatchObject({
      code: 'insecure_endpoint',
    });
  });

  it('可选端点（registration/revocation/userinfo）同样过准入', async () => {
    routes['/.well-known/oauth-authorization-server'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        userinfo_endpoint: 'http://example.com/userinfo',
      },
    };
    await expect(discoverAuthorizationServer(base)).rejects.toMatchObject({
      code: 'insecure_endpoint',
    });
  });

  it('元数据缺 authorization_endpoint 视为不可用并回退下一候选', async () => {
    routes['/.well-known/oauth-authorization-server'] = {
      body: { issuer: base, token_endpoint: `${base}/token` },
    };
    routes['/.well-known/openid-configuration'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/oidc/authorize`,
        token_endpoint: `${base}/oidc/token`,
      },
    };
    const meta = await discoverAuthorizationServer(base);
    expect(meta.authorizationEndpoint).toBe(`${base}/oidc/authorize`);
  });

  it('非 JSON 响应体视为不可用', async () => {
    routes['/.well-known/oauth-authorization-server'] = { raw: '<html>nope</html>' };
    routes['/.well-known/openid-configuration'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
      },
    };
    const meta = await discoverAuthorizationServer(base);
    expect(meta.authorizationEndpoint).toBe(`${base}/authorize`);
  });

  it('scopes_supported 过滤非字符串项', async () => {
    routes['/.well-known/oauth-authorization-server'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        scopes_supported: ['repo', 42, null, 'read'],
      },
    };
    const meta = await discoverAuthorizationServer(base);
    expect(meta.scopesSupported).toEqual(['repo', 'read']);
  });
});

describe('discoverAuthorizationServer 重定向处理（R2）', () => {
  it('跟随一次经准入校验的绝对重定向拿到元数据', async () => {
    routes['/.well-known/oauth-authorization-server'] = {
      status: 302,
      headers: { location: `${base}/as-metadata` },
    };
    routes['/as-metadata'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
      },
    };
    const meta = await discoverAuthorizationServer(base);
    expect(meta.authorizationEndpoint).toBe(`${base}/authorize`);
    expect(meta.registrationEndpoint).toBeNull();
    // 文档缺 registration_endpoint → 继续探测剩余候选（OIDC 404 后以首个文档兜底）
    expect(hits).toEqual([
      '/.well-known/oauth-authorization-server',
      '/as-metadata',
      '/.well-known/openid-configuration',
    ]);
  });

  it('相对 Location 按当前 URL 解析', async () => {
    routes['/.well-known/oauth-authorization-server'] = {
      status: 301,
      headers: { location: '/as-metadata-relative' },
    };
    routes['/as-metadata-relative'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
      },
    };
    const meta = await discoverAuthorizationServer(base);
    expect(meta.tokenEndpoint).toBe(`${base}/token`);
  });

  it('重定向到非回环 http 端点被拒（insecure_endpoint），不发出该请求', async () => {
    routes['/.well-known/oauth-authorization-server'] = {
      status: 307,
      headers: { location: 'http://example.com/.well-known/oauth-authorization-server' },
    };
    await expect(discoverAuthorizationServer(base)).rejects.toMatchObject({
      code: 'insecure_endpoint',
      detail: 'http://example.com/.well-known/oauth-authorization-server',
    });
    expect(hits).toEqual(['/.well-known/oauth-authorization-server']);
  });

  it('超过 5 跳抛 discovery_failed', async () => {
    routes['/.well-known/oauth-authorization-server'] = {
      status: 302,
      headers: { location: `${base}/loop` },
    };
    routes['/loop'] = { status: 302, headers: { location: `${base}/loop` } };

    await expect(discoverAuthorizationServer(base)).rejects.toMatchObject({
      code: 'discovery_failed',
    });
    // 候选自身 1 次 + 最多 5 次跟随 = 6 次请求后放弃
    expect(hits.filter((h) => h === '/loop')).toHaveLength(5);
  });

  it('恰好在第 5 跳拿到元数据时成功', async () => {
    routes['/.well-known/oauth-authorization-server'] = {
      status: 302,
      headers: { location: `${base}/hop1` },
    };
    routes['/hop1'] = { status: 302, headers: { location: `${base}/hop2` } };
    routes['/hop2'] = { status: 302, headers: { location: `${base}/hop3` } };
    routes['/hop3'] = { status: 302, headers: { location: `${base}/hop4` } };
    routes['/hop4'] = { status: 302, headers: { location: `${base}/hop5` } };
    routes['/hop5'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
      },
    };
    const meta = await discoverAuthorizationServer(base);
    expect(meta.authorizationEndpoint).toBe(`${base}/authorize`);
  });

  it('3xx 无 Location 视为不可用（回退 OIDC）', async () => {
    routes['/.well-known/oauth-authorization-server'] = { status: 302 };
    routes['/.well-known/openid-configuration'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
      },
    };
    const meta = await discoverAuthorizationServer(base);
    expect(meta.authorizationEndpoint).toBe(`${base}/authorize`);
  });

  it('5xx 视为不可用（回退 OIDC）', async () => {
    routes['/.well-known/oauth-authorization-server'] = { status: 503 };
    routes['/.well-known/openid-configuration'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
      },
    };
    const meta = await discoverAuthorizationServer(base);
    expect(meta.authorizationEndpoint).toBe(`${base}/authorize`);
  });

  it('非法 Location 视为不可用，不抛裸 TypeError', async () => {
    routes['/.well-known/oauth-authorization-server'] = {
      status: 302,
      headers: { location: 'http://[bad' },
    };
    routes['/.well-known/openid-configuration'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
      },
    };
    const meta = await discoverAuthorizationServer(base);
    expect(meta.authorizationEndpoint).toBe(`${base}/authorize`);
  });
});

describe('discoverForResource', () => {
  it('经 WWW-Authenticate 资源元数据找到 AS', async () => {
    routes['/.well-known/oauth-protected-resource'] = { body: { authorization_servers: [base] } };
    routes['/.well-known/oauth-authorization-server'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
      },
    };
    const meta = await discoverForResource(
      `${base}/mcp`,
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    );
    expect(meta.authorizationEndpoint).toBe(`${base}/authorize`);
  });

  it('无 WWW-Authenticate 时回退资源根下的 protected-resource', async () => {
    routes['/mcp/.well-known/oauth-protected-resource'] = {
      body: { authorization_servers: [base] },
    };
    routes['/.well-known/oauth-authorization-server'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
      },
    };
    const meta = await discoverForResource(`${base}/mcp`, null);
    expect(meta.tokenEndpoint).toBe(`${base}/token`);
  });

  it('无头回退优先 RFC 9728 路径插入式（Notion 形态：追加式 401 不得判死）', async () => {
    // 真实形态复刻：追加式打到受保护端点返回 401（非 404），插入式才是 200
    routes['/mcp/.well-known/oauth-protected-resource'] = { status: 401 };
    routes['/.well-known/oauth-protected-resource/mcp'] = {
      body: { authorization_servers: [base] },
    };
    routes['/.well-known/oauth-authorization-server'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
      },
    };
    const meta = await discoverForResource(`${base}/mcp`, null);
    expect(meta.authorizationEndpoint).toBe(`${base}/authorize`);
  });

  it('插入式/追加式均不可用时回退根形式 well-known', async () => {
    routes['/mcp/.well-known/oauth-protected-resource'] = { status: 401 };
    // /.well-known/oauth-protected-resource/mcp 未注册 → fixture 默认 404
    routes['/.well-known/oauth-protected-resource'] = {
      body: { authorization_servers: [base] },
    };
    routes['/.well-known/oauth-authorization-server'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
      },
    };
    const meta = await discoverForResource(`${base}/mcp`, null);
    expect(meta.tokenEndpoint).toBe(`${base}/token`);
  });

  it('资源元数据 URL 的重定向同样逐跳过准入', async () => {
    routes['/meta-start'] = {
      status: 302,
      headers: { location: '/meta-final' },
    };
    routes['/meta-final'] = { body: { authorization_servers: [base] } };
    routes['/.well-known/oauth-authorization-server'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
      },
    };
    const meta = await discoverForResource(
      `${base}/mcp`,
      `Bearer resource_metadata="${base}/meta-start"`,
    );
    expect(meta.authorizationEndpoint).toBe(`${base}/authorize`);
  });

  it('资源元数据 URL 重定向到非回环 http 端点被拒', async () => {
    routes['/meta-start'] = {
      status: 302,
      headers: { location: 'http://example.com/meta' },
    };
    await expect(
      discoverForResource(`${base}/mcp`, `Bearer resource_metadata="${base}/meta-start"`),
    ).rejects.toMatchObject({ code: 'insecure_endpoint' });
  });

  it('authorization_servers 为空/类型错误抛 discovery_failed', async () => {
    routes['/.well-known/oauth-protected-resource'] = { body: { authorization_servers: 'nope' } };
    await expect(
      discoverForResource(
        `${base}/mcp`,
        `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      ),
    ).rejects.toMatchObject({ code: 'discovery_failed' });
  });

  it('首个 AS 不可用时尝试下一个', async () => {
    routes['/.well-known/oauth-protected-resource'] = {
      body: { authorization_servers: ['http://127.0.0.1:1', base] },
    };
    routes['/.well-known/oauth-authorization-server'] = {
      body: {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
      },
    };
    const meta = await discoverForResource(
      `${base}/mcp`,
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    );
    expect(meta.authorizationEndpoint).toBe(`${base}/authorize`);
  });

  it('资源元数据本身不可达抛 discovery_failed', async () => {
    await expect(
      discoverForResource(`${base}/mcp`, `Bearer resource_metadata="${base}/missing"`),
    ).rejects.toMatchObject({ code: 'discovery_failed' });
  });
});
