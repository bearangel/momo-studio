import { invalidateMcpByName } from '../mcp/host-manager';
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
import { syncPluginHooks, removePluginHooks } from './hook-sync';
import { notifyPanelsChanged, listPluginPanels } from './panel-sync';
import { callPluginService } from './service-manager';
import {
  normalizeConfigSchema,
  writePluginConfig,
  getPluginConfigView,
  warmPluginConfigCache,
  type NormalizedConfigSchema,
} from './config-store';
import { syncPluginMcps } from './mcp-sync';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { reloadPlugin, rebuildWorkspaceRuntimes } from './reload';
import { getActiveWorkspaceId } from '../workspace/ipc.handlers';
import { listAssembledToolDefs } from './tool-catalog';
import { getPluginDetail } from './inventory';
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
 * 通道清单：installZip / installDevDir / setEnabled / uninstall / reload（P2）
 *  + listPanels / callService / getConfig / setConfig（P4，spec §6）。
 */
export function registerPluginHandlers(): void {
  ipcMain.handle(
    'plugin:installZip',
    async (_evt, data: Uint8Array, _filename: string, workspaceId?: string) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      // 安装作用域（spec 2026-10-21 §5）：renderer 显式传 ws；缺省取活动工作区
      return toSummary(await installPluginZip(buf, app.getVersion(), workspaceId ?? getActiveWorkspaceId() ?? ''));
    },
  );

  ipcMain.handle('plugin:installDevDir', (_evt, dir: string, workspaceId?: string) => {
    return toSummary(installPluginDevDir(dir, app.getVersion(), workspaceId ?? getActiveWorkspaceId() ?? ''));
  });

  ipcMain.handle(
    'plugin:setEnabled',
    async (_evt, id: string, workspaceId: string, enabled: boolean) => {
      setPluginEnabled(id, workspaceId, enabled);
      const bus = getPluginBus();
      bus.dispatch(enabled ? 'pluginEnabled' : 'pluginDisabled', { id, workspaceId });
      notifyPanelsChanged(); // 面板可见性随启停变化（§8.6）
      // 摘/挂钩（审查 C2）：禁用即失效——hooks 订阅跟随 enablement；
      // 机器级单例语义：任一 workspace 仍启用则保留订阅（与 service 联动同判定）
      const rec = getPluginRecord(id);
      if (rec) {
        if (enabled) {
          try {
            syncPluginHooks(rec, bus);
          } catch {
            // 挂钩失败可重载重试
          }
        } else {
          const stillEnabled = getDb()
            .prepare(`SELECT COUNT(*) AS n FROM plugin_enablements WHERE plugin_id = ? AND enabled = 1`)
            .get(id) as { n: number };
          if (stillEnabled.n === 0) removePluginHooks(id, bus);
        }
      }
      // service 联动（spec §5.3）：启用即起（目标=活动工作区——multi 语义，无活动 ws
      // 则跳过由 lazy 兜底）；禁用时仍被其他 workspace 启用则不停
      if (enabled) {
        const rec = getPluginRecord(id);
        if (rec) void startPluginService(rec, getActiveWorkspaceId() ?? undefined).catch(() => undefined);
      } else {
        const stillEnabled = getDb()
          .prepare(`SELECT COUNT(*) AS n FROM plugin_enablements WHERE plugin_id = ? AND enabled = 1`)
          .get(id) as { n: number };
        if (stillEnabled.n === 0) void stopPluginService(id).catch(() => undefined);
      }
      // 启停即时生效（spec 2026-10-21 §7）：双向重建该 ws 在线成员（停用=能力立即
      // 摘除；启用=授权面立即生效）。停用方向在重建的两阶段间隙（全部 stop 之后、
      // start 之前）失效该插件 MCP 池——旧 runtime 已停机，失效不会被按需复活
      // （§3.3 冻结语义收窄至配置变更；终审 I-2 修复）
      const invalidateNames = enabled
        ? undefined
        : (
            getDb()
              .prepare(`SELECT name FROM mcp_definitions WHERE plugin_id = ?`)
              .all(id) as Array<{ name: string }>
          ).map((r) => r.name);
      void rebuildWorkspaceRuntimes(id, workspaceId, { invalidateMcpNames: invalidateNames }).catch((err) =>
        logger.warn('启停运行时重建失败（下一 spawn 新装配兜底）', {
          pluginId: id,
          error: String(err),
        }),
      );
    },
  );

  ipcMain.handle('plugin:uninstall', async (_evt, id: string, keepData: boolean) => {
    uninstallPlugin(id, keepData);
  });

  ipcMain.handle('plugin:reload', async (_evt, id: string) => {
    return toSummary(await reloadPlugin(id));
  });

  // 组件明细清单（spec 2026-10-21 §9②）：只读七面
  ipcMain.handle('plugin:getDetail', (_evt, pluginId: string, workspaceId?: string) =>
    getPluginDetail(pluginId, workspaceId),
  );

  // ── P4：面板与 config 面（spec §6） ──

  ipcMain.handle('plugin:listPanels', (_evt, workspaceId: string) => listPluginPanels(workspaceId));

  // 工作空间维度 v1.1（spec §7.3）：agent 配置 UI 的插件工具清单（装配面派生）
  ipcMain.handle('plugin:listAssembledTools', (_evt, workspaceId: string) =>
    listAssembledToolDefs(workspaceId),
  );

  // 面板 RPC 透传：pluginId 来自调用方（PanelHost 构造绑定），消息面不带身份。
  // workspaceId（工作空间维度 v1.1）：multi 插件按工作区路由 + lazy 拉起（spec §5.2）
  ipcMain.handle(
    'plugin:callService',
    (_evt, pluginId: string, method: string, params: unknown, workspaceId?: string) =>
      callPluginService(pluginId, method, params ?? null, workspaceId),
  );

  /** manifest config 归一（无 config 声明返回 null——renderer 显空态） */
  function normalizedSchemaOf(rec: PluginRecord): NormalizedConfigSchema | null {
    const manifest = JSON.parse(rec.manifestJson) as PluginManifest;
    if (!manifest.config) return null;
    return normalizeConfigSchema(manifest.config);
  }

  ipcMain.handle('plugin:getConfig', async (_evt, pluginId: string, workspaceId?: string) => {
    const rec = getPluginRecord(pluginId);
    if (!rec) throw new Error(`插件不存在: ${pluginId}`);
    const schema = normalizedSchemaOf(rec);
    if (!schema) return null;
    // C1 修复：先预热敏感缓存（boot 预热被错过时的兜底——在场判定只看缓存）
    await warmPluginConfigCache(pluginId, schema).catch(() => undefined);
    const view = getPluginConfigView(pluginId, schema, workspaceId);
    return {
      schema,
      values: view.values,
      sensitiveConfigured: view.sensitiveConfigured,
      scopes: view.scopes,
    };
  });

  /** 保存即生效（spec §3.3）：写双轨（workspaceId 给定时 workspace 层落该工作区文件）→
   * MCP 重装配（${config.KEY} 注入）→ service 重启（multi 插件重启目标 = 写入的
   * workspaceId 或活动工作区；无活动 ws 时跳过 start，lazy 兜底） */
  ipcMain.handle(
    'plugin:setConfig',
    async (
      _evt,
      pluginId: string,
      values: Record<string, string | number | boolean | null>,
      workspaceId?: string,
    ) => {
      const rec = getPluginRecord(pluginId);
      if (!rec) throw new Error(`插件不存在: ${pluginId}`);
      const schema = normalizedSchemaOf(rec);
      if (!schema) throw new Error(`此插件未声明配置项: ${pluginId}`);
      await writePluginConfig(pluginId, schema, values, workspaceId);
      try {
        // 模板态插件 MCP：配置变更 → 展开参数变 → 失效该插件全部 server 池实例
        // （下次调用按新参数重拉，杜绝 stale root/旧 token 复用）
        for (const name of syncPluginMcps(rec)) {
          invalidateMcpByName(name);
        }
      } catch (err) {
        logger.warn('setConfig 后 MCP 重装配失败', { pluginId, error: String(err) });
      }
      // service 重启语义（P5 §8.2 真机发现 + 审查 I2 + 工作空间维度 v1.1）：
      // 无条件 stop（multi=全部实例），start 须 gate on enablement——注册期缺配置的
      // 插件补配置后复活（F1）；全 workspace 禁用的插件保持熄灭（§8.6）
      const stillEnabled = (() => {
        try {
          const row = getDb()
            .prepare(`SELECT COUNT(*) AS n FROM plugin_enablements WHERE plugin_id = ? AND enabled = 1`)
            .get(pluginId) as { n: number };
          return row.n > 0;
        } catch {
          return true; // 判定失败按启用处理（保守拉起——F1 场景不受损）
        }
      })();
      const restartTarget = workspaceId ?? getActiveWorkspaceId() ?? undefined;
      void stopPluginService(pluginId)
        .catch(() => undefined)
        .then(() => (stillEnabled ? startPluginService(rec, restartTarget) : Promise.resolve(false)))
        .catch(() => undefined);
      // 回包完整 PluginConfigView（schema 必带——renderer 表单保存后原地重渲染）
      return { schema, ...getPluginConfigView(pluginId, schema, workspaceId) };
    },
  );
}
