// electron/src/main/plugin/manifest.ts
//
// manifest 解析 + 校验管线（spec §2.4 步骤 1-4，全部拒绝式、fail loud）。
// 步骤 5（交叉引用：agents defaultSkills/defaultTools 指向存在）在 P2 组件
// 激活时补——P1 尚不解析 agent YAML 内容。
import fs from 'node:fs';
import path from 'node:path';
import { isValidSlug, isValidVersion } from '../marketplace/types';
import type { PluginManifest, PluginManifestComponents } from './types';

export interface ManifestIssue {
  field: string;
  message: string;
}

export class PluginManifestError extends Error {
  constructor(public readonly issues: ManifestIssue[]) {
    super(issues.map((i) => `${i.field}: ${i.message}`).join('\n'));
    this.name = 'PluginManifestError';
  }
}

const COMPONENT_KEYS: Array<keyof PluginManifestComponents> = [
  'tools',
  'service',
  'skills',
  'agents',
  'mcp',
  'hooks',
  'panel',
];

/**
 * components 路径安全解析：必须 ./ 开头、不含 .. 与反斜杠、resolve 后落在
 * root 内（path traversal 防线，Claude Code 同款教训）。不合法返回 null。
 */
export function resolveComponentPath(root: string, declared: string): string | null {
  if (!declared.startsWith('./')) return null;
  if (declared.includes('..') || declared.includes('\\')) return null;
  const abs = path.resolve(root, declared);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/** JSON 解析 + 顶层必填形状（spec §2.4 步骤 1） */
export function parseManifest(raw: string): PluginManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('manifest 不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('manifest 顶层必须是对象');
  }
  const m = parsed as Record<string, unknown>;
  for (const key of ['id', 'name', 'version', 'description', 'components']) {
    if (m[key] === undefined) {
      throw new Error(`manifest 缺必填字段: ${key}`);
    }
  }
  return parsed as PluginManifest;
}

/** 校验步骤 2-4：白名单 / 路径安全 / 组件存在性。违规聚合抛 PluginManifestError */
export function validateManifest(manifest: PluginManifest, pluginRoot: string): void {
  const issues: ManifestIssue[] = [];

  if (!isValidSlug(manifest.id)) {
    issues.push({ field: 'id', message: `非法插件 id（白名单外字符）: ${manifest.id}` });
  }
  if (!isValidVersion(manifest.version)) {
    issues.push({ field: 'version', message: `非法版本号: ${manifest.version}` });
  }

  for (const key of COMPONENT_KEYS) {
    const declared = manifest.components[key];
    if (declared === undefined) continue;
    if (typeof declared !== 'string' || declared === '') {
      issues.push({ field: `components.${key}`, message: '必须是非空字符串路径' });
      continue;
    }
    const abs = resolveComponentPath(pluginRoot, declared);
    if (abs === null) {
      issues.push({
        field: `components.${key}`,
        message: `路径不合法（须 ./ 开头、不含 .. 与反斜杠、落在插件根内）: ${declared}`,
      });
      continue;
    }
    if (!fs.existsSync(abs)) {
      issues.push({ field: `components.${key}`, message: `声明的路径不存在: ${declared}` });
    }
  }

  if (issues.length > 0) throw new PluginManifestError(issues);
}
