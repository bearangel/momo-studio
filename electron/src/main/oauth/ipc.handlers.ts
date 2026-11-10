// electron/src/main/oauth/ipc.handlers.ts
//
// oauth:* IPC 注册入口（thin adapter，零业务逻辑）。服务实例在 invoke 时刻解析
// （boot 顺序：registerIpcHandlers 先于 OAuth 生命周期启动）。
// 推送：oauth:authorizationChanged（流程状态）、oauth:connectionsChanged（列表刷新）。
import { ipcMain, BrowserWindow } from 'electron';
import { logger } from '../logger';
import { evictMcpsByConnection } from '../mcp/host-manager';
import {
  beginAuthorization, completeWithManualCallback, cancelAuthorization,
  listConnectionViews, getConnectionView, disconnect, removeConnection,
  setOAuthChangeListener, setAuthorizationCompleteListener,
} from './service';
import { beginAuthorizationForMcp, bindConnectionToMcp } from './mcp-trigger';
import { listPresets } from './presets';
import { OAuthFailure, type ConnectionView } from './types';

const AUTHORIZATION_CHANGED = 'oauth:authorizationChanged';
const CONNECTIONS_CHANGED = 'oauth:connectionsChanged';

/** pendingId → 绑定的 MCP（loopback 完成后回写用） */
const pendingMcpIntent = new Map<string, { mcpName: string; envVar: string | null }>();

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

/** 非字符串/空串的 id 类参数统一拒绝（畸形输入不得击穿到 sqlite 绑定层抛英文错） */
function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new OAuthFailure('no_connection', `${label} 不能为空`);
  }
  return value;
}

export function registerOAuthHandlers(): void {
  // 令牌刷新/撤销 → 扇出驱逐 + 推送列表刷新
  setOAuthChangeListener(async (connectionId, kind) => {
    try {
      await evictMcpsByConnection(connectionId);
    } catch (err) {
      logger.warn('OAuth 变更后驱逐 MCP 池失败', { error: (err as Error).message });
    }
    broadcast(CONNECTIONS_CHANGED, { at: Date.now(), connectionId, kind });
  });

  // loopback 异步完成 → 回写绑定 + 推送
  setAuthorizationCompleteListener((pendingId, view) => {
    const intent = pendingMcpIntent.get(pendingId);
    pendingMcpIntent.delete(pendingId);
    const finish = async (): Promise<void> => {
      if (intent) {
        await bindConnectionToMcp(intent.mcpName, view.id, intent.envVar);
      }
      broadcast(AUTHORIZATION_CHANGED, { pendingId, status: 'connected', connectionId: view.id });
      broadcast(CONNECTIONS_CHANGED, { at: Date.now(), connectionId: view.id, kind: 'connected' });
    };
    void finish().catch((err: unknown) => {
      broadcast(AUTHORIZATION_CHANGED, {
        pendingId,
        status: 'failed',
        error: { code: 'no_connection', message: (err as Error).message },
      });
    });
  });

  ipcMain.handle('oauth:listConnections', () => listConnectionViews());

  ipcMain.handle('oauth:getConnection', (_evt, id: unknown) =>
    getConnectionView(requireId(id, '连接 ID')),
  );

  ipcMain.handle('oauth:listPresets', () => listPresets());

  ipcMain.handle('oauth:beginAuthorization', async (_evt, input: unknown) => {
    if (typeof input !== 'object' || input === null) {
      throw new OAuthFailure('no_connection', '授权参数无效');
    }
    // BeginInput 两态（R5）：manual 表单或 mcpName——两者皆缺时放行会让
    // buildRequirement 落进 getMcpConfig(undefined) 的 sqlite 绑定异常
    const obj = input as Record<string, unknown>;
    const hasManual = typeof obj.manual === 'object' && obj.manual !== null;
    const hasMcpName = typeof obj.mcpName === 'string' && obj.mcpName !== '';
    if (!hasManual && !hasMcpName) {
      throw new OAuthFailure('no_connection', '授权参数无效：需 manual 表单或 mcpName');
    }
    return beginAuthorization(input as Parameters<typeof beginAuthorization>[0]);
  });

  ipcMain.handle(
    'oauth:beginAuthorizationForMcp',
    async (_evt, mcpName: unknown, envVar: unknown) => {
      const name = requireId(mcpName, 'MCP 名称');
      // envVar 只接受非空字符串或 null（其余一律降级为 null，不猜注入意图）
      const varName = typeof envVar === 'string' && envVar !== '' ? envVar : null;
      const result = await beginAuthorizationForMcp(name, varName);
      if (result.pendingId) {
        pendingMcpIntent.set(result.pendingId, { mcpName: name, envVar: varName });
      }
      return result;
    },
  );

  ipcMain.handle('oauth:completeWithManualCallback', async (_evt, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      throw new OAuthFailure('no_connection', '回调参数无效');
    }
    const { pendingId, input } = payload as { pendingId?: unknown; input?: unknown };
    requireId(pendingId, 'pendingId');
    if (typeof input !== 'string' || input === '') {
      throw new OAuthFailure('no_connection', '回调内容无效');
    }
    const view: ConnectionView = await completeWithManualCallback({
      pendingId: pendingId as string,
      input,
    });
    const intent = pendingMcpIntent.get(pendingId as string);
    pendingMcpIntent.delete(pendingId as string);
    if (intent) await bindConnectionToMcp(intent.mcpName, view.id, intent.envVar);
    broadcast(AUTHORIZATION_CHANGED, {
      pendingId: pendingId as string, status: 'connected', connectionId: view.id,
    });
    broadcast(CONNECTIONS_CHANGED, { at: Date.now(), connectionId: view.id, kind: 'connected' });
    return view;
  });

  ipcMain.handle('oauth:cancelAuthorization', async (_evt, pendingId: unknown) => {
    const id = requireId(pendingId, 'pendingId');
    pendingMcpIntent.delete(id);
    await cancelAuthorization(id);
    broadcast(AUTHORIZATION_CHANGED, { pendingId: id, status: 'cancelled' });
  });

  ipcMain.handle('oauth:disconnect', (_evt, id: unknown) => disconnect(requireId(id, '连接 ID')));

  ipcMain.handle('oauth:removeConnection', (_evt, id: unknown) =>
    removeConnection(requireId(id, '连接 ID')),
  );

  logger.info('OAuth IPC handlers 已注册');
}
