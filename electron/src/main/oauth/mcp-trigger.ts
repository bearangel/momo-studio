// electron/src/main/oauth/mcp-trigger.ts
//
// MCP 微触发（spec §9.4）：授权成功后回写绑定并驱逐池实例，
// renderer 收到 connected 事件后用既有 mcp:start 完成重连（主进程不猜 workspace）。
import { logger } from '../logger';
import { getMcpConfig, evictMcpByName, setMcpOAuthBinding } from '../mcp/host-manager';
import { beginAuthorization, type BeginResult } from './service';
import { OAuthFailure } from './types';

export async function bindConnectionToMcp(
  mcpName: string,
  connectionId: string,
  envVar: string | null = null,
): Promise<void> {
  const config = getMcpConfig(mcpName);
  if (!config) throw new OAuthFailure('no_connection', `MCP ${mcpName} 未注册`);
  setMcpOAuthBinding(mcpName, connectionId, (config.transport ?? 'stdio') === 'stdio' ? envVar : null);
  await evictMcpByName(mcpName);
  logger.info('MCP 已绑定 OAuth 连接', { name: mcpName });
}

/** 一键「授权 + 绑定」：begin 返回后由 renderer 打开浏览器，完成后走 complete 事件回写 */
export async function beginAuthorizationForMcp(
  mcpName: string,
  envVar: string | null = null,
): Promise<BeginResult & { mcpName: string; envVar: string | null }> {
  const result = await beginAuthorization({ mcpName });
  if (result.existingConnectionId) {
    await bindConnectionToMcp(mcpName, result.existingConnectionId, envVar);
  }
  return { ...result, mcpName, envVar };
}
