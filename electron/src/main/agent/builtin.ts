// electron/src/main/agent/builtin.ts
//
// 把 resources/agents/*.yaml 解析为 AgentDefinition 并幂等写入 SQLite。
//
// ⚠️ 自 v1.1 起启动流程不再调用 registerBuiltinAgents()——内置 agent 改为通过
// marketplace 按需安装。本模块保留仅为单元测试与未来"恢复默认 agent"按钮使用。
//
// v1.3：YAML 的 type/parentAgentId/model.provider 不写入 DB（schema 已删除），
// 而是存到内存 builtinSuggestions Map 供 UI 添加 builtin 时预填角色/platform。
// builtin def 的 id 用确定性命名 `builtin-${slug}` 便于 suggestions Map 索引。

import fs from 'node:fs';
import path from 'node:path';
import { parseAgentManifestWithSuggestion } from './manifest-parser';
import { saveAgentDefinition, listAgentDefinitions } from './crud';
import { logger } from '../logger';
import type { BuiltinSuggestion, BuiltinSuggestionMap, AgentDefinition } from './types';

function resolveBuiltinAgentsDir(): string {
  if (process.resourcesPath && !process.defaultApp) {
    return path.join(process.resourcesPath, 'agents');
  }
  return path.join(__dirname, '..', '..', '..', 'resources', 'agents');
}

/** 测试钩子：覆盖内置 agent 目录路径；传 null 恢复默认 */
let dirOverride: string | null = null;
export function setBuiltinAgentsDir(dir: string | null): void {
  dirOverride = dir;
}

/** 内存建议表：defId → BuiltinSuggestion（仅主进程持有，IPC getBuiltinSuggestions 返回） */
const builtinSuggestions = new Map<string, BuiltinSuggestion>();

/**
 * 注册所有内置 agent 定义。幂等——已存在的不重复生成新 id。
 * v1.3：builtin def id 用 `builtin-${slug}`；type/parent/platform 信息入内存 suggestions Map。
 */
