// electron/src/main/skill/git-import.ts
// P2.6：从 Git 仓库导入 skill（spec 2026-09-24 §3，D1-D6）。
// 机制：HTTPS zip 归档下载（零 git 依赖）→ AdmZip 解析 → 剥顶层归档目录 →
// 全深度扫 **/SKILL.md → 每个父目录一个 skill，落 <skillsDir>/<slug>/。
// 两通道经 importId 关联：scan 下载落 tmp，import 一次性消费后清理；
// 幂等/覆盖/路径防御与 zip 上传同语义，hash 为逐 skill 目录内容 hash（D4）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { logger } from '../logger';
import { resolveTmpDir } from '../paths';
import { getSkillsDir, isIgnoredEntry, nameToSlug, parseFrontmatter, type UploadedSkill } from './zip-uploader';

/** 下载超时（ms）与大小上限（字节） */
const FETCH_TIMEOUT_MS = 60_000;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

export interface ScannedSkill { slug: string; name: string; description: string }

/** host 适配器（白名单，gitee 等后续可加——D1） */
const HOST_ADAPTERS: Array<{ hosts: string[]; build: (owner: string, repo: string) => string }> = [
  { hosts: ['github.com', 'www.github.com'], build: (o, r) => `https://codeload.github.com/${o}/${r}/zip/HEAD` },
  { hosts: ['gitlab.com'], build: (o, r) => `https://gitlab.com/${o}/${r}/-/archive/HEAD/${r}.zip` },
];

/** 解析仓库 URL → 归档 zip URL。非 https / 未知 host / 缺 owner-repo 抛中文错 */
export function buildArchiveUrl(repoUrl: string): string {
  let u: URL;
  try { u = new URL(repoUrl); } catch { throw new Error('仓库地址不是合法 URL'); }
  if (u.protocol !== 'https:') throw new Error('仓库地址必须以 https:// 开头');
  const segs = u.pathname.split('/').filter(Boolean).map((s) => s.replace(/\.git$/, ''));
  if (segs.length < 2 || !segs[0] || !segs[1]) {
    throw new Error('仓库地址需含 <owner>/<repo>（如 https://github.com/obra/superpowers）');
  }
  // 多余路径段（/tree/main 等）忽略——MVP 恒用默认分支 HEAD（spec §8 非目标）
  const adapter = HOST_ADAPTERS.find((a) => a.hosts.includes(u.host));
  if (!adapter) throw new Error(`暂不支持 ${u.host}（当前支持 github.com / gitlab.com）`);
  return adapter.build(segs[0]!, segs[1]!);
}

