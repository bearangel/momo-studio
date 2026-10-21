// electron/src/main/plugin/resources.ts
//
// 插件注册表行 → ResourceItem 映射（资源库第四类型页数据源，spec §8.1）。
// manifest_json 损坏时降级为最小元数据行——坏一行不崩整张列表。
import { buildResourceId, type ResourceItem } from '../resource/types';
import { listPlugins, isPluginEnabled } from './registry';
import type { PluginManifest } from './types';

export function listPluginResourceRows(workspaceId?: string): ResourceItem[] {
  return listPlugins().map((rec) => {
    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(rec.manifestJson) as PluginManifest;
    } catch {
      manifest = {
        id: rec.id,
        name: rec.id,
        version: rec.version,
        description: '',
        components: {},
      };
    }
    return {
      id: buildResourceId('custom', 'plugin', rec.id),
      type: 'plugin' as const,
      source: 'custom' as const,
      slug: rec.id,
      name: manifest.name,
      description: manifest.description,
      version: rec.version,
      installed: true,
      installable: false,
      removable: true,
      plugin: {
        id: rec.id,
        state: rec.state,
        devSource: rec.source === 'dev',
        sourcePath: rec.sourcePath,
        components: Object.keys(manifest.components ?? {}),
        enabled: workspaceId ? isPluginEnabled(rec.id, workspaceId) : true, // 无 ws 上下文按启用展示（管理面恒传 wsId）
      },
    };
  });
}
