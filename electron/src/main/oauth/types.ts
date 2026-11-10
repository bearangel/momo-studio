// electron/src/main/oauth/types.ts
//
// 公共 OAuth 模块对外类型（spec 2026-11-10 §6/§15）。
// 约束：本文件不得 import 任何 electron / DB / keychain 模块（纯类型 + 错误类），
// 供 protocol/ store/ service/ 三层共用，避免循环依赖。

export type OAuthErrorCode =
  | 'needs_reauth'
  | 'authorization_pending'
  | 'authorization_cancelled'
  | 'authorization_timeout'
  | 'discovery_failed'
  | 'registration_failed'
  | 'token_exchange_failed'
  | 'refresh_failed'
  | 'no_connection'
  | 'insecure_endpoint'
  | 'redirect_port_in_use'
  | 'keychain_unavailable'
  | 'oauth_env_var_required';

export class OAuthFailure extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
    readonly connectionId?: string,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'OAuthFailure';
  }
}

export type OAuthConnectionStatus = 'connected' | 'needs_reauth' | 'revoked';
export type OAuthConnectionSource = 'manual' | 'mcp' | 'preset';
export type ClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

export interface OAuthConnection {
  id: string;
  providerKey: string;
  displayName: string;
  accountLabel: string;
  issuer: string | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  userinfoEndpoint: string | null;
  clientId: string;
  clientAuthMethod: ClientAuthMethod;
  scopes: string;
  resource: string | null;
  extraAuthorizeParams: Record<string, string>;
  extraTokenParams: Record<string, string>;
  redirectHost: string;
  redirectPort: number | null;
  allowInsecureTls: boolean;
  status: OAuthConnectionStatus;
  expiresAt: string | null;
  lastRefreshedAt: string | null;
  source: OAuthConnectionSource;
  createdAt: string;
  updatedAt: string;
}

export interface OAuthConnectionInsert {
  providerKey: string;
  displayName: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  accountLabel?: string;
  issuer?: string | null;
  registrationEndpoint?: string | null;
  revocationEndpoint?: string | null;
  userinfoEndpoint?: string | null;
  clientAuthMethod?: ClientAuthMethod;
  scopes?: string;
  resource?: string | null;
  extraAuthorizeParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
  redirectHost?: string;
  redirectPort?: number | null;
  allowInsecureTls?: boolean;
  status?: OAuthConnectionStatus;
  expiresAt?: string | null;
  source?: OAuthConnectionSource;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** ISO；null = 不过期 */
  expiresAt: string | null;
  tokenType: string;
  scope: string | null;
}

/** 消费方可用的认证材料（不含 accessToken 字段名） */
export interface AuthMaterial {
  headers?: Record<string, string>;
  env?: Record<string, string>;
  expiresAt?: string | null;
  connectionId: string;
}

/** 授权条件（流程中间产物；clientSecret 仅在流程内存中存在，不落库） */
export interface AuthRequirement {
  providerKey: string;
  displayName: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  issuer: string | null;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  userinfoEndpoint: string | null;
  clientId: string | null;
  clientSecret?: string | null;
  clientAuthMethod: ClientAuthMethod;
  scopes: string;
  resource: string | null;
  extraAuthorizeParams: Record<string, string>;
  extraTokenParams: Record<string, string>;
  redirectHost: string;
  redirectPort: number | null;
  allowInsecureTls: boolean;
  source: OAuthConnectionSource;
}

/** renderer 可见视图（永不含 token） */
export interface ConnectionView {
  id: string;
  displayName: string;
  accountLabel: string;
  status: OAuthConnectionStatus;
  scopes: string;
  expiresAt: string | null;
  source: OAuthConnectionSource;
}
