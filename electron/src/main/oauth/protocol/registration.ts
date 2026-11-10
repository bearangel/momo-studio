// electron/src/main/oauth/protocol/registration.ts
//
// RFC 7591 动态客户端注册。桌面公共客户端（PKCE）通常拿到 authMethod='none'；
// 若服务端返回 secret 且指定了认证方式则原样保存（走 keychain）。
//
// 请求安全（Task 5 / 裁决 R2）：注册 POST 是「请求承载型」调用，必须 redirect: 'error'——
// 3xx 一律不跟随，否则 307/308 会把含 redirect_uris/client_name 的 JSON 重发到未过
// endpoint-guard 的目标。fetch 因此 reject，由下方 catch 归一为 registration_failed。
import { logger } from '../../logger';
import { OAuthFailure, type ClientAuthMethod } from '../types';
import { assertEndpointAllowed } from './endpoint-guard';
import { resolveFetch, type FetchLike } from './http';

/** 注册端点请求超时：30s——与令牌端点一致，防连接挂死阻塞授权流程 */
const TIMEOUT_MS = 30_000;

export interface RegisterClientRequest {
  registrationEndpoint: string;
  redirectUris: string[];
  clientName: string;
  scopes: string;
  allowInsecureTls: boolean;
  /** 测试注入点；生产不传，由 allowInsecureTls 决定 */
  fetchImpl?: FetchLike;
}

export interface RegisterClientResult {
  clientId: string;
  clientSecret: string | null;
  authMethod: ClientAuthMethod;
}

/**
 * 认证方式归一：只认 client_secret_post / client_secret_basic。
 * 其余（含 'none'、未知值、缺省、非字符串）一律降级为 none——RFC 7591 默认值即 none，
 * 且桌面公共客户端不应因服务端返回 private_key_jwt 等无法实现的类型而中断授权。
 */
function normalizeAuthMethod(raw: unknown): ClientAuthMethod {
  if (raw === 'client_secret_post' || raw === 'client_secret_basic') return raw;
  return 'none';
}

/** 日志脱敏：只取端点 host；解析失败也不阻断错误上抛 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '<invalid-url>';
  }
}

export async function registerClient(req: RegisterClientRequest): Promise<RegisterClientResult> {
  assertEndpointAllowed(req.registrationEndpoint);
  const fetchFn = req.fetchImpl ?? resolveFetch(req.allowInsecureTls);
  const payload = {
    client_name: req.clientName,
    redirect_uris: req.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(req.scopes ? { scope: req.scopes } : {}),
  };

  let body = '';
  let status = 0;
  let ok = false;
  try {
    const response = await fetchFn(req.registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // 禁止跟随重定向（R2）：3xx 让 fetch 直接 reject，绝不把请求体重发到未校验目标
      redirect: 'error',
    });
    status = response.status;
    ok = response.ok;
    body = await response.text();
  } catch (err) {
    // 网络层失败 / 超时 / 重定向被拒（redirect:'error' 的 TypeError）
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn('OAuth 动态客户端注册请求失败', {
      host: hostOf(req.registrationEndpoint),
      detail,
    });
    throw new OAuthFailure('registration_failed', '动态客户端注册请求失败', undefined, detail);
  }

  // 显式非 2xx 闸门：必须先于字段提取拒绝，否则病态非 2xx 响应体若恰好含
  // client_id 会被误认为注册成功（错误码/成功判定不能只依赖响应体形状）。
  if (!ok) {
    throw new OAuthFailure('registration_failed', `动态客户端注册失败（HTTP ${status}）`);
  }

  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      json = parsed as Record<string, unknown>;
    }
  } catch {
    // 非 JSON 响应：不在此报错，交给下方 client_id 缺失分支统一归类
  }

  const clientId = typeof json.client_id === 'string' && json.client_id !== ''
    ? json.client_id
    : null;
  if (!clientId) {
    throw new OAuthFailure('registration_failed', `动态客户端注册失败（HTTP ${status}）`);
  }
  return {
    clientId,
    clientSecret:
      typeof json.client_secret === 'string' && json.client_secret !== ''
        ? json.client_secret
        : null,
    authMethod: normalizeAuthMethod(json.token_endpoint_auth_method),
  };
}
