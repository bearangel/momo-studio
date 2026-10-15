// electron/src/main/plugin/manifest.ts
//
// manifest 解析 + 校验管线（spec §2.4 步骤 1-4，全部拒绝式、fail loud）。
// 步骤 5（交叉引用：agents defaultSkills/defaultTools 指向存在）在 P2 组件
// 激活时补——P1 尚不解析 agent YAML 内容。
import fs from 'node:fs';
import path from 'node:path';
import { load as yamlLoad } from 'js-yaml';
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

  // 顶层类型检查（spec §2.4 步骤 1「JSON Schema 校验」的运行时落地——renderer
  // 会透传 name/description，非字符串能直接崩 React 树；components 非对象会让
  // 下方键访问抛英文 TypeError 而非带字段路径的中文错误）
  for (const field of ['id', 'name', 'version', 'description'] as const) {
    if (typeof manifest[field] !== 'string') {
      issues.push({ field, message: `必须是字符串` });
    }
  }
  if (
    typeof manifest.components !== 'object' ||
    manifest.components === null ||
    Array.isArray(manifest.components)
  ) {
    issues.push({ field: 'components', message: '必须是对象（组件键 → 相对路径）' });
  }
  if (manifest.minAppVersion !== undefined && typeof manifest.minAppVersion !== 'string') {
    issues.push({ field: 'minAppVersion', message: '必须是字符串' });
  }

  if (typeof manifest.id === 'string' && !isValidSlug(manifest.id)) {
    issues.push({ field: 'id', message: `非法插件 id（白名单外字符）: ${manifest.id}` });
  }
  if (typeof manifest.version === 'string') {
    if (!isValidVersion(manifest.version)) {
      issues.push({ field: 'version', message: `非法版本号: ${manifest.version}` });
    } else if (manifest.version === '.' || manifest.version === '..') {
      // VERSION_PATTERN 允许纯点号，但 path.join 会把 '..' 段归一化为上级目录——
      // 安装链 target/versionRoot 会被劫持摧毁 plugins 目录（审查 C1）。id 侧
      // SLUG_PATTERN 首字符锁字母数字，天然无此洞。
      issues.push({
        field: 'version',
        message: `版本号不能为 '.' 或 '..'（路径归一化穿越）: ${manifest.version}`,
      });
    }
  }

  const componentsValid =
    typeof manifest.components === 'object' &&
    manifest.components !== null &&
    !Array.isArray(manifest.components);
  for (const key of COMPONENT_KEYS) {
    if (!componentsValid) continue;
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

  issues.push(...validateManifestCrossRefs(manifest, pluginRoot));
  if (issues.length > 0) throw new PluginManifestError(issues);
}

/**
 * 校验步骤 5（spec §2.4，P2）：agents YAML 的交叉引用——
 *  - defaultTools 里 `plugin:<本插件id>/` 前缀 ref 的短名，须在本插件
 *    components.tools 目录的模块文件名（去 .js）集合内（静态近似：运行时
 *    真名以模块 getDefs 为准，文件名约定覆盖绝大多数插件）
 *  - defaultSkills 的 ref 须在本插件 components.skills 子目录集合内
 *  - YAML 解析失败 → issue（不抛裸错）
 */
export function validateManifestCrossRefs(
  manifest: PluginManifest,
  pluginRoot: string,
): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const agentsRel = manifest.components?.agents;
  if (typeof agentsRel !== 'string') return issues;
  const agentsDir = path.resolve(pluginRoot, agentsRel);

  // 短名域：tools 模块文件名（若声明）；skills 子目录名（若声明）
  const shortToolNames = new Set<string>();
  const toolsRel = manifest.components?.tools;
  if (typeof toolsRel === 'string') {
    try {
      for (const f of fs.readdirSync(path.resolve(pluginRoot, toolsRel))) {
        if (f.endsWith('.js')) shortToolNames.add(f.slice(0, -3));
      }
    } catch {
      // 目录缺失已由步骤 4 存在性检查报告
    }
  }
  const skillSlugs = new Set<string>();
  const skillsRel = manifest.components?.skills;
  if (typeof skillsRel === 'string') {
    try {
      for (const e of fs.readdirSync(path.resolve(pluginRoot, skillsRel), { withFileTypes: true })) {
        if (e.isDirectory()) skillSlugs.add(e.name);
      }
    } catch {
      // 同上
    }
  }

  let files: string[] = [];
  try {
    files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.yaml'));
  } catch {
    return issues; // 步骤 4 已报
  }
  const prefix = `plugin:${manifest.id}/`;
  for (const file of files) {
    const filePath = path.join(agentsDir, file);
    let raw: unknown;
    try {
      raw = yamlLoad(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      issues.push({
        field: `agents.${file}`,
        message: `YAML 解析失败: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const spec = (raw as { spec?: { defaultTools?: Array<{ ref?: string }>; defaultSkills?: Array<{ ref?: string }> } }).spec;
    for (const t of spec?.defaultTools ?? []) {
      if (typeof t?.ref === 'string' && t.ref.startsWith(prefix)) {
        const short = t.ref.slice(prefix.length);
        if (!shortToolNames.has(short)) {
          issues.push({
            field: `agents.${file}.defaultTools`,
            message: `引用本插件未声明的工具短名: ${short}（tools 目录无 ${short}.js）`,
          });
        }
      }
    }
    for (const s of spec?.defaultSkills ?? []) {
      if (typeof s?.ref === 'string' && !skillSlugs.has(s.ref)) {
        issues.push({
          field: `agents.${file}.defaultSkills`,
          message: `引用本插件不存在的 skill 子目录: ${s.ref}`,
        });
      }
    }
  }
  return issues;
}
