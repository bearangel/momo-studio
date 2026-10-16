// electron/src/main/plugin/boot.ts
//
// 启动再激活（spec §5.3/§3.3）：hooks 订阅与 service 实例是纯内存态——
// install/reload/setEnabled 时建立，app 重启后须按 DB 持久态（plugins 表）
// 重建。listPlugins() 的 ORDER BY id 迭代顺带固化 waterfall 注册序的
// 跨重启确定性（审查 C1）。
import { listPlugins } from './registry';
import { syncPluginHooks } from './hook-sync';
import { startPluginService } from './service-manager';
import { getPluginBus } from './bus-instance';
import { logger } from '../logger';

export async function reactivatePluginsOnBoot(): Promise<void> {
  const bus = getPluginBus();
  for (const rec of listPlugins()) {
    try {
      syncPluginHooks(rec, bus);
    } catch (err) {
      logger.warn('boot：hooks 再激活失败', {
        pluginId: rec.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      void (await startPluginService(rec));
    } catch {
      // startPluginService 内部已 warn；此处仅防意外外泄
    }
  }
}
