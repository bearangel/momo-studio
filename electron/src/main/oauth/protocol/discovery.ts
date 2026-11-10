// electron/src/main/oauth/protocol/discovery.ts
//
// OAuth 发现（spec §7.2）：
//   1. 401 WWW-Authenticate 的 resource_metadata（RFC 9728）
//   2. 资源元数据的 authorization_servers[]
//   3. 每个 issuer：/.well-known/oauth-authorization-server（RFC 8414）
//      回退 /.well-known/openid-configuration（OIDC）
//   4. issuer 字段必须与来源一致（RFC 8414 §3.3，尾斜杠容差）
// 所有端点（含发现结果）过 assertEndpointAllowed。
//
// 重定向（R2 裁定）：发现 GET 不盲跟——`redirect: 'manual'` 手动处理
// 301/302/303/307/308，Location 先按当前 URL 解析再逐跳 assertEndpointAllowed，
// 最多 5 跳；超限抛 discovery_failed。这样远程 MCP 无法用 302 把发现请求引向
// 未经准入的目标（明文 AS / 内网地址）。
import { assertEndpointAllowed } from './endpoint-guard';
import { resolveFetch, type FetchLike } from './http';
import { OAuthFailure } from '../types';

/** 发现请求超时：30s（与令牌端点同口径），防止挂死阻塞连接建立流程 */
const TIMEOUT_MS = 30_000;

/** 手动跟随重定向的最大跳数（超过即放弃） */
const MAX_REDIRECTS = 5;

/** 手动处理的重定向状态码集合 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface AuthServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  userinfoEndpoint: string | null;
  scopesSupported: string[];
}

interface ResourceMetadataShape {
  authorization_servers?: unknown;
}

interface AsMetadataShape {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  registration_endpoint?: unknown;
  revocation_endpoint?: unknown;
  userinfo_endpoint?: unknown;
  scopes_supported?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/, '');
}

/** WWW-Authenticate 里取 resource_metadata="…"（容忍无引号） */
export function parseResourceMetadataUrl(wwwAuthenticate: string): string | null {
  // 左边界防 `x_resource_metadata=` 之类前缀误匹配（RFC 7235 参数以空格/逗号分隔）
  const match = /(?:^|[\s,])resource_metadata\s*=\s*"?([^"\s,]+)"?/i.exec(wwwAuthenticate);
  return match?.[1] ?? null;
}

/** 丢弃未消费的 3xx 响应体，避免 keep-alive 连接被悬挂响应占住 */
async function drain(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // 取消失败不影响流程（连接最终由 keepAliveTimeout 或调用方关闭）
  }
}

/**
 * 发现用 GET：手动跟随重定向，每跳目标先过端点准入。
 *
 * 语义与既有 getJson 对齐——网络失败 / 非 2xx / 非 JSON 一律返回 null（不可用，
 * 调用方继续试下一个候选）；但**准入失败与跳数超限是硬错误**，必须上抛：
 * 被拒绝的目标不能靠「再试下一个」静默降级为 discovery_failed。
 */
/** 网络级瞬断（连接重置/超时拒绝）立即原样重试一次；HTTP 状态码不是异常，
 *  走正常分支不进 catch。防一次抖动被误判为「端点不存在」（tinyfish/Clerk 实测：
 *  8414 文档瞬断滑落 OIDC 变体会误报「不支持动态注册」）。 */
async function fetchOnceWithRetry(url: string, fetchImpl: FetchLike): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // 手动处理重定向：目标必须先过 assertEndpointAllowed 才能继续
        redirect: 'manual',
      });
    } catch {
      // 首次网络级失败 → 重试一次
    }
  }
  return null;
}

async function getJsonFollowingValidatedRedirects(
  url: string,
  fetchImpl: FetchLike,
): Promise<unknown | null> {
  let current = url;
  let redirects = 0;
  // 无限循环：所有分支都 return/throw，第 MAX_REDIRECTS+1 跳由上方分支抛错退出
  for (;;) {
    const response = await fetchOnceWithRetry(current, fetchImpl);
    if (response === null) return null;

    if (REDIRECT_STATUSES.has(response.status)) {
      await drain(response);
      const location = response.headers.get('location');
      // 无 Location 的 3xx 无法继续，按不可用处理
      if (!location) return null;
      if (redirects === MAX_REDIRECTS) {
        throw new OAuthFailure(
          'discovery_failed',
          `发现请求重定向超过 ${MAX_REDIRECTS} 跳`,
          undefined,
          current,
        );
      }
      redirects += 1;
      let next: string;
      try {
        // Location 允许相对形式，按当前 URL 解析
        next = new URL(location, current).toString();
      } catch {
        return null;
      }
      // 逐跳准入：302 目标同样受 https/回环约束
      assertEndpointAllowed(next);
      current = next;
      continue;
    }

    if (!response.ok) {
      await drain(response);
      return null;
    }
    try {
      return JSON.parse(await response.text()) as unknown;
    } catch {
      return null;
    }
  }
}

