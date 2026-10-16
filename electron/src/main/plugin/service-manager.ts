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
import { resolvePluginsDir, resolvePluginDataDir } from '../paths';
import type { PluginRecord } from './types';

/** service 的 pluginCtx（与工具侧同形；刻意不含 callService——防递归，spec P3 边界） */
export interface PluginServiceCtx {
  getConfig(): Record<string, unknown>;
  getDataDir(): string;
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

function readConfig(dataDir: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf-8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 启动插件 service（manifest 有 components.service 才动作）。加载或 start() 任一
 * 失败 warn 返回 false（实例不落 running——不半活，spec §5.3） */
export async function startPluginService(rec: PluginRecord): Promise<boolean> {
  if (running.has(rec.id)) return true;
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
    const ctx: PluginServiceCtx = {
      getConfig: () => readConfig(dataDir),
      getDataDir: () => dataDir,
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
    running.set(rec.id, instance);
    return true;
  } catch (err) {
    logger.warn('插件 service 加载失败（可重载重试）', {
      pluginId: rec.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** 停止并移除实例；stop 抛错吞日志（卸载/禁用不因插件错误受阻） */
export async function stopPluginService(pluginId: string): Promise<void> {
  const instance = running.get(pluginId);
  if (!instance) return;
  running.delete(pluginId);
  try {
    await instance.stop();
  } catch (err) {
    logger.warn('插件 service stop 失败（已强制移除）', {
      pluginId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** RPC：无实例中文错误；handle 抛错原样 reject（调用方拿错误结果） */
export async function callPluginService(
  pluginId: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  const instance = running.get(pluginId);
  if (!instance) {
    throw new Error(`插件 ${pluginId} 的 service 未运行`);
  }
  return instance.handle(method, params);
}

export function isServiceRunning(pluginId: string): boolean {
  return running.has(pluginId);
}

/** app 退出钩：停全部实例（before-quit 调用） */
export async function stopAllPluginServices(): Promise<void> {
  await Promise.allSettled([...running.keys()].map((id) => stopPluginService(id)));
}
