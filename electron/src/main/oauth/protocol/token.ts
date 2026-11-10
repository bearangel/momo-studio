// electron/src/main/oauth/protocol/token.ts
//
// RFC 6749 令牌端点三操作：授权码交换 / refresh / revoke（spec §8/§11）。
// 响应统一归一为 OAuthTokenSet；错误统一归一为 OAuthFailure，映射契约：
//   exchange 任意失败        → token_exchange_failed
//   refresh invalid_grant    → needs_reauth（生命周期据此置位待重授权）
//   refresh 其余失败（含 5xx）→ refresh_failed（可重试）
// detail 一律携带服务端错误码字符串（无错误码时退化为 HTTP 状态码），便于排障与 UI 展示。
import { logger } from '../../logger';
import { OAuthFailure, type ClientAuthMethod, type OAuthTokenSet } from '../types';
import { assertEndpointAllowed } from './endpoint-guard';
import { resolveFetch, type FetchLike } from './http';

/** 令牌端点请求超时：30s——比全局 fetch 默认宽松，但防止连接挂死阻塞生命周期 */
const TIMEOUT_MS = 30_000;

interface TokenRequestBase {
  tokenEndpoint: string;
  clientId: string;
  clientAuthMethod: ClientAuthMethod;
  /** 仅 client_secret_* 方式使用；流程内存中存在，不落库 */
  clientSecret?: string | null;
  extraParams: Record<string, string>;
  allowInsecureTls: boolean;
  /** 测试注入点；生产不传，由 allowInsecureTls 决定 */
  fetchImpl?: FetchLike;
}

