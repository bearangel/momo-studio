// electron/src/main/plugin/service-manager.ts
//
// 插件 service 管理器（spec §5.3）：主进程长驻组件的 start/stop/handle。
// 加载走 createRequire 原生语义 + resolve 规范化缓存键（同 hook-sync——
// vitest transform 态 require 被拦截 + macOS realpath 差异，两坑均实测）。
// 崩溃隔离：handle 抛错原样 reject（调用方拿错误回包），实例保留可继续调用。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { logger } from '../logger';
import { readPluginConfigJson, sensitiveOverlaySync, normalizeConfigSchema } from './config-store';
import { resolvePluginsDir, resolvePluginDataDir } from '../paths';
import { getPlugin, isPluginEnabled } from './registry';
import { getDb } from '../storage/db';
import type { PluginRecord } from './types';

/** service 的 pluginCtx（与工具侧同形；刻意不含 callService——防递归，spec P3 边界）。
 *  工作空间维度 v1.1：multi 实例注入 workspace 上下文（spec §4.4 默认跟随依据） */
export interface PluginServiceCtx {
  getConfig(): Record<string, unknown>;
  getDataDir(): string;
  workspace?: { id: string; directoryPath: string };
  logger: {
    warn(msg: string, meta?: unknown): void;
    info(msg: string, meta?: unknown): void;
    error(msg: string, meta?: unknown): void;
  };
}

export interface PluginServiceInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  handle(method: string, params: unknown): Promise<unknown>;
}

const running = new Map<string, PluginServiceInstance>();

/** manifest config 是否含 workspace-scope 属性（决定多实例形态，spec §5.1） */
export function pluginUsesWorkspaceScope(rec: PluginRecord): boolean {
  try {
    const manifest = JSON.parse(rec.manifestJson) as { config?: unknown };
    if (typeof manifest.config !== 'object' || manifest.config === null) return false;
    const schema = normalizeConfigSchema(manifest.config);
    return Object.values(schema.properties).some((d) => d.scope === 'workspace');
  } catch {
    return false;
  }
}

/** running key：多实例插件 `pluginId@workspaceId`；纯 global 插件 pluginId（slug 无 @，split 安全） */
function serviceKey(pluginId: string, workspaceId: string | undefined, multi: boolean): string {
  return multi && workspaceId ? `${pluginId}@${workspaceId}` : pluginId;
}

function workspaceDirOf(workspaceId: string): string | null {
  try {
    const row = getDb()
      .prepare('SELECT directory_path FROM workspaces WHERE id = ?')
      .get(workspaceId) as { directory_path?: string } | undefined;
    return row?.directory_path ?? null;
  } catch {
    return null;
  }
}

/** 启动插件 service（manifest 有 components.service 才动作）。加载或 start() 任一
 * 失败 warn 返回 false（实例不落 running——不半活，spec §5.3）。
 * 工作空间维度 v1.1：multi 插件按 workspaceId 多实例；无 wsId 不动作（lazy 兜底） */
