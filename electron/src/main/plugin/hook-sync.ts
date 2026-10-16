// electron/src/main/plugin/hook-sync.ts
//
// hooks.json 主进程加载（spec §5.2）：解析 → 逐条失效 require cache 后 require
// handler 模块 → 校验导出 handle 函数 → HookBus.register。坏条目逐条 warn
// 跳过（fail-open）；注册时注入 pluginCtx（config/dataDir/logger）。
// 长驻主进程的缓存失效是 reload 语义的前置条件（P2 子进程一 task 一进程无此面）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { logger } from '../logger';
import { resolvePluginsDir, resolvePluginDataDir } from '../paths';
import { HookBus, type PluginHookCtx, type PluginHookEvent, PLUGIN_HOOK_EVENTS } from './hook-bus';
import type { PluginRecord } from './types';

interface HooksFileShape {
  hooks?: Partial<Record<PluginHookEvent, Array<{ module?: unknown; matcher?: unknown }>>>;
}

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

export function syncPluginHooks(
  rec: PluginRecord,
  bus: HookBus,
): { registered: number } {
  const registered = { count: 0 };
  const root =
    rec.source === 'dev' && rec.sourcePath
      ? rec.sourcePath
      : path.join(resolvePluginsDir(), 'installed', rec.id, rec.version);
  if (!fs.existsSync(root)) return { registered: 0 };

  let manifest: { components?: { hooks?: string } };
  try {
    manifest = JSON.parse(rec.manifestJson) as { components?: { hooks?: string } };
  } catch {
    return { registered: 0 };
  }
  const hooksRel = manifest.components?.hooks;
  if (typeof hooksRel !== 'string') return { registered: 0 };
  const hooksFile = path.resolve(root, hooksRel);

  let parsed: HooksFileShape;
  try {
    parsed = JSON.parse(fs.readFileSync(hooksFile, 'utf-8')) as HooksFileShape;
  } catch (err) {
    logger.warn('插件 hooks.json 读取/解析失败（已跳过）', {
      pluginId: rec.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { registered: 0 };
  }

  const dataDir = resolvePluginDataDir(rec.id);
  const pluginCtx: PluginHookCtx = {
    getConfig: () => readConfig(dataDir),
    getDataDir: () => dataDir,
    logger: {
      warn: (msg, meta) => logger.warn(`[plugin:${rec.id}] ${msg}`, meta),
      info: (msg, meta) => logger.info(`[plugin:${rec.id}] ${msg}`, meta),
      error: (msg, meta) => logger.error(`[plugin:${rec.id}] ${msg}`, meta),
    },
  };

  for (const [event, entries] of Object.entries(parsed.hooks ?? {})) {
    if (!PLUGIN_HOOK_EVENTS.includes(event as PluginHookEvent)) continue;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry?.module !== 'string') {
        logger.warn('插件 hook 条目缺 module（已跳过）', { pluginId: rec.id, event });
        continue;
      }
      const modulePath = path.resolve(path.dirname(hooksFile), entry.module);
      // 路径防御：module 相对路径解析后必须落在插件根内（manifest 校验同款防线）
      if (!modulePath.startsWith(root + path.sep)) {
        logger.warn('插件 hook module 路径越界（已跳过）', { pluginId: rec.id, module: entry.module });
        continue;
      }
      try {
        // 长驻进程缓存失效：reload/重启用新代码（Review Focus #4）。
        // createRequire 走 Node 原生 require——vitest 的 transform 态 require
        // 被 vite-node 拦截、其缓存不受 require.cache 删除影响（实测）
        const nodeRequire = createRequire(path.join(root, '.plugin-require.js'));
        // 缓存键必须用 require.resolve 的规范化路径（macOS /var ↔ /private/var
        // realpath 差异——裸 modulePath 字符串删不到真实缓存键，实测）
        delete nodeRequire.cache[nodeRequire.resolve(modulePath)];
        const mod = nodeRequire(modulePath) as { handle?: unknown };
        if (typeof mod.handle !== 'function') {
          throw new Error('模块未导出 handle 函数');
        }
        bus.register({
          pluginId: rec.id,
          event: event as PluginHookEvent,
          matcher: typeof entry.matcher === 'string' ? entry.matcher : undefined,
          modulePath,
          handler: mod.handle,
          pluginCtx,
        });
        registered.count += 1;
      } catch (err) {
        logger.warn('插件 hook 模块加载失败（已跳过）', {
          pluginId: rec.id,
          event,
          module: entry.module,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { registered: registered.count };
}

export function removePluginHooks(pluginId: string, bus: HookBus): void {
  bus.unregisterPlugin(pluginId);
}
