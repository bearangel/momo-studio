// electron/src/main/agent/tools/plugin-tools.ts
//
// 子进程侧插件工具加载器（spec §4.1/§4.2）。纯 CJS require——electron 为 tsc
// 编译无 bundle，子进程按绝对路径加载原生可行；本模块不得 import electron。
// 降级语义：坏一个模块进 failures、不拖垮整批（spec §4.5）。
import path from 'node:path';
import { ALL_BUILTIN_TOOLS } from './catalog';
import type { ToolCatalogEntry } from './catalog-entry';
import type { ToolModule, ToolContext } from './types';
import type { PluginToolRef } from '../runtime-config';

export interface PluginToolCtx {
  getConfig(): Record<string, unknown>;
  getDataDir(): string;
  logger: { warn(msg: string, meta?: unknown): void; info(msg: string, meta?: unknown): void };
}

export interface PluginToolModule extends ToolModule {
  /** 审计溯源标记（executeToolModule 据此在 logToolCall 打 source:'plugin'） */
  pluginSource: 'plugin';
  pluginId: string;
}

export interface PluginToolLoadResult {
  modules: PluginToolModule[];
  failures: Array<{ pluginId: string; modulePath: string; error: string }>;
}

/** 合法插件工具短名：小写字母数字下划线连字符（不得自带命名空间） */
const SHORT_NAME_RE = /^[a-z][a-z0-9_-]*$/;

const BUILTIN_NAMES = new Set(ALL_BUILTIN_TOOLS);

export function loadPluginToolModules(
  refs: PluginToolRef[],
  log: (msg: string, meta?: unknown) => void,
): PluginToolLoadResult {
  const modules: PluginToolModule[] = [];
  const failures: PluginToolLoadResult['failures'] = [];
  for (const ref of refs) {
    for (const modulePath of ref.modulePaths) {
      try {
        // 无需 require 缓存失效：WarmPool 一 task 一进程（release=kill）
        const mod = require(modulePath) as {
          createTools?: (ctx: PluginToolCtx) => unknown;
        };
        if (typeof mod.createTools !== 'function') {
          throw new Error('模块未导出 createTools 函数');
        }
        const pluginCtx: PluginToolCtx = {
          getConfig: () => ref.config,
          getDataDir: () => ref.dataDir,
          logger: {
            warn: (msg, meta) => log(`[plugin:${ref.pluginId}] ${msg}`, meta),
            info: (msg, meta) => log(`[plugin:${ref.pluginId}] ${msg}`, meta),
          },
        };
        const created = mod.createTools(pluginCtx);
        if (created === null || typeof created !== 'object') {
          throw new Error('createTools 返回值不是对象');
        }
        const inner = created as ToolModule;
        const shortDefs = inner.getDefs().map((d) => ({ ...d }));
        // 命名空间强制（spec D5）：模块只准声明短名——自带 '/' 或 ':' 前缀 =
        // 跨插件/自设命名空间仿冒，整模块拒绝；短名恰为内置名同样拒绝
        // （强制前缀后虽不致碰撞，但污染目录且属社工面）
        if (
          shortDefs.some((d) => !SHORT_NAME_RE.test(d.name) || BUILTIN_NAMES.has(d.name))
        ) {
          throw new Error('getDefs 含非法名（自带命名空间前缀或与内置工具重名）');
        }
        const namespaced = shortDefs.map((d) => ({
          ...d,
          name: `plugin:${ref.pluginId}/${d.name}`,
        }));
        modules.push({
          pluginId: ref.pluginId,
          pluginSource: 'plugin',
          getDefs: () => namespaced,
          getCatalog: () => catalogFor(ref.pluginId, inner, namespaced),
          handles: (name) => inner.handles(stripPrefix(ref.pluginId, name)),
          execute: async (name, args, ctx: ToolContext) =>
            inner.execute(stripPrefix(ref.pluginId, name), args, ctx),
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        failures.push({ pluginId: ref.pluginId, modulePath: path.basename(modulePath), error });
        log(`插件工具模块加载失败`, { pluginId: ref.pluginId, modulePath, error });
      }
    }
  }
  return { modules, failures };
}

/** 插件目录条目：有则映射前缀+source，无则从 defs 派生最小目录（UI 可显示） */
function catalogFor(
  pluginId: string,
  inner: ToolModule,
  namespaced: Array<{ name: string; description: string }>,
): ToolCatalogEntry[] {
  const provided = inner.getCatalog?.() ?? [];
  if (provided.length > 0) {
    return provided.map((c) => ({
      ...c,
      name: `plugin:${pluginId}/${c.name}`,
      source: 'plugin' as const,
    }));
  }
  return namespaced.map((d) => ({
    name: d.name,
    displayName: d.name.split('/').pop() ?? d.name,
    description: d.description,
    category: `插件 ${pluginId}`,
    categoryEmoji: '',
    defaultOn: false,
    source: 'plugin' as const,
  }));
}

function stripPrefix(pluginId: string, name: string): string {
  const prefix = `plugin:${pluginId}/`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

export interface AssembledToolModules {
  modules: ToolModule[];
  failures: Array<{ pluginId: string; modulePath: string; error: string }>;
}

/** 审计溯源判定：命中的模块带 pluginSource 标记 → 'plugin'，否则 'builtin' */
export function toolSourceFor(name: string, modules: ToolModule[]): 'builtin' | 'plugin' {
  return modules.some((m) => m.handles(name) && (m as PluginToolModule).pluginSource === 'plugin')
    ? 'plugin'
    : 'builtin';
}

/**
 * runtime 注册中心组装（spec §4.3 治理等价）：内置在前、插件在后并入同一
 * ToolModule 列表——doExecuteTool 的 handles 路由与 per-call ToolContext
 * 注入对插件模块天然生效。loader failures 携带返回（启动日志观测面）。
 */
export function assembleToolModules(
  baseModules: ToolModule[],
  refs: PluginToolRef[],
  log: (msg: string, meta?: unknown) => void,
): AssembledToolModules {
  const { modules: pluginModules, failures } = loadPluginToolModules(refs, log);
  return { modules: [...baseModules, ...pluginModules], failures };
}
