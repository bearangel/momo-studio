// electron/src/main/oauth/protocol/authorize.ts
//
// 授权 URL 构造（RFC 6749 §4.1.1 + PKCE S256 + RFC 8707 resource）。
// 端点先过 endpoint-guard：用户配置端点与 discovery 返回端点同等对待（spec §7.1/§10）。
import { assertEndpointAllowed } from './endpoint-guard';

export interface BuildAuthorizationUrlRequest {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  state: string;
  codeChallenge: string;
  resource: string | null;
  extraParams: Record<string, string>;
}

export function buildAuthorizationUrl(req: BuildAuthorizationUrlRequest): string {
  assertEndpointAllowed(req.authorizationEndpoint);
  const url = new URL(req.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', req.clientId);
  url.searchParams.set('redirect_uri', req.redirectUri);
  if (req.scopes) url.searchParams.set('scope', req.scopes);
  url.searchParams.set('state', req.state);
  url.searchParams.set('code_challenge', req.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (req.resource) url.searchParams.set('resource', req.resource);
  // extraParams 最后写入：显式配置可覆盖默认参数（如非标准 prompt / audience）
  for (const [key, value] of Object.entries(req.extraParams)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
