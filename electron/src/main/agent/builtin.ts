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
import { saveAgentDefinition, getAgentDefinition, listAgentDefinitions } from './crud';
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
 * 预置 agent 能力预览（resource:previewBuiltinPreset 数据源，2026-10-08 预设可见化 + 薄 fork）。
 * 只读不落库；复用启用链的 readBuiltinManifestBySlug（同一解析器 = 同一形状），
 * 数据始终来自 YAML 最新版（不受已启用 DB 行版本影响）。
 * systemPrompt 全量返回——截断由 renderer 展示层做，fork 预填需要全量。
 */
export interface BuiltinPresetPreview {
  slug: string;
  name: string;
  iconEmoji: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  mcps: string[];
  skills: string[];
}

export function previewBuiltinPresetAgent(slug: string): BuiltinPresetPreview {
  const { def } = readBuiltinManifestBySlug(slug);
  return {
    slug: def.slug,
    name: def.name,
    iconEmoji: def.iconEmoji,
    description: def.description,
    systemPrompt: def.systemPrompt,
    tools: def.defaultTools.map((t) => t.ref),
    mcps: def.defaultMcps.map((m) => m.ref),
    skills: def.defaultSkills.map((s) => s.ref),
  };
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

/**
 * builtin 预置启动再同步（spec 2026-11-09 §8，P0 防线）：启动不再全量落库，
 * 存量已启用预置的 DB 行不会自动获得新工具/技能面。本钩子对每个 builtin YAML：
 * DB 行存在且版本落后时走无 DELETE 的受控 upsert（saveAgentDefinition 的
 * ON CONFLICT DO UPDATE——同 enablePresetDef UPDATE 分支语义：不触发成员
 * CASCADE、不重置 created_at；不走 updateAgentDefinition 是因其 UPDATE 语句
 * 不含 version 列，无法完成版本推进），**用户已配模型三字段与 thinkingJson、
 * deniedTools 取 DB 行现值原样保留**（与 enablePresetDef 的关键差异——启用链
 * 以入参覆盖模型字段，再同步以用户现值为准）。
 * 幂等：版本一致 / 无行 / YAML 版本更低（理论不可达）均跳过、零写入。
 * 通用语义：不限定 slug——未来任何 builtin YAML 升版，存量行自动跟进。
 */
export function syncBuiltinPresetVersions(): void {
  for (const item of listBuiltinPresetAgents()) {
    try {
      const defId = `builtin-${item.slug}`;
      const existing = getAgentDefinition(defId);
      if (!existing) continue;
      const { def: preset } = readBuiltinManifestBySlug(item.slug);
      if (compareVersionStrings(existing.version, preset.version) >= 0) continue;
      saveAgentDefinition({
        ...preset,
        id: defId,
        source: 'builtin',
        workspaceId: null,
        // 用户配置保留：模型三字段 + thinkingJson + 工具禁用取 DB 行现值
        modelProviderId: existing.modelProviderId,
        modelName: existing.modelName,
        thinkingJson: existing.thinkingJson ?? null,
        deniedTools: existing.deniedTools ?? [],
      });
      logger.info('builtin 预置已再同步', {
        slug: item.slug,
        from: existing.version,
        to: preset.version,
      });
    } catch (err) {
      logger.warn('builtin 预置再同步失败（不阻塞启动）', {
        slug: item.slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** 简易语义化版本比较（数字段逐位），返回 -1/0/1 */
function compareVersionStrings(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// 向下兼容：listAgentDefinitions 引用保留（虽然本文件未直接使用，旧测试可能调用）
void listAgentDefinitions;
