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
import { validatePanelsAtRoot, notifyPanelsChanged } from './panel-sync';
import { getDb } from '../storage/db';
import { invalidateMcpByName } from '../mcp/host-manager';
import type { PluginRecord } from './types';

/** 重载插件：manifest 刷新 + 组件重激活 + 受影响 workspace 的 runtime 重建 */
export async function reloadPlugin(id: string): Promise<PluginRecord> {
  const rec = getPlugin(id);
  if (!rec) throw new Error(`插件不存在: ${id}`);
  const root = resolvePluginRoot(rec);
  if (root === null) throw new Error(`插件目录不可用（missing 态）: ${id}`);

  const manifest = parseManifest(fs.readFileSync(path.join(root, 'momo-plugin.json'), 'utf-8'));
  validateManifest(manifest, root);
  // P4：面板契约重载校验——失败仅面板下线 + warn，不炸重载（D2 裁定）
  try {
    validatePanelsAtRoot(root, manifest, id);
  } catch (err) {
    logger.warn('reload：面板契约校验失败（面板下线）', { pluginId: id, error: String(err) });
  }
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
  notifyPanelsChanged();
  return refreshed;
}

/** 单 workspace 重建：lastRunning 成员全部 stop →（可选）MCP 池失效 → 全部 start（新 opts）。
 *  reload（全启用 ws）与 setEnabled（目标 ws，spec 2026-10-21 §7）共用。
 *  两阶段语义（终审 I-2 修复，spec §7.2）：停用清池必须落在全部 stop 之后、首个 start
 *  之前——旧 runtime 停机后无人能以其快照发起调用，此时失效池才不会按需复活 */
export async function rebuildWorkspaceRuntimes(
  pluginId: string,
  workspaceId: string,
  opts: { invalidateMcpNames?: string[] } = {},
): Promise<void> {
  const ws = getDb()
    .prepare(`SELECT id, directory_path FROM workspaces WHERE id = ?`)
    .get(workspaceId) as { id: string; directory_path: string } | undefined;
  if (!ws) return;
  const members = listMembers(ws.id).filter((m) => m.lastRunning);
  const startArgs: Array<{ instanceId: string; agentUserId: string; def: NonNullable<ReturnType<typeof getAgentDefinition>>; apiKey: string }> = [];
  for (const member of members) {
    const def = getAgentDefinition(member.agentDefinitionId);
    if (!def || !def.modelProviderId) continue;
    try {
      const apiKey = await resolveApiKey(member.instanceId, def.modelProviderId);
      await stopAgentRuntime(member.instanceId);
      startArgs.push({ instanceId: member.instanceId, agentUserId: member.agentUserId, def, apiKey });
    } catch (err) {
      logger.warn('runtime 重建失败（下一 spawn 用新装配兜底）', {
        pluginId,
        instanceId: member.instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (opts.invalidateMcpNames) {
    for (const name of opts.invalidateMcpNames) invalidateMcpByName(name);
  }
  for (const a of startArgs) {
    try {
      await startAgentRuntime(
        await buildSpawnOpts({
          instanceId: a.instanceId,
          agentUserId: a.agentUserId,
          workspaceId: ws.id,
          workspaceDir: ws.directory_path,
          def: a.def,
          llmApiKey: a.apiKey,
        }),
      );
    } catch (err) {
      logger.warn('runtime 重建失败（下一 spawn 用新装配兜底）', {
        pluginId,
        instanceId: a.instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** 启用了该插件的 workspace：逐 ws 重建（reload 语义不变） */
async function rebuildAffectedRuntimes(pluginId: string): Promise<void> {
  const workspaces = getDb()
    .prepare(`SELECT id FROM workspaces`)
    .all() as Array<{ id: string }>;
  for (const { id } of workspaces) {
    if (!isPluginEnabled(pluginId, id)) continue;
    await rebuildWorkspaceRuntimes(pluginId, id);
  }
}