export function registerBuiltinAgents(): void {
  builtinSuggestions.clear();

  const dir = dirOverride ?? resolveBuiltinAgentsDir();
  if (!fs.existsSync(dir)) {
    logger.warn('内置 agent 目录不存在，跳过注册', { dir });
    return;
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  if (files.length === 0) {
    logger.warn('内置 agent 目录为空', { dir });
    return;
  }

  // Phase 1：解析全部 YAML，落库 def，填充 suggestions Map（suggestedParentDefId 暂存 slug）
  for (const file of files) {
    try {
      const yamlContent = fs.readFileSync(path.join(dir, file), 'utf-8');
      const { def: parsedDef, suggestion } = parseAgentManifestWithSuggestion(yamlContent);
      // builtin 标记 source='builtin'；id 用确定性命名；workspaceId=NULL；modelProviderId=NULL
      const def: AgentDefinition = {
        ...parsedDef,
        id: `builtin-${parsedDef.slug}`,
        source: 'builtin',
        workspaceId: null,
        modelProviderId: null,
      };
      saveAgentDefinition(def);
      builtinSuggestions.set(def.id, suggestion);
    } catch (err) {
      logger.error('解析内置 agent 失败', { file, error: (err as Error).message });
    }
  }

  // Phase 2：把 suggestion.suggestedParentDefId 从 slug 解析为 `builtin-${slug}` defId
  for (const suggestion of builtinSuggestions.values()) {
    if (suggestion.suggestedParentDefId) {
      suggestion.suggestedParentDefId = `builtin-${suggestion.suggestedParentDefId}`;
    }
  }

  logger.info('内置 agent 已注册', { count: builtinSuggestions.size });
}

/** 返回 builtin 建议 Map（IPC agent:getBuiltinSuggestions 调用） */
export function getBuiltinSuggestionsMap(): BuiltinSuggestionMap {
  return Object.fromEntries(builtinSuggestions);
}

/** 测试专用：清空内存 suggestions Map */
export function clearBuiltinSuggestionsForTest(): void {
  builtinSuggestions.clear();
}

/** 写入单条 suggestion（preset.ts 按需启用时调用；spec 2026-09-22） */
export function setBuiltinSuggestion(defId: string, suggestion: BuiltinSuggestion): void {
  builtinSuggestions.set(defId, suggestion);
}

/**
 * 按 slug 读取单个内置 agent manifest（preset.ts 启用链路）。
 * 文件缺失抛错——按需启用是用户显式动作，缺文件必须可见
 * （区别于 registerBuiltinAgents 整目录扫描的静默跳过）。
 */
export function readBuiltinManifestBySlug(slug: string): {
  def: AgentDefinition;
  suggestion: BuiltinSuggestion;
} {
  const dir = dirOverride ?? resolveBuiltinAgentsDir();
  const file = path.join(dir, `${slug}.yaml`);
  if (!fs.existsSync(file)) {
    throw new Error(`预设 agent 文件不存在: ${file}`);
  }
  return parseAgentManifestWithSuggestion(fs.readFileSync(file, 'utf-8'));
}

/**
 * 预置清单条目（P2.3 spec §5——resource:listBuiltinPresets 返回形状）。
 * 只读清单的最小面：不含 systemPrompt / 工具引用等重字段。
 * renderer types.d.ts 有同形独立定义（跨进程仅结构对齐，repo 惯例）。
 */
export interface BuiltinPresetItem {
  slug: string;
  name: string;
  description: string;
  iconEmoji: string;
}

/**
 * 枚举内置 agent YAML 目录产出预置清单（AddMenu「启用预置库」数据源，P2.3）。
 * 本地直读零网络——刻意不走 fetchCatalog（其远程优先语义违背零网络红线）。
 * 目录缺失抛中文错（弹窗红字 + 重试，spec §7）；单文件解析失败记日志跳过
 * （与 registerBuiltinAgents 同语义——坏一个 YAML 不拖垮整张清单）。
 */
export function listBuiltinPresetAgents(): BuiltinPresetItem[] {
  const dir = dirOverride ?? resolveBuiltinAgentsDir();
  if (!fs.existsSync(dir)) {
    throw new Error(`预置清单读取失败：内置 agent 目录不存在（${dir}）`);
  }
  const items: BuiltinPresetItem[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    try {
      const { def } = parseAgentManifestWithSuggestion(
        fs.readFileSync(path.join(dir, file), 'utf-8'),
      );
      items.push({
        slug: def.slug,
        name: def.name,
        description: def.description,
        iconEmoji: def.iconEmoji,
      });
    } catch (err) {
      logger.error('解析内置 agent 失败（预置清单）', {
        file,
        error: (err as Error).message,
      });
    }
  }
  items.sort((a, b) => a.slug.localeCompare(b.slug));
  return items;
}

/**
 * 启动轻量加载：解析全部内置 YAML 只填 suggestions Map，不落库（spec §5）。
 * 保证 agent:getBuiltinSuggestions 开箱有数据（平台预选可用），
 * DB 维持「按需启用」语义——def 行仅在用户点启用时写入。
 */
export function loadBuiltinSuggestionsOnly(): void {
  builtinSuggestions.clear();
  const dir = dirOverride ?? resolveBuiltinAgentsDir();
  if (!fs.existsSync(dir)) {
    logger.warn('内置 agent 目录不存在，跳过 suggestions 加载', { dir });
    return;
  }
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    try {
      const yamlContent = fs.readFileSync(path.join(dir, file), 'utf-8');
      const { def, suggestion } = parseAgentManifestWithSuggestion(yamlContent);
      builtinSuggestions.set(`builtin-${def.slug}`, suggestion);
    } catch (err) {
      logger.error('解析内置 agent 失败（suggestions only）', {
        file,
        error: (err as Error).message,
      });
    }
  }
}

// 向下兼容：listAgentDefinitions 引用保留（虽然本文件未直接使用，旧测试可能调用）
void listAgentDefinitions;