/** 默认下载实现：超时 + 流式大小上限（D6）。404/401 归一为「私有/不存在」中文报错 */
async function defaultFetchZip(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 404 || res.status === 401) {
      throw new Error('仓库不存在或为私有，当前仅支持公开仓库');
    }
    if (!res.ok) throw new Error(`仓库压缩包下载失败：HTTP ${res.status}`);
    const lenHeader = Number(res.headers.get('content-length') ?? 0);
    if (lenHeader > MAX_ARCHIVE_BYTES) throw new Error(`仓库压缩包超过大小上限（100MB）`);
    if (!res.body) throw new Error('仓库压缩包下载失败：无响应体');
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ARCHIVE_BYTES) {
        controller.abort();
        throw new Error('仓库压缩包超过大小上限（100MB）');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('仓库压缩包下载超时（60s）');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 解析后的归档视图：剥顶层目录后的全部文件条目（含原始 entryName 与剥后相对路径） */
interface ArchiveFile { entryName: string; rel: string; data: Buffer }

/** zip 条目清洗 + 顶层剥除（全条目共享同一首段才剥——D2/顶层剥除判定） */
function collectFiles(zip: AdmZip): ArchiveFile[] {
  const entries = zip.getEntries().filter(
    (e) => !e.isDirectory && !isIgnoredEntry(e.entryName) && !e.entryName.split('/').includes('.git'),
  );
  if (entries.length === 0) throw new Error('仓库压缩包为空');
  const firstSegs = new Set(entries.map((e) => e.entryName.split('/')[0]));
  const strip = firstSegs.size === 1 ? `${entries[0]!.entryName.split('/')[0]}/` : '';
  return entries.map((e) => ({
    entryName: e.entryName,
    rel: strip && e.entryName.startsWith(strip) ? e.entryName.slice(strip.length) : e.entryName,
    data: e.getData(),
  }));
}

/** skill 根识别：rel === 'SKILL.md' → 根级（skill 覆盖全部文件）；否则取父目录前缀 */
interface SkillRoot { slug: string; dirPrefix: string } // dirPrefix '' = 根级

function collectSkillRoots(files: ArchiveFile[], repoName: string): SkillRoot[] {
  const skillFiles = files.filter((f) => f.rel === 'SKILL.md' || f.rel.endsWith('/SKILL.md'));
  if (skillFiles.length === 0) throw new Error('未发现 SKILL.md（要求仓库内含 SKILL.md 文件）');
  const roots: SkillRoot[] = [];
  for (const f of skillFiles) {
    let slug: string;
    let dirPrefix: string;
    if (f.rel === 'SKILL.md') {
      slug = nameToSlug(parseFrontmatter(f.data.toString('utf-8')).name ?? '') || repoName;
      dirPrefix = '';
    } else {
      dirPrefix = `${f.rel.slice(0, f.rel.length - 'SKILL.md'.length)}`; // 含尾斜杠
      slug = dirPrefix.slice(0, -1).split('/').pop() ?? '';
    }
    if (!slug || slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
      throw new Error(`非法 slug：${slug || '(空)'}`);
    }
    roots.push({ slug, dirPrefix });
  }
  return roots;
}

/** 逐 skill 目录内容 hash（相对路径排序 + 内容串接——D4，跨仓库重导入同内容才跳过） */
function hashSkillFiles(items: Array<{ rel: string; data: Buffer }>): string {
  const h = crypto.createHash('sha256');
  for (const it of [...items].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    h.update(it.rel); h.update('\0'); h.update(it.data); h.update('\0');
  }
  return h.digest('hex');
}

/**
 * scan→import 会话表：importId → tmp zip 路径 + 仓库名（一次性，取出即删——D5）。
 * repoName 供 import 阶段根级无 name 条目的 slug 兜底——与 scan 阶段同源，
 * 保证「根级无 frontmatter.name」条目 scan/import 两阶段 slug 一致（Minor ①）。
 */
const IMPORT_SESSIONS = new Map<string, { tmpPath: string; repoName: string }>();

/** URL 里的仓库名（根级 SKILL.md slug 兜底用） */
function repoNameFromUrl(repoUrl: string): string {
  try {
    const segs = new URL(repoUrl).pathname.split('/').filter(Boolean);
    return (segs[1] ?? '').replace(/\.git$/, '');
  } catch { return ''; }
}

export async function scanGitRepoSkills(
  repoUrl: string,
  deps: { fetchZip?: (url: string) => Promise<Buffer>; tmpDir?: string } = {},
): Promise<{ importId: string; skills: ScannedSkill[] }> {
  const archiveUrl = buildArchiveUrl(repoUrl);
  const tmpDir = deps.tmpDir ?? resolveTmpDir();
  // 残留清理（进程崩溃兜底——D5）
  for (const f of fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : []) {
    if (f.startsWith('git-import-')) {
      try { fs.rmSync(path.join(tmpDir, f), { force: true }); } catch { /* 尽力 */ }
    }
  }
  const buffer = await (deps.fetchZip ?? defaultFetchZip)(archiveUrl);
  const files = collectFiles(new AdmZip(buffer));
  const repoName = repoNameFromUrl(repoUrl);
  const roots = collectSkillRoots(files, repoName);
  const skills: ScannedSkill[] = roots.map((r) => {
    const md = files.find((f) => f.rel === `${r.dirPrefix}SKILL.md`)!.data.toString('utf-8');
    const front = parseFrontmatter(md);
    return { slug: r.slug, name: front.name || r.slug, description: front.description ?? '' };
  });
  const importId = crypto.randomUUID();
  const tmpPath = path.join(tmpDir, `git-import-${importId}.zip`);
  fs.writeFileSync(tmpPath, buffer);
  IMPORT_SESSIONS.set(importId, { tmpPath, repoName });
  // 日志不打 URL 全文（可能带 token 形态查询串），只打 host + 数量
  logger.info('Git 仓库 skill 扫描完成', { host: new URL(repoUrl).host, count: skills.length });
  return { importId, skills };
}

export async function importGitRepoSkills(
  importId: string,
  deps: { skillsDir?: string } = {},
): Promise<{ imported: UploadedSkill[]; failures: Array<{ slug: string; reason: string }> }> {
  const session = IMPORT_SESSIONS.get(importId);
  if (!session) throw new Error('导入会话已失效，请重新扫描');
  IMPORT_SESSIONS.delete(importId);
  const { tmpPath, repoName } = session;
  const skillsDir = deps.skillsDir ?? getSkillsDir();
  const imported: UploadedSkill[] = [];
  const failures: Array<{ slug: string; reason: string }> = [];
  try {
    const files = collectFiles(new AdmZip(fs.readFileSync(tmpPath)));
    // 根级无 name 条目用会话携带的仓库名兜底——与 scan 阶段同源（Minor ①）
    const roots = collectSkillRoots(files, repoName);
    for (const root of roots) {
      try {
        // 该 skill 的文件集（根级 = 全部；包裹级 = dirPrefix 之下）+ 三层路径防御
        const items: Array<{ rel: string; data: Buffer }> = [];
        for (const f of files) {
          const rel = root.dirPrefix === '' ? f.rel
            : f.rel.startsWith(root.dirPrefix) ? f.rel.slice(root.dirPrefix.length) : null;
          if (rel === null || !rel || rel.includes('..')) continue; // 防御 1/2
          items.push({ rel, data: f.data });
        }
        const targetDir = path.join(skillsDir, root.slug);
        const resolvedTarget = path.resolve(targetDir);
        const hash = hashSkillFiles(items);
        const hashFile = path.join(targetDir, '.sha256');
        // 幂等：同 hash 跳过（D4）
        if (fs.existsSync(hashFile) && fs.readFileSync(hashFile, 'utf-8').trim() === hash) {
          const md = files.find((f) => f.rel === `${root.dirPrefix}SKILL.md`)!.data.toString('utf-8');
          const front = parseFrontmatter(md);
          imported.push({ slug: root.slug, name: front.name || root.slug, description: front.description ?? '' });
          continue;
        }
        // 覆盖 = 全量替换（清旧目录防资产残留）
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.mkdirSync(targetDir, { recursive: true });
        for (const it of items) {
          const dest = path.join(targetDir, it.rel);
          const resolvedDest = path.resolve(dest);
          // 防御 3：解析后必须在 targetDir 内
          if (resolvedDest !== resolvedTarget && !resolvedDest.startsWith(resolvedTarget + path.sep)) continue;
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, it.data);
        }
        fs.writeFileSync(hashFile, hash);
        const front = parseFrontmatter(fs.readFileSync(path.join(targetDir, 'SKILL.md'), 'utf-8'));
        imported.push({ slug: root.slug, name: front.name || root.slug, description: front.description ?? '' });
        logger.info('Git 仓库 skill 导入成功', { slug: root.slug });
      } catch (err) {
        failures.push({ slug: root.slug, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { imported, failures };
  } finally {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* 尽力 */ }
  }
}
