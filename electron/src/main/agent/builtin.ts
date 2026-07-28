// electron/src/main/agent/builtin.ts
//
// 应用启动时把内置 agent 定义（resources/agents/*.yaml）幂等注册到 SQLite。
// 幂等策略：按 slug 查找已存在的记录，存在则复用其 id（保证 instance 稳定），
// 否则 parseAgentManifest 生成新 id 后写入；source 统一标记为 'builtin'。
//
// 两阶段注册：parentAgentId 在 YAML 里是 slug 引用（非 UUID），需要先注册
// main/standalone agent 拿到实际 id，再把 sub agent 的 parentAgentId slug
// 解析为父 agent 的真实 id 后注册。故流程为：
//   Phase 1: 解析全部 YAML（parentAgentId 暂存为 slug 字符串）
//   Phase 2a: 注册无 parentAgentId 的 def（main/standalone），建立 slug→id 映射
//   Phase 2b: 注册有 parentAgentId 的 def（sub），解析 slug→父 id
//
// 目录解析：编译产物 dist/main/agent/builtin.js 的 __dirname 向上三级回到
// electron/ 根，再拼 resources/agents。打包后该路径不存在（asar），此时
// readdirSync 会返回空，注册被跳过——不影响应用启动。

import fs from 'node:fs';
import path from 'node:path';
import { parseAgentManifest } from './manifest-parser';
import { saveAgentDefinition, listAgentDefinitions } from './crud';
import { logger } from '../logger';
import type { AgentDefinition } from './types';

/** 内置 agent YAML 所在目录（dev 模式下相对 __dirname 解析） */
const BUILTIN_AGENTS_DIR = path.join(__dirname, '..', '..', '..', 'resources', 'agents');

/** 测试钩子：覆盖内置 agent 目录路径；传 null 恢复默认 */
let dirOverride: string | null = null;
export function setBuiltinAgentsDir(dir: string | null): void {
  dirOverride = dir;
}

/** Phase 1 产物：解析后的 def + 原 slug 引用（parentSlug 缺省表示无父） */
interface ParsedEntry {
  def: AgentDefinition;
  /** YAML 中的 parentAgentId 原值（slug），未声明则为 undefined */
  parentSlug?: string;
}

/** 注册所有内置 agent 定义。幂等——已存在的不重复生成新 id。 */
export function registerBuiltinAgents(): void {
  const dir = dirOverride ?? BUILTIN_AGENTS_DIR;
  if (!fs.existsSync(dir)) {
    logger.warn('内置 agent 目录不存在，跳过注册', { dir });
    return;
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  if (files.length === 0) {
    logger.warn('内置 agent 目录为空', { dir });
    return;
  }

  // Phase 1：解析全部 YAML。单文件解析失败只记录日志，不阻断其余文件。
  const entries: ParsedEntry[] = [];
  for (const file of files) {
    try {
      const yamlContent = fs.readFileSync(path.join(dir, file), 'utf-8');
      const def = parseAgentManifest(yamlContent);
      def.source = 'builtin';
      entries.push({ def, parentSlug: def.parentAgentId });
    } catch (err) {
      logger.error('解析内置 agent 失败', { file, error: (err as Error).message });
    }
  }
  if (entries.length === 0) return;

  // 预取已有定义列表，避免每个文件都查一次 DB。
  // existingBySlug 同时用于：复用 id（幂等）+ 解析 parent slug。
  const existing = listAgentDefinitions();
  const existingBySlug = new Map(existing.map((d) => [d.slug, d]));

  // slug → id 解析表：合并已有 DB 记录 + 本次新注册的 def。
  // 先用已有记录填充，2a 阶段每注册一个就追加进来供 2b 查询。
  const slugToId = new Map<string, string>();
  for (const d of existing) slugToId.set(d.slug, d.id);

  /** 复用已有 id（幂等），持久化 def，登记 slug→id */
  const register = (entry: ParsedEntry): void => {
    const prev = existingBySlug.get(entry.def.slug);
    if (prev) entry.def.id = prev.id;
    saveAgentDefinition(entry.def);
    slugToId.set(entry.def.slug, entry.def.id);
    logger.info('内置 agent 已注册', {
      slug: entry.def.slug,
      name: entry.def.name,
      parent: entry.def.parentAgentId,
    });
  };

  // Phase 2a：先注册无 parentSlug 的 def（main/standalone）。
  // 此时其 parentAgentId 为 undefined，直接持久化即可。
  const withParent: ParsedEntry[] = [];
  for (const entry of entries) {
    if (entry.parentSlug) {
      withParent.push(entry);
    } else {
      entry.def.parentAgentId = undefined;
      register(entry);
    }
  }

  // Phase 2b：注册 sub agent，把 parentSlug 解析为父 agent 的实际 id。
  // 解析失败（父 slug 不存在）时记录警告并以 parentAgentId=undefined 落库，
  // 保证 agent 仍可注册（仅缺失主子关联，不阻塞启动）。
  for (const entry of withParent) {
    const parentId = entry.parentSlug ? slugToId.get(entry.parentSlug) : undefined;
    if (entry.parentSlug && !parentId) {
      logger.warn('内置 agent 的 parentAgentId slug 未找到对应父 agent', {
        slug: entry.def.slug,
        parentSlug: entry.parentSlug,
      });
    }
    entry.def.parentAgentId = parentId;
    register(entry);
  }
}
