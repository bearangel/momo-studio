// electron/src/main/plugin/installer.ts
//
// zip 安装 / dev 目录注册 / 卸载链（spec §7.2）。复用 skill zip 链骨架
// （AdmZip + isIgnoredEntry + 三层路径防御），插件链新增：
//   - zip bomb 守卫（累计解压上限 + entry 数上限——skill 链没有，Review Focus #1）
//   - manifest 校验（§2.4 管线，对 staging 根执行）
//   - minAppVersion 硬校验（§2.3）
//   - 原子落位 installed/<id>/<version>/（staging rename，单版本驻留）
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { isIgnoredEntry } from '../skill/zip-uploader';
import {
  resolvePluginsDir,
  resolvePluginInstalledDir,
  resolvePluginDataDir,
} from '../paths';
import { parseManifest, validateManifest } from './manifest';
import { upsertPlugin, getPlugin, removePluginRecord } from './registry';
import type { PluginRecord } from './types';

/** zip bomb 守卫：累计解压上限 200MB */
const MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024;
/** entry 数量上限 */
const MAX_ENTRIES = 5000;
const MANIFEST_NAME = 'momo-plugin.json';

/** 宽松版本比较：数字三元组，prerelease 忽略。a<b → -1，a>b → 1，相等 → 0 */
export function compareVersionLoose(a: string, b: string): number {
  const pa = (a.match(/\d+/g) ?? []).map(Number);
  const pb = (b.match(/\d+/g) ?? []).map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function assertMinAppVersion(minAppVersion: string | undefined, currentAppVersion: string): void {
  if (minAppVersion && compareVersionLoose(currentAppVersion, minAppVersion) < 0) {
    throw new Error(`插件需要应用版本 ≥ ${minAppVersion}，当前 ${currentAppVersion}`);
  }
}

/** 解压 entry 相对路径防御：段含 .. / 绝对路径 → 不落盘（读外部恶意 zip 的真防线） */
export function isSafeEntryRelPath(rel: string): boolean {
  if (rel.split('/').includes('..') || rel.startsWith('/') || path.isAbsolute(rel)) return false;
  return true;
}

/**
 * zip 安装：定位 manifest entry（根或单层包裹目录）→ bomb 守卫 → staging 解压 →
 * manifest 校验（对 staging 根）→ 原子移入 installed/<id>/<version>/ → 注册表落行。
 * 失败清 staging 不留残留。
 */
export async function installPluginZip(data: Buffer, currentAppVersion: string): Promise<PluginRecord> {
  const zip = new AdmZip(data);
  const entries = zip.getEntries().filter((e) => !e.isDirectory && !isIgnoredEntry(e.entryName));
  if (entries.length > MAX_ENTRIES) throw new Error(`zip 条目数超限（>${MAX_ENTRIES}）`);

  let total = 0;
  for (const e of entries) total += e.header.size;
  if (total > MAX_TOTAL_UNCOMPRESSED) {
    throw new Error(`解压总量超限（${total} > ${MAX_TOTAL_UNCOMPRESSED} 字节）`);
  }

  const manifestEntry =
    entries.find((e) => e.entryName === MANIFEST_NAME) ??
    entries.find((e) => /^[^/]+\/momo-plugin\.json$/.test(e.entryName));
  if (!manifestEntry) {
    throw new Error('zip 内未找到 momo-plugin.json（根目录或单层包裹目录）');
  }
  const prefix =
    manifestEntry.entryName === MANIFEST_NAME
      ? ''
      : manifestEntry.entryName.slice(0, -MANIFEST_NAME.length);

  const manifest = parseManifest(manifestEntry.getData().toString('utf-8'));
  assertMinAppVersion(manifest.minAppVersion, currentAppVersion);

  const staging = path.join(
    resolvePluginsDir(),
    `.staging-${manifest.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const target = resolvePluginInstalledDir(manifest.id, manifest.version);
  try {
    fs.mkdirSync(staging, { recursive: true });
    for (const e of entries) {
      let rel = e.entryName;
      if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
      if (!isSafeEntryRelPath(rel)) continue;
      const abs = path.resolve(staging, rel);
      if (abs !== staging && !abs.startsWith(staging + path.sep)) continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, e.getData());
    }
    validateManifest(manifest, staging);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);

    upsertPlugin({
      id: manifest.id,
      version: manifest.version,
      manifestJson: JSON.stringify(manifest),
      state: 'active',
      source: 'zip',
      sourcePath: null,
      installedAt: new Date().toISOString(),
    });
    // 单版本驻留：清同插件旧版本目录（spec §7.1）
    const versionRoot = path.dirname(target);
    for (const dir of fs.readdirSync(versionRoot)) {
      if (dir !== manifest.version) {
        fs.rmSync(path.join(versionRoot, dir), { recursive: true, force: true });
      }
    }
    return {
      id: manifest.id,
      version: manifest.version,
      manifestJson: JSON.stringify(manifest),
      state: 'active',
      source: 'zip',
      sourcePath: null,
      installedAt: new Date().toISOString(),
    };
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

/**
 * 卸载：删注册行 + 删 installed 目录（zip 源；dev 源保留用户源目录——只解除注册）
 * + 按 keepData 决定 data 目录去留（spec §7.2）。
 */
export function uninstallPlugin(id: string, keepData: boolean): void {
  const rec = getPlugin(id);
  if (!rec) throw new Error(`插件不存在: ${id}`);
  removePluginRecord(id);
  if (rec.source === 'zip') {
    fs.rmSync(path.join(resolvePluginsDir(), 'installed', id), { recursive: true, force: true });
  }
  if (!keepData) {
    fs.rmSync(resolvePluginDataDir(id), { recursive: true, force: true });
  }
}
