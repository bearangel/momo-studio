// electron/src/main/mcp/template-expand.ts
//
// 引擎整合 T3（spec §4.3）：插件 MCP 模板 spawn 期展开。
// 注册期（mcp-sync）只存模板原文；本模块在 getOrStartMcp spawn 前按工作空间
// 展开为最终 command/args/env——per-ws 配置各自生效，同名 server 各 ws 各一进程
// （进程池 poolKey 已按 ws 分实例）。
//
// 占位符两类：
//   ${config.<KEY>}   插件 config 值（resolvePluginConfig per-ws 合并 + 敏感缓存）；
//                     workspaceRoot 特殊语义——留空 fallback 工作区 directoryPath
//                     （消灭「索引挂错」类配置错误的根）
//   ${engineBin}      插件引擎启动器绝对路径（vendor 解压产物，非 config 值）；
//                     文件探针缺失 → 明确报错（重装提示），不自愈下载
import path from 'node:path';
import fs from 'node:fs';
import type { McpServerConfig } from './types';
import { getDb } from '../storage/db';
import { listPlugins } from '../plugin/registry';
import { resolvePluginRoot } from '../plugin/assembly';
import { resolvePluginConfig, normalizeConfigSchema } from '../plugin/config-store';

export interface ExpandedMcpConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const PLACEHOLDER_RE = /\$\{([a-zA-Z][a-zA-Z0-9._]*)\}/g;

function hasPlaceholder(value: string): boolean {
  return value.includes('${');
}

/** 整条配置是否含占位符（getOrStartMcp 的展开触发判定） */
export function mcpConfigHasPlaceholder(config: McpServerConfig): boolean {
  return (
    hasPlaceholder(config.command) ||
    config.args.some(hasPlaceholder) ||
    Object.values(config.env ?? {}).some(hasPlaceholder)
  );
}

interface PluginRuntime {
  root: string;
  config: Record<string, unknown>;
}

/** 插件运行态（manifest schema + per-ws config）；记录缺失/损坏 → null（调用方拒启） */
async function loadPluginRuntime(pluginId: string, workspaceId: string): Promise<PluginRuntime | null> {
  const rec = listPlugins().find((r) => r.id === pluginId);
  if (!rec) return null;
  try {
    const manifest = JSON.parse(rec.manifestJson) as { config?: unknown };
    const schema = normalizeConfigSchema(manifest.config ?? { type: 'object', properties: {} });
    const config = await resolvePluginConfig(pluginId, schema, workspaceId);
    return { root: resolvePluginRoot(rec) ?? '', config };
  } catch {
    return null;
  }
}

/** 工作区目录（workspaceRoot 留空时的 fallback） */
function workspaceDirectory(workspaceId: string): string | null {
  const row = getDb()
    .prepare(`SELECT directory_path FROM workspaces WHERE id = ?`)
    .get(workspaceId) as { directory_path: string | null } | undefined;
  const dir = row?.directory_path;
  return typeof dir === 'string' && dir.trim() !== '' ? dir : null;
}

/** 引擎启动器：插件根下 engine/bin/codegraph（win32 为 .exe） */
function engineBinPath(pluginRoot: string): string {
  const bin = process.platform === 'win32' ? 'codegraph.exe' : 'codegraph';
  return path.join(pluginRoot, 'engine', 'bin', bin);
}

/** spawn 期展开。展开失败（缺值/缺引擎/插件记录缺失）一律 throw——错误可见。 */
export async function expandMcpTemplate(
  config: McpServerConfig,
  workspaceId: string,
): Promise<ExpandedMcpConfig> {
  // 无占位符（含非插件 source）→ 原样返回，不触插件/DB 面——存量 MCP 零影响
  if (!mcpConfigHasPlaceholder(config)) {
    return { command: config.command, args: config.args, env: config.env };
  }
  const runtime = await loadPluginRuntime(config.pluginId as string, workspaceId);
  if (!runtime) {
    throw new Error(`插件 MCP 展开失败：插件记录缺失或 manifest 损坏（${config.pluginId ?? '?'})`);
  }
  const wsDir = workspaceDirectory(workspaceId);

  const expandOne = (raw: string): string => {
    return raw.replace(PLACEHOLDER_RE, (whole, name: string) => {
      if (name === 'engineBin') {
        const bin = engineBinPath(runtime.root);
        if (!fs.existsSync(bin)) {
          throw new Error(
            `插件引擎缺失（${bin}）——请在资源库重装该插件恢复引擎，或重新解压 engine 目录`,
          );
        }
        return bin;
      }
      if (!name.startsWith('config.')) {
        throw new Error(`MCP 模板占位符不支持: ${whole}（仅支持 ${config.pluginId} 的 config.* 与 ${'${engineBin}'}）`);
      }
      const key = name.slice('config.'.length);
      const value = runtime.config[key];
      if (value === undefined || value === null || String(value).trim() === '') {
        // workspaceRoot 特殊语义：留空 = 跟随工作区目录（spec §4.3）
        if (key === 'workspaceRoot') {
          if (wsDir) return wsDir;
          throw new Error(
            `config.workspaceRoot 留空且工作区未设置目录——无法确定索引根，请在插件配置中显式指定`,
          );
        }
        throw new Error(`MCP 模板占位符 ${whole} 无值（插件 config 未声明或未配置该键）`);
      }
      return String(value);
    });
  };

  const command = expandOne(config.command);
  if (command.trim() === '') {
    throw new Error(`MCP 模板展开后 command 为空（插件 ${config.pluginId}）`);
  }
  const args = config.args.map(expandOne);
  const env = config.env
    ? (Object.fromEntries(
        Object.entries(config.env).map(([k, v]) => [k, expandOne(v)] as const),
      ) as Record<string, string>)
    : undefined;
  return { command, args, env };
}
