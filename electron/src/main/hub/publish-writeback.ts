// electron/src/main/hub/publish-writeback.ts
//
// M5.1 发布版本回写（spec 2026-10-30 §1.2，RC2）：发布成功（hub 201 回执）后
// 把发布版本写回本地定义——「本地是本体」哲学补缺，本地卡版本与 hub 发布态
// 同源。四通道：
//   - skill：SKILL.md frontmatter 写/更新 version（字符串手术保其余字段与
//     正文，原子写 tmp+rename；.sha256 标记在场则同步更新为内容 hash）
//   - agent：agent_definitions.version（DB UPDATE）
//   - mcp：mcp_definitions.version（DB UPDATE，custom 源）
//   - plugin：dev 源写 momo-plugin.json version；zip 装源随包分发不可变 →
//     skipped + 回执提示「插件本体由插件包管理，版本未回写」
//
// 回写失败不推翻发布（hub 已落库）——writebackPublishedVersionSafe 吞错返回
// 失败原因，由回执 toast 警示（spec §1.2）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { getPlugin } from '../plugin/registry';
import { resolveSkillCachePath, type PublishResourceType } from './publish';

/** 回写结果（hub:publishResource 回执 versionWriteback 段——renderer 镜像） */
export interface VersionWritebackOutcome {
  /** true = 已写回本地定义 */
  written: boolean;
  /** true = 目标本体不由本地管理（plugin zip 装源），有意跳过 */
  skipped?: boolean;
  /** skipped/警示的回执提示文案（renderer 直出） */
  notice?: string;
  /** written=false 且非 skipped 时的失败原因（toast 警示消费） */
  error?: string;
}

const PLUGIN_MANIFEST_NAME = 'momo-plugin.json';

/** SKILL.md frontmatter version 写/更新：字符串手术（不重排 YAML——保注释与
 *  字段序），无 frontmatter 时补最小块；正文逐字保留。返回新内容。 */
export function upsertSkillFrontmatterVersion(md: string, version: string): string {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m || m[1] === undefined) {
    return `---\nversion: ${version}\n---\n${md}`;
  }
  const yamlText = m[1];
  const newline = yamlText.includes('\r\n') ? '\r\n' : '\n';
  const blockStart = m.index ?? 0;
  // 已有顶层 version: 行 → 只换值（限定行首无缩进——不误伤嵌套块里的 version 键）；
  // 定界符 --- 与行尾原样保留（整块 = m[0]，只置换 yamlText 段）
  if (/^version:[ \t]*.*$/m.test(yamlText)) {
    const next = yamlText.replace(/^version:[ \t]*.*$/m, `version: ${version}`);
    const rewritten = m[0].replace(yamlText, next);
    return md.slice(0, blockStart) + rewritten + md.slice(blockStart + m[0].length);
  }
  // 无 version 行 → 紧跟开档 --- 之后插入（首个字段之前，可见性最好）
  const insertAt = md.indexOf('---') + '---'.length;
  return `${md.slice(0, insertAt)}${newline}version: ${version}${md.slice(insertAt)}`;
}

/** 原子写（同目录 tmp + rename——半写不落正式路径） */
function atomicWrite(filePath: string, content: string): void {
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${crypto.randomBytes(4).toString('hex')}`,
  );
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function writebackSkill(ref: string, version: string): VersionWritebackOutcome {
  const resolved = resolveSkillCachePath(ref);
  if (resolved === null) return { written: false, error: `skill 不存在: ${ref}` };
  const skillMdPath = path.join(resolved.cachePath, 'SKILL.md');
  const md = fs.readFileSync(skillMdPath, 'utf-8');
  atomicWrite(skillMdPath, upsertSkillFrontmatterVersion(md, version));
  // .sha256 是 custom 源标记；值语义 = 内容 hash（form-create 同款）——回写后
  // 同步刷新，防 zip 幂等比对拿旧 hash 误判
  const hashFile = path.join(resolved.cachePath, '.sha256');
  if (fs.existsSync(hashFile)) {
    fs.writeFileSync(
      hashFile,
      crypto.createHash('sha256').update(fs.readFileSync(skillMdPath, 'utf-8')).digest('hex'),
    );
  }
  return { written: true };
}

function writebackAgent(ref: string, version: string): VersionWritebackOutcome {
  const r = getDb().prepare('UPDATE agent_definitions SET version = ? WHERE id = ?').run(version, ref);
  if (r.changes === 0) return { written: false, error: `agent 定义不存在: ${ref}` };
  return { written: true };
}

function writebackMcp(ref: string, version: string): VersionWritebackOutcome {
  const r = getDb()
    .prepare("UPDATE mcp_definitions SET version = ? WHERE name = ? AND source = 'custom'")
    .run(version, ref);
  if (r.changes === 0) return { written: false, error: `自定义 MCP 不存在: ${ref}` };
  return { written: true };
}

function writebackPlugin(ref: string, version: string): VersionWritebackOutcome {
  const rec = getPlugin(ref);
  if (rec === null) return { written: false, error: `插件不存在: ${ref}` };
  // dev 源：源目录归用户所有，manifest 可写；zip 装源随包分发不可变 → 跳过提示
  if (rec.source !== 'dev' || !rec.sourcePath) {
    return {
      written: false,
      skipped: true,
      notice: '插件本体由插件包管理，版本未回写',
    };
  }
  const manifestPath = path.join(rec.sourcePath, PLUGIN_MANIFEST_NAME);
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    return {
      written: false,
      error: `插件 manifest 读取失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  atomicWrite(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  return { written: true };
}

/**
 * 发布成功后版本回写本地定义（单通道分派）。**抛错即失败**——调用方用
 * writebackPublishedVersionSafe 包裹（回写失败不推翻发布回执）。
 */
export function writebackPublishedVersion(
  type: PublishResourceType,
  ref: string,
  version: string,
): VersionWritebackOutcome {
  switch (type) {
    case 'skill':
      return writebackSkill(ref, version);
    case 'agent':
      return writebackAgent(ref, version);
    case 'mcp':
      return writebackMcp(ref, version);
    case 'plugin':
      return writebackPlugin(ref, version);
  }
}

/**
 * 回写安全壳（M5.1 §1.2）：回写失败不推翻发布（hub 已落库，本地版本下次
 * 升版发布可自愈）——吞错转 { written:false, error }，回执 toast 警示。
 */
export function writebackPublishedVersionSafe(
  type: PublishResourceType,
  ref: string,
  version: string,
): VersionWritebackOutcome {
  try {
    return writebackPublishedVersion(type, ref, version);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn('发布版本回写失败（发布回执不受影响）', { type, ref, version, error });
    return { written: false, error };
  }
}
