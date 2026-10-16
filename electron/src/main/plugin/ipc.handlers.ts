// electron/src/main/plugin/ipc.handlers.ts
//
// plugin:* IPC 通道（spec §2/§7）。错误约定：直接 throw 中文 Error，renderer
// client 代理层剥前缀后原文展示（同 resource:* 惯例）。二进制传输：renderer
// 传 Uint8Array（contextBridge 里 Node Buffer 跨 structured clone 会损坏），
// 此处归一 Buffer。
import { ipcMain, app } from 'electron';
import { installPluginZip, installPluginDevDir, uninstallPlugin } from './installer';
import { setPluginEnabled, getPlugin as getPluginRecord } from './registry';
import { getPluginBus } from './bus-instance';
import { startPluginService, stopPluginService } from './service-manager';
import { getDb } from '../storage/db';
import { reloadPlugin } from './reload';
import type { PluginManifest, PluginRecord } from './types';

/** 安装结果摘要（renderer 展示用；跨 IPC 纯数据，renderer types.d.ts 有同形定义） */
export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  state: 'active' | 'missing';
  source: 'zip' | 'dev';
  components: string[];
}

function toSummary(rec: PluginRecord): PluginSummary {
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(rec.manifestJson) as PluginManifest;
  } catch {
    manifest = { id: rec.id, name: rec.id, version: rec.version, description: '', components: {} };
  }
  return {
    id: rec.id,
    name: manifest.name,
    version: rec.version,
    description: manifest.description,
    state: rec.state,
    source: rec.source,
    components: Object.keys(manifest.components ?? {}),
  };
}

/**
 * 注册 plugin:* 通道。app ready 后由 registerIpcHandlers（ipc/index.ts）统一调用。
 * 通道清单：installZip / installDevDir / setEnabled / uninstall（重载动作 P2 工具激活时引入）。
 */
export function registerPluginHandlers(): void {
  ipcMain.handle('plugin:installZip', async (_evt, data: Uint8Array, _filename: string) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return toSummary(await installPluginZip(buf, app.getVersion()));
  });

  ipcMain.handle('plugin:installDevDir', (_evt, dir: string) => {
    return toSummary(installPluginDevDir(dir, app.getVersion()));
  });

  ipcMain.handle(
    'plugin:setEnabled',
    async (_evt, id: string, workspaceId: string, enabled: boolean) => {
      setPluginEnabled(id, workspaceId, enabled);
      const bus = getPluginBus();
      bus.dispatch(enabled ? 'pluginEnabled' : 'pluginDisabled', { id, workspaceId });
      // service 联动（spec §5.3）：启用即起；禁用时仍被其他 workspace 启用则不停
      if (enabled) {
        const rec = getPluginRecord(id);
        if (rec) void startPluginService(rec).catch(() => undefined);
      } else {
        const stillEnabled = getDb()
          .prepare(
            `SELECT COUNT(*) AS n FROM workspaces w
             LEFT JOIN plugin_enablements e ON e.workspace_id = w.id AND e.plugin_id = ?
             WHERE e.enabled IS NULL OR e.enabled = 1`,
          )
          .get(id) as { n: number };
        if (stillEnabled.n === 0) void stopPluginService(id).catch(() => undefined);
      }
    },
  );

  ipcMain.handle('plugin:uninstall', async (_evt, id: string, keepData: boolean) => {
    uninstallPlugin(id, keepData);
  });

  ipcMain.handle('plugin:reload', async (_evt, id: string) => {
    return toSummary(await reloadPlugin(id));
  });
}
