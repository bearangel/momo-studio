// electron/src/main/oauth/protocol/endpoint-guard.ts
//
// 端点准入（spec §7.1/§10）：https 任意；http 仅回环。作用于用户配置端点与
// **discovery 返回的端点**——防远程 MCP 用 WWW-Authenticate 把用户引向明文 AS。
import { isHttpsOrLoopbackHttp } from '../../util/url-guard';
import { OAuthFailure } from '../types';

export function assertEndpointAllowed(url: string): void {
  if (!isHttpsOrLoopbackHttp(url)) {
    throw new OAuthFailure(
      'insecure_endpoint',
      '授权端点必须使用 https://（本机回环地址可用 http://）',
      undefined,
      url,
    );
  }
}
