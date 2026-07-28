// electron/src/main/agent/builtin.ts
//
// 应用启动时把内置 agent 定义（resources/agents/*.yaml）幂等注册到 SQLite。
// 幂等策略：按 slug 查找已存在的记录，存在则复用其 id（保证 instance 稳定），
// 否则 parseAgentManifest 生成新 id 后写入；source 统一标记为 'builtin'。
//
// 目录解析：编译产物 dist/main/agent/builtin.js 的 __dirname 向上三级回到
// electron/ 根，再拼 resources/agents。打包后该路径不存在（asar），此时
// readdirSync 会返回空，注册被跳过——不影响应用启动。

import fs from 'node:fs';
import path from 'node:path';
import { parseAgentManifest } from './manifest-parser';
import { saveAgentDefinition, listAgentDefinitions } from './crud';
import { logger } from '../logger';

/** 内置 agent YAML 所在目录（dev 模式下相对 __dirname 解析） */
const BUILTIN_AGENTS_DIR = path.join(__dirname, '..', '..', '..', 'resources', 'agents');

/** 测试钩子：覆盖内置 agent 目录路径；传 null 恢复默认 */
let dirOverride: string | null = null;
export function setBuiltinAgentsDir(dir: string | null): void {
  dirOverride = dir;
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

  // 预取已有定义列表，避免每个文件都查一次 DB
  const existing = listAgentDefinitions();
  const existingBySlug = new Map(existing.map((d) => [d.slug, d]));

  for (const file of files) {
    try {
      const yamlContent = fs.readFileSync(path.join(dir, file), 'utf-8');
      const def = parseAgentManifest(yamlContent);
      def.source = 'builtin';

      // slug 已存在则复用 id，保证 assignment 等外键引用稳定
      const prev = existingBySlug.get(def.slug);
      if (prev) {
        def.id = prev.id;
      }
      saveAgentDefinition(def);
      logger.info('内置 agent 已注册', { slug: def.slug, name: def.name });
    } catch (err) {
      // 单个文件解析失败不阻断其余文件注册
      logger.error('注册内置 agent 失败', { file, error: (err as Error).message });
    }
  }
}