export interface ExchangeCodeRequest extends TokenRequestBase {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface RefreshRequest extends TokenRequestBase {
  refreshToken: string;
}

export interface RevokeRequest {
  revocationEndpoint: string;
  token: string;
  tokenTypeHint: 'access_token' | 'refresh_token';
  clientId: string;
  clientAuthMethod: ClientAuthMethod;
  clientSecret?: string | null;
  allowInsecureTls: boolean;
  fetchImpl?: FetchLike;
}

interface TokenResponseShape {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

type TokenFailureCode = 'token_exchange_failed' | 'refresh_failed';

/**
 * 按 RFC 6749 §2.3.1 施加客户端认证。
 * client_secret_basic：id/secret 必须先各自 URL 编码再以 ':' 拼接后 base64
 * （否则 secret 中的 ':' ' ' '+' 等字符会把凭据拆错位）。
 */
function applyClientAuth(
  method: ClientAuthMethod,
  body: URLSearchParams,
  headers: Record<string, string>,
  clientId: string,
  clientSecret?: string | null,
): void {
  if (method === 'none') {
    body.set('client_id', clientId);
    return;
  }
  if (method === 'client_secret_post') {
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret ?? '');
    return;
  }
  const pair = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret ?? '')}`;
  headers.Authorization = `Basic ${Buffer.from(pair).toString('base64')}`;
}

/**
 * 归一令牌响应。status >= 400 或响应体带 error 字段都视为失败（部分服务端会
 * 以 200 返回 error）：refresh 的 invalid_grant 升级为 needs_reauth，其余按调用方
 * 传入的 failureCode 归类。
 */
function parseTokenResponse(
  status: number,
  raw: TokenResponseShape,
  failureCode: TokenFailureCode,
): OAuthTokenSet {
  const error = typeof raw.error === 'string' ? raw.error : null;
  if (status >= 400 || error) {
    const code = failureCode === 'refresh_failed' && error === 'invalid_grant'
      ? 'needs_reauth'
      : failureCode;
    const description =
      typeof raw.error_description === 'string' ? raw.error_description : undefined;
    throw new OAuthFailure(
      code,
      description ?? `令牌端点返回 ${status}`,
      undefined,
      error ?? String(status),
    );
  }
  if (typeof raw.access_token !== 'string' || raw.access_token === '') {
    throw new OAuthFailure(failureCode, '令牌端点响应缺少 access_token');
  }
  // expires_in 为秒；按本地时钟换算成 ISO（null = 不过期，调用方不主动刷新）。
  // Number.isFinite 拦 1e400 这类 JSON 解析出的 Infinity——否则 toISOString 抛 RangeError
  // 逃出 OAuth 错误契约。
  const expiresIn = typeof raw.expires_in === 'number' && Number.isFinite(raw.expires_in)
    ? raw.expires_in
    : null;
  return {
    accessToken: raw.access_token,
    refreshToken:
      typeof raw.refresh_token === 'string' && raw.refresh_token !== ''
        ? raw.refresh_token
        : null,
    expiresAt: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000).toISOString(),
    tokenType:
      typeof raw.token_type === 'string' && raw.token_type !== '' ? raw.token_type : 'Bearer',
    scope: typeof raw.scope === 'string' ? raw.scope : null,
  };
}

interface PostFormResult {
  status: number;
  json: TokenResponseShape;
}

async function postForm(
  url: string,
  body: URLSearchParams,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<PostFormResult> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    // 禁止跟随重定向：307/308 会原样重发 POST body——授权码 + code_verifier、
    // client_secret_post 的 secret、撤销 token 都会被打到未经 endpoint-guard 的
    // 目标（约束：每个请求 URL 都必须通过 assertEndpointAllowed）。3xx 交给
    // 状态码分支归一为 OAuthFailure。
    redirect: 'error',
  });
  const text = await response.text();
  let json: TokenResponseShape = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) json = parsed as TokenResponseShape;
  } catch {
    // 非 JSON 响应：不在此报错，交给状态码分支统一归类（2xx 也会因缺 access_token 失败）
  }
  return { status: response.status, json };
}

/** 网络层失败（拒绝连接/超时/DNS）同样纳入令牌错误码契约，而非裸 TypeError 上抛 */
async function postFormOrFail(
  url: string,
  body: URLSearchParams,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
  failureCode: TokenFailureCode,
): Promise<PostFormResult> {
  try {
    return await postForm(url, body, headers, fetchImpl);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new OAuthFailure(failureCode, `令牌端点请求失败：${detail}`, undefined, detail);
  }
}

export async function exchangeCode(req: ExchangeCodeRequest): Promise<OAuthTokenSet> {
  assertEndpointAllowed(req.tokenEndpoint);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: req.code,
    code_verifier: req.codeVerifier,
    redirect_uri: req.redirectUri,
  });
  const headers: Record<string, string> = {};
  applyClientAuth(req.clientAuthMethod, body, headers, req.clientId, req.clientSecret);
  for (const [k, v] of Object.entries(req.extraParams)) body.set(k, v);
  const { status, json } = await postFormOrFail(
    req.tokenEndpoint,
    body,
    headers,
    req.fetchImpl ?? resolveFetch(req.allowInsecureTls),
    'token_exchange_failed',
  );
  return parseTokenResponse(status, json, 'token_exchange_failed');
}

export async function refreshTokens(req: RefreshRequest): Promise<OAuthTokenSet> {
  assertEndpointAllowed(req.tokenEndpoint);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: req.refreshToken,
  });
  const headers: Record<string, string> = {};
  applyClientAuth(req.clientAuthMethod, body, headers, req.clientId, req.clientSecret);
  for (const [k, v] of Object.entries(req.extraParams)) body.set(k, v);
  const { status, json } = await postFormOrFail(
    req.tokenEndpoint,
    body,
    headers,
    req.fetchImpl ?? resolveFetch(req.allowInsecureTls),
    'refresh_failed',
  );
  return parseTokenResponse(status, json, 'refresh_failed');
}

/** 日志脱敏：只取端点 host，解析失败也不阻断撤销流程 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '<invalid-url>';
  }
}

/** 撤销：尽力而为，失败吞掉（spec §11——撤销不阻塞断开主流程），但必须留痕 */
export async function revokeToken(req: RevokeRequest): Promise<void> {
  try {
    assertEndpointAllowed(req.revocationEndpoint);
    const body = new URLSearchParams({ token: req.token, token_type_hint: req.tokenTypeHint });
    const headers: Record<string, string> = {};
    applyClientAuth(req.clientAuthMethod, body, headers, req.clientId, req.clientSecret);
    await postForm(
      req.revocationEndpoint,
      body,
      headers,
      req.fetchImpl ?? resolveFetch(req.allowInsecureTls),
    );
  } catch (err) {
    // 只记错误消息与端点 host——绝不记 token 值（日志会落盘）
    logger.warn('OAuth 撤销令牌失败（尽力而为，不阻塞断开）', {
      host: hostOf(req.revocationEndpoint),
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