export async function startPluginService(rec: PluginRecord, workspaceId?: string): Promise<boolean> {
  const multi = pluginUsesWorkspaceScope(rec);
  if (multi && !workspaceId) return false;
  const key = serviceKey(rec.id, workspaceId, multi);
  if (running.has(key)) return true;
  let manifest: { components?: { service?: string } };
  try {
    manifest = JSON.parse(rec.manifestJson) as { components?: { service?: string } };
  } catch {
    return false;
  }
  const serviceRel = manifest.components?.service;
  if (typeof serviceRel !== 'string') return false;
  const root =
    rec.source === 'dev' && rec.sourcePath
      ? rec.sourcePath
      : path.join(resolvePluginsDir(), 'installed', rec.id, rec.version);
  const entry = path.resolve(root, serviceRel, 'index.js');
  if (!fs.existsSync(entry)) {
    logger.warn('插件 service 入口不存在', { pluginId: rec.id, entry });
    return false;
  }
  try {
    const nodeRequire = createRequire(path.join(root, '.plugin-require.js'));
    delete nodeRequire.cache[nodeRequire.resolve(entry)];
    const mod = nodeRequire(entry) as { createService?: (ctx: PluginServiceCtx) => unknown };
    if (typeof mod.createService !== 'function') {
      throw new Error('模块未导出 createService 函数');
    }
    const dataDir = resolvePluginDataDir(rec.id);
    const wsDir = multi && workspaceId ? workspaceDirOf(workspaceId) : null;
    const ctx: PluginServiceCtx = {
      getConfig: () => ({
        ...readPluginConfigJson(rec.id),
        ...(multi ? readPluginConfigJson(rec.id, workspaceId) : {}),
        ...sensitiveOverlaySync(rec.id),
      }),
      getDataDir: () => dataDir,
      ...(multi && workspaceId && wsDir ? { workspace: { id: workspaceId, directoryPath: wsDir } } : {}),
      logger: {
        warn: (msg, meta) => logger.warn(`[plugin:${rec.id}] ${msg}`, meta),
        info: (msg, meta) => logger.info(`[plugin:${rec.id}] ${msg}`, meta),
        error: (msg, meta) => logger.error(`[plugin:${rec.id}] ${msg}`, meta),
      },
    };
    const instance = mod.createService(ctx) as PluginServiceInstance;
    if (instance === null || typeof instance !== 'object') {
      throw new Error('createService 返回值不是对象');
    }
    try {
      await instance.start();
    } catch (err) {
      logger.warn('插件 service start 失败（实例不落注册表）', {
        pluginId: rec.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    running.set(key, instance);
    return true;
  } catch (err) {
    logger.warn('插件 service 加载失败（可重载重试）', {
      pluginId: rec.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** 停止并移除实例；stop 抛错吞日志（卸载/禁用不因插件错误受阻）。
 *  multi 插件默认停全部实例（精确 key 匹配：pluginId 或 pluginId@*——前缀碰撞免疫） */
export async function stopPluginService(
  pluginId: string,
  opts?: { onlyKey?: string },
): Promise<void> {
  if (opts?.onlyKey) {
    const instance = running.get(opts.onlyKey);
    if (!instance) return;
    running.delete(opts.onlyKey);
    try {
      await instance.stop();
    } catch (err) {
      logger.warn('插件 service stop 失败（已强制移除）', {
        pluginId: opts.onlyKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  const keys = [...running.keys()].filter((k) => k === pluginId || k.startsWith(`${pluginId}@`));
  for (const key of keys) {
    const instance = running.get(key);
    running.delete(key);
    try {
      await instance?.stop();
    } catch (err) {
      logger.warn('插件 service stop 失败（已强制移除）', {
        pluginId: key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** 工作区切换（workspace:switch 链路）：停非当前工作区的 multi 实例；单例不动（spec §5.2） */
export async function onWorkspaceSwitched(nextWorkspaceId: string | null): Promise<void> {
  const stale = [...running.keys()].filter((k) => k.includes('@') && k.split('@')[1] !== nextWorkspaceId);
  await Promise.allSettled(stale.map((key) => stopPluginService(key.split('@')[0]!, { onlyKey: key })));
}

/** 工作区删除链路：停该工作区全部 multi 实例 */
export async function stopAllWorkspaceInstances(workspaceId: string): Promise<void> {
  const keys = [...running.keys()].filter((k) => k.split('@')[1] === workspaceId);
  await Promise.allSettled(keys.map((key) => stopPluginService(key.split('@')[0]!, { onlyKey: key })));
}

/** RPC：无实例中文错误；multi 未启动按 wsId lazy start（失败原样抛，下次可重试）。
 *  lazy 门（§8.6 禁用即熄灭）：禁用插件的 service 不因调用复活——multi 查该工作区
 *  enablement，单例查任一工作区仍启用（与 setEnabled 联动同判定） */
function anyWorkspaceEnabled(pluginId: string): boolean {
  try {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM workspaces w
         LEFT JOIN plugin_enablements e ON e.workspace_id = w.id AND e.plugin_id = ?
         WHERE e.enabled IS NULL OR e.enabled = 1`,
      )
      .get(pluginId) as { n: number };
    return row.n > 0;
  } catch {
    return true; // 判定失败按启用处理（保守拉起——F1 复活场景不受损）
  }
}

export async function callPluginService(
  pluginId: string,
  method: string,
  params: unknown,
  workspaceId?: string,
): Promise<unknown> {
  const rec = getPlugin(pluginId);
  const multi = rec ? pluginUsesWorkspaceScope(rec) : false;
  const key = serviceKey(pluginId, workspaceId, multi);
  let instance = running.get(key) ?? (multi ? undefined : running.get(pluginId));
  if (!instance) {
    if (!rec) throw new Error(`插件 ${pluginId} 的 service 未运行`);
    const allowed = multi && workspaceId ? isPluginEnabled(pluginId, workspaceId) : anyWorkspaceEnabled(pluginId);
    if (!allowed) throw new Error(`插件 ${pluginId} 的 service 未运行`);
    const started = await startPluginService(rec, workspaceId);
    if (!started) throw new Error(`插件 ${pluginId} 的 service 未运行`);
    instance = running.get(key);
    if (!instance) throw new Error(`插件 ${pluginId} 的 service 未运行`);
  }
  return instance.handle(method, params);
}

export function isServiceRunning(pluginId: string): boolean {
  return [...running.keys()].some((k) => k === pluginId || k.startsWith(`${pluginId}@`));
}

/** app 退出钩：停全部实例（before-quit 调用） */
export async function stopAllPluginServices(): Promise<void> {
  await Promise.allSettled([...running.keys()].map((id) => stopPluginService(id)));
}
