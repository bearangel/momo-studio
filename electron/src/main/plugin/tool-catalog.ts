// electron/src/main/plugin/tool-catalog.ts
//
// 插件工具目录（工作空间维度 v1.1 spec §7.3）：主进程实例化启用插件的工具模块，
// 取静态 name/description 供 agent 配置 UI 渲染。装了即信模型下主进程持模块与
// service 同权限级；坏模块跳过不拖垮（P1 resources 同款降级）。
// 无显式缓存——createRequire 进程级缓存天然去重，DefinitionEditor 打开频度下成本可忽略。
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildPluginToolRefs } from './assembly';
import { listPlugins } from './registry';
import type { PluginToolCtx } from '../agent/tools/plugin-tools';

/** renderer 消费形状（跨 IPC 纯数据；renderer types.d.ts 同形定义） */
export interface PluginToolInfo {
  pluginId: string;
  pluginName: string;
  toolName: string;
  /** 全限定名 = plugin:<id>/<短名>（deniedTools 精确名即用此形态） */
  fullName: string;
  description: string;
}

/** 目录探测专用桩 ctx：配置空、service 拒绝——插件不得在 getDefs 阶段产生副作用依赖 */
const STUB_CTX: PluginToolCtx = {
  getConfig: () => ({}),
  getDataDir: () => '',
  logger: { warn: () => undefined, info: () => undefined },
  callService: () => Promise.reject(new Error('工具目录探测不可调用 service')),
};

/** 当前工作区装配的插件工具清单（enabled 过滤沿用 buildPluginToolRefs 装配面） */
export function listAssembledToolDefs(workspaceId: string): PluginToolInfo[] {
  const nameByPlugin = new Map<string, string>();
  for (const rec of listPlugins()) {
    try {
      nameByPlugin.set(rec.id, (JSON.parse(rec.manifestJson) as { name?: string }).name ?? rec.id);
    } catch {
      nameByPlugin.set(rec.id, rec.id);
    }
  }
  const out: PluginToolInfo[] = [];
  for (const ref of buildPluginToolRefs(workspaceId)) {
    for (const modulePath of ref.modulePaths) {
      try {
        const nodeRequire = createRequire(path.join(ref.rootDir, '.plugin-require.js'));
        const mod = nodeRequire(modulePath) as {
          createTools?: (ctx: PluginToolCtx) => { getDefs?: () => Array<{ name?: unknown; description?: unknown }> };
        };
        if (typeof mod.createTools !== 'function') continue;
        const instance = mod.createTools(STUB_CTX);
        if (typeof instance?.getDefs !== 'function') continue;
        for (const d of instance.getDefs()) {
          if (typeof d?.name !== 'string' || typeof d?.description !== 'string') continue;
          out.push({
            pluginId: ref.pluginId,
            pluginName: nameByPlugin.get(ref.pluginId) ?? ref.pluginId,
            toolName: d.name,
            fullName: `plugin:${ref.pluginId}/${d.name}`,
            description: d.description,
          });
        }
      } catch {
        // 单模块坏（语法错/抛错）跳过——目录是 UI 数据源，不因插件缺陷挂死配置页
      }
    }
  }
  return out;
}