/**
 * well-known 候选构造：RFC 9728 §4.1 / RFC 8414 §3.1 的路径插入式优先。
 * 规范把 well-known 插在 origin 与 path 之间；对带路径的 resource/issuer
 * （https://mcp.notion.com/mcp、本地 Keycloak /realms/momo），追加式会打到
 * 受保护端点（401）或 404（2026-11-10 Notion 实测回归）。
 * 顺序：插入式 → 根形式 → 追加式（历史兼容），去重（无路径时三者合一）。
 */
function wellKnownCandidates(base: string, wellKnownPath: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return [`${trimTrailingSlash(base)}/.well-known/${wellKnownPath}`];
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  const trimmedBase = trimTrailingSlash(base);
  return [
    `${parsed.origin}/.well-known/${wellKnownPath}${path}`,
    `${parsed.origin}/.well-known/${wellKnownPath}`,
    `${trimmedBase}/.well-known/${wellKnownPath}`,
  ].filter((value, index, all) => all.indexOf(value) === index);
}

export async function discoverAuthorizationServer(
  issuerUrl: string,
  fetchImpl?: FetchLike,
): Promise<AuthServerMetadata> {
  const issuer = trimTrailingSlash(issuerUrl);
  // R2：issuer 本身同样受准入约束——直接调用也不能向未批准目标发明文发现 GET
  assertEndpointAllowed(issuer);
  const fetchFn = fetchImpl ?? resolveFetch(issuer.startsWith('http://'));
  const candidates = [
    ...wellKnownCandidates(issuer, 'oauth-authorization-server'),
    ...wellKnownCandidates(issuer, 'openid-configuration'),
  ];
  // 带 registration_endpoint 的文档立即定案；首个合法文档兜底。OIDC 变体
  // 常缺 DCR 字段——tinyfish/Clerk 形态下 8414 文档若瞬断被跳过，直接返回
  // OIDC 文档会误报「不支持动态注册」，故缺 DCR 时继续尝试剩余候选。
  let fallbackMeta: AuthServerMetadata | null = null;
  for (const candidate of candidates) {
    const raw = await getJsonFollowingValidatedRedirects(candidate, fetchFn);
    if (raw === null) continue;
    const data = raw as AsMetadataShape;
    const declaredIssuer = asString(data.issuer);
    const authorizationEndpoint = asString(data.authorization_endpoint);
    const tokenEndpoint = asString(data.token_endpoint);
    if (!declaredIssuer || !authorizationEndpoint || !tokenEndpoint) continue;
    if (trimTrailingSlash(declaredIssuer) !== issuer) {
      throw new OAuthFailure(
        'discovery_failed', '授权服务器元数据 issuer 与来源不一致', undefined, declaredIssuer,
      );
    }
    // 发现结果同样过准入——防被恶意资源元数据引向明文 AS
    assertEndpointAllowed(authorizationEndpoint);
    assertEndpointAllowed(tokenEndpoint);
    const registrationEndpoint = asString(data.registration_endpoint);
    const revocationEndpoint = asString(data.revocation_endpoint);
    const userinfoEndpoint = asString(data.userinfo_endpoint);
    if (registrationEndpoint) assertEndpointAllowed(registrationEndpoint);
    if (revocationEndpoint) assertEndpointAllowed(revocationEndpoint);
    if (userinfoEndpoint) assertEndpointAllowed(userinfoEndpoint);
    const meta: AuthServerMetadata = {
      issuer: declaredIssuer,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint,
      revocationEndpoint,
      userinfoEndpoint,
      scopesSupported: Array.isArray(data.scopes_supported)
        ? data.scopes_supported.filter((s): s is string => typeof s === 'string')
        : [],
    };
    if (meta.registrationEndpoint) return meta;
    if (fallbackMeta === null) fallbackMeta = meta;
  }
  if (fallbackMeta !== null) return fallbackMeta;
  throw new OAuthFailure('discovery_failed', `无法发现授权服务器：${issuer}`);
}

export async function discoverForResource(
  resourceUrl: string,
  wwwAuthenticate: string | null,
  fetchImpl?: FetchLike,
): Promise<AuthServerMetadata> {
  const fetchFn = fetchImpl ?? resolveFetch(resourceUrl.startsWith('http://'));
  const metadataUrl = wwwAuthenticate ? parseResourceMetadataUrl(wwwAuthenticate) : null;
  const candidates = metadataUrl
    ? [metadataUrl]
    : wellKnownCandidates(resourceUrl, 'oauth-protected-resource');
  for (const candidate of candidates) {
    assertEndpointAllowed(candidate);
    const raw = await getJsonFollowingValidatedRedirects(candidate, fetchFn);
    if (raw === null) continue;
    const servers = (raw as ResourceMetadataShape).authorization_servers;
    if (!Array.isArray(servers)) continue;
    for (const server of servers) {
      if (typeof server !== 'string' || server === '') continue;
      assertEndpointAllowed(server);
      try {
        return await discoverAuthorizationServer(server, fetchFn);
      } catch {
        // 该 issuer 不可用，继续下一个
      }
    }
  }
  throw new OAuthFailure('discovery_failed', '无法从资源元数据发现授权服务器');
}
