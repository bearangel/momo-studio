// electron/src/main/resource/custom.ts
//
// listCustomResources：合并三类用户自定义上传资源。
//   - MCP：mcp_definitions 表 source='custom'（来自 host-manager.listRegistered 过滤）
//   - Skill：<userData>/skills/ 下有 .sha256 标记的目录（来自 zip-uploader.listInstalled 过滤）
//   - Agent：agent_definitions 表 source='custom'（来自 crud.listAgentDefinitions 过滤）
//
// 三类底层 list 函数都是同步 + 纯 DB/fs 读，本函数也同步。
// 所有 custom 项统一 installed=true / installable=false / removable=true。

import { listRegistered } from '../mcp/host-manager';
import { listInstalled as listInstalledSkills } from '../skill/zip-uploader';
import { listAgentDefinitions } from '../agent/crud';
import { buildResourceId, type ResourceItem } from './types';
import crypto from 'node:crypto';

/**
 * 把 agent systemPrompt 做 SHA256 截断（前 16 字符）。
 * 用于 ResourceItem.custom.agentSystemPromptHash——给前端展示 prompt 指纹，
 * 不暴露 prompt 全文（prompt 可能含敏感信息）。
 */
function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

/**
 * 列出所有用户自定义上传的资源（合并 mcp + skill + agent 三类）。
 *
 * 每类底层 list 函数返回的 source 字段做白名单过滤（仅保留 'custom'）：
 *   - mcp：RegisteredMcp.source（'marketplace' | 'custom'）
 *   - skill：InstalledSkill.source（'builtin' | 'marketplace' | 'custom'）
 *   - agent：AgentDefinition.source（'builtin' | 'custom' | 'marketplace'）
 *
 * agent 用 def.id（UUID）作为 slug 部分——def.slug 可能重名，UUID 保证 id 唯一。
 *
 * @returns ResourceItem[]，每项 source='custom'
 */
export function listCustomResources(): ResourceItem[] {
  const result: ResourceItem[] = [];

  // 1. MCP：自定义注册的 MCP server（source='custom'，非 marketplace 安装）
  for (const mcp of listRegistered().filter((m) => m.source === 'custom')) {
    result.push({
      id: buildResourceId('custom', 'mcp', mcp.name),
      type: 'mcp',
      source: 'custom',
      slug: mcp.name,
      name: mcp.name,
      description: `自定义 MCP（${mcp.command}）`,
      version: mcp.version,
      installed: true,
      installable: false,
      removable: true,
      custom: {
        installedAt: mcp.installedAt,
        mcpConfig: { command: mcp.command, args: mcp.args, env: mcp.env },
      },
    });
  }

  // 2. Skill：用户 zip 上传的 skill（source='custom'，有 .sha256 标记）
  for (const skill of listInstalledSkills().filter((s) => s.source === 'custom')) {
    result.push({
      id: buildResourceId('custom', 'skill', skill.slug),
      type: 'skill',
      source: 'custom',
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      installed: true,
      installable: false,
      removable: true,
      custom: {
        installedAt: skill.installedAt ?? new Date().toISOString(),
      },
    });
  }

  // 3. Agent：用户自定义创建的 agent 定义（source='custom'）
  // def.id 是 UUID（v1.3 重构后），作为 slug 部分——def.slug 可能重名，UUID 保证唯一
  for (const def of listAgentDefinitions().filter((d) => d.source === 'custom')) {
    result.push({
      id: buildResourceId('custom', 'agent', def.id),
      type: 'agent',
      source: 'custom',
      slug: def.id,
      name: def.name,
      description: def.description,
      iconEmoji: def.iconEmoji,
      version: def.version,
      installed: true,
      installable: false,
      removable: true,
      custom: {
        installedAt: def.createdAt ?? new Date().toISOString(),
        agentSystemPromptHash: hashPrompt(def.systemPrompt),
      },
    });
  }

  return result;
}
