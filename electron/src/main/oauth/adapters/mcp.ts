// electron/src/main/oauth/adapters/mcp.ts
//
// MCP 适配器（spec §9）。职责：
//   - 把连接凭据翻译成 MCP 消费形态（http → Authorization header；stdio → 环境变量）
//   - 把解析器注入 host-manager（setter 反接，避免 mcp ↔ oauth 循环依赖；
//     依赖方向约束：本文件可 import mcp/host-manager，mcp/* 不得 import oauth/*）
// 令牌不出主进程：这里拿到的 access token 只用于拼 header/env，随后随 config 进入
// transport 构造，不会流向 renderer；任何日志不得记录 token 值。
import { logger } from '../../logger';
import { getConnection } from '../store';
import { ensureFreshAccessToken } from '../lifecycle';
import { setMcpAuthResolver } from '../../mcp/host-manager';
import { OAuthFailure, type AuthMaterial } from '../types';
import type { McpServerConfig } from '../../mcp/types';

export interface McpAuthTarget {
  url?: string | null;
  transport?: 'stdio' | 'streamable_http';
  envVar?: string | null;
}

export async function resolveMcpAuthMaterial(
  connectionId: string,
  target: McpAuthTarget,
): Promise<AuthMaterial> {
  const conn = getConnection(connectionId);
  if (!conn) throw new OAuthFailure('no_connection', 'OAuth 连接不存在', connectionId);
  const accessToken = await ensureFreshAccessToken(connectionId);

  if ((target.transport ?? 'stdio') === 'streamable_http') {
    return {
      connectionId,
      headers: { Authorization: `Bearer ${accessToken}` },
      expiresAt: conn.expiresAt,
    };
  }
  const envVar = target.envVar?.trim();
  if (!envVar) {
    throw new OAuthFailure(
      'oauth_env_var_required',
      'stdio MCP 绑定 OAuth 时必须指定注入的环境变量名',
      connectionId,
    );
  }
  return {
    connectionId,
    env: { [envVar]: accessToken },
    expiresAt: conn.expiresAt,
  };
}

export function applyMcpMaterial(config: McpServerConfig, material: AuthMaterial): McpServerConfig {
  const next: McpServerConfig = { ...config };
  if (material.headers) {
    // OAuth 覆盖手填 Authorization（避免两套凭据打架），其他 header 保留
    next.headers = { ...(config.headers ?? {}), ...material.headers };
  }
  if (material.env) {
    // OAuth env 合并进既有 env，不整体替换（PATH 等既有变量保留）
    next.env = { ...(config.env ?? {}), ...material.env };
  }
  return next;
}

/**
 * boot 时调用一次：把解析器注入 host-manager，MCP 建连前回调本解析器完成
 * resolve + apply（未绑定连接返回 null，零开销）。
 *
 * 池契约：host-manager 按 workspace+mcpName 池化客户端实例——实例存续期间
 * （isConnected）本解析器不会被再次调用，token 不会随刷新轮换。令牌到期前
 * 由服务层先 evictMcpsByConnection 驱逐池内实例，下次 getOrStartMcp 重建
 * 连接时才取到新 token（该驱逐已由 Task 14 的 setOAuthChangeListener 接线）。
 */
export function wireMcpOAuth(): void {
  setMcpAuthResolver(async (config) => {
    if (!config.oauthConnectionId) return null;
    const material = await resolveMcpAuthMaterial(config.oauthConnectionId, {
      url: config.url,
      transport: config.transport ?? 'stdio',
      envVar: config.oauthEnvVar ?? null,
    });
    return applyMcpMaterial(config, material);
  });
  logger.info('MCP OAuth 认证解析器已接线');
}
