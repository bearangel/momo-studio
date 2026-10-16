// electron/src/main/plugin/reload.ts
//
// plugin:reload 语义（spec §3.3）：重读 manifest（dev 直读源目录 / zip 重验
// 安装目录）→ registry upsert → 声明式组件重激活 → 受影响 workspace 的
// runtime stop→start 重建（WarmPool 一 task 一进程，真失效面 = spawn 闭包
// 旧 opts——重建链即失效原语，镜像 init-runtime 的成员遍历装配）。
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';
import { listMembers, getAgentDefinition } from '../agent/crud';
import { buildSpawnOpts, resolveApiKey } from '../agent/spawn-helpers';
import { stopAgentRuntime, startAgentRuntime } from '../agent/runtime-registry';
import { getPlugin, upsertPlugin, isPluginEnabled } from './registry';
import { registerPluginAgents } from './agent-sync';
import { syncPluginMcps } from './mcp-sync';
import { syncPluginHooks, removePluginHooks } from './hook-sync';
import { startPluginService, stopPluginService } from './service-manager';
import { getPluginBus } from './bus-instance';
import { resolvePluginRoot } from './assembly';
import { parseManifest, validateManifest } from './manifest';
import { getDb } from '../storage/db';
import type { PluginRecord } from './types';

/** 重载插件：manifest 刷新 + 组件重激活 + 受影响 workspace 的 runtime 重建 */
export async function reloadPlugin(id: string): Promise<PluginRecord> {
  const rec = getPlugin(id);
  if (!rec) throw new Error(`插件不存在: ${id}`);
  const root = resolvePluginRoot(rec);
  if (root === null) throw new Error(`插件目录不可用（missing 态）: ${id}`);

  const manifest = parseManifest(fs.readFileSync(path.join(root, 'momo-plugin.json'), 'utf-8'));
  validateManifest(manifest, root);
  const refreshed: PluginRecord = { ...rec, version: manifest.version, manifestJson: JSON.stringify(manifest), state: 'active' };
  upsertPlugin(refreshed);

  try {
    removePluginHooks(id, getPluginBus());
  } catch {
    // 注销失败不阻断——后续 register 同 pluginId 同 modulePath 会覆盖
  }
  try {
    syncPluginHooks(refreshed, getPluginBus());
  } catch (err) {
    logger.warn('reload：hooks 重激活失败', { pluginId: id, error: String(err) });
  }
  try {
    await stopPluginService(id);
    const started = await startPluginService(refreshed);
    if (!started) {
      logger.warn('reload：service 重启失败（可再次重载重试）', { pluginId: id });
    }
  } catch (err) {
    logger.warn('reload：service 重启异常', {
      pluginId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    registerPluginAgents(refreshed);
  } catch (err) {
    logger.warn('reload：agents 重激活失败', { pluginId: id, error: String(err) });
  }
  try {
    syncPluginMcps(refreshed);
  } catch (err) {
    logger.warn('reload：MCP 重激活失败', { pluginId: id, error: String(err) });
  }

  await rebuildAffectedRuntimes(id);
  return refreshed;
}

/** 启用了该插件的 workspace：其 lastRunning 成员的 runtime stop→start（新 opts） */
async function rebuildAffectedRuntimes(pluginId: string): Promise<void> {
  const db = getDb();
  const workspaces = db
    .prepare(`SELECT id, directory_path FROM workspaces`)
    .all() as Array<{ id: string; directory_path: string }>;
  for (const ws of workspaces) {
    if (!isPluginEnabled(pluginId, ws.id)) continue;
    for (const member of listMembers(ws.id)) {
      if (!member.lastRunning) continue;
      const def = getAgentDefinition(member.agentDefinitionId);
      if (!def || !def.modelProviderId) continue;
      try {
        const llmApiKey = await resolveApiKey(member.instanceId, def.modelProviderId);
        await stopAgentRuntime(member.instanceId);
        await startAgentRuntime(
          await buildSpawnOpts({
            instanceId: member.instanceId,
            agentUserId: member.agentUserId,
            workspaceId: ws.id,
            workspaceDir: ws.directory_path,
            def,
            llmApiKey,
          }),
        );
      } catch (err) {
        logger.warn('reload：runtime 重建失败（下一 spawn 用新装配兜底）', {
          pluginId,
          instanceId: member.instanceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
