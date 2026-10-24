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
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import AdmZip from 'adm-zip';
import { isIgnoredEntry } from '../skill/zip-uploader';
import { logger } from '../logger';
import {
  resolvePluginsDir,
  resolvePluginInstalledDir,
  resolvePluginDataDir,
} from '../paths';
import { parseManifest, validateManifest } from './manifest';
import type { PluginManifest } from './types';
import { validatePanelsAtRoot, notifyPanelsChanged } from './panel-sync';
import { normalizeConfigSchema, sensitiveRef, evictPluginConfigCache } from './config-store';
import { deleteSecret } from '../storage/keychain';
import { upsertPlugin, getPlugin, removePluginRecord, setPluginEnabled } from './registry';
import { uninstallPackage } from '../marketplace/installer';
import { hubPackageItemId } from '../resource/hub/momo-hub';
import { registerPluginAgents, removePluginAgents } from './agent-sync';
import { syncPluginHooks, removePluginHooks } from './hook-sync';
import { startPluginService, stopPluginService } from './service-manager';
import { getPluginBus } from './bus-instance';
import { emitPluginEvent } from './event-sources';
import { syncPluginMcps, removePluginMcps } from './mcp-sync';
import { listAllPluginSkills } from './assembly';
import { removePluginCapabilityGrants } from '../agent/grant-cleanup';
import type { PluginRecord } from './types';

/** zip bomb 守卫：累计解压上限 200MB（zip 链与 hub tar 链共用——单源导出防两链上限漂移） */
export const MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024;
/** entry 数量上限（单源导出，同上） */
export const MAX_ENTRIES = 5000;
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

/** hub 归档链复用（两链同版本闸——单源导出防规则漂移） */
export { assertMinAppVersion };

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
/** tar 成员名守卫（终审 I1）：zip 侧 isSafeEntryRelPath 防线的 tar 内延伸——
 *  `..` 段与绝对路径成员拒装（GNU tar 默认剥前导 / 但放行 ../）。
 *  抛错即拒装（staging 回滚链覆盖）。 */
export function assertSafeTarMembers(entries: string[]): void {
  for (const raw of entries) {
    if (raw.startsWith('/') || raw.split('/').includes('..')) {
      throw new Error(`vendor 包含不安全成员路径（穿越/绝对路径）: ${raw}`);
    }
  }
}

/** probe 候选（终审 I3）：win32 平台补 .exe 后缀（与 engineBinPath 同规则） */
export function probeCandidates(probe: string, platform: string): string[] {
  return platform === 'win32' ? [`${probe}.exe`, probe] : [probe];
}

function extractVendorArchives(manifest: PluginManifest, staging: string): void {
  const vendor = manifest.vendor;
  if (!vendor || vendor.archives.length === 0) return;
  const engineDir = path.join(staging, 'engine');
  for (const arc of vendor.archives) {
    const abs = path.resolve(staging, arc.file);
    if (!abs.startsWith(staging + path.sep)) {
      throw new Error(`vendor 包路径越界: ${arc.file}`);
    }
    const buf = fs.readFileSync(abs);
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (actual !== arc.sha256.toLowerCase()) {
      throw new Error(`vendor 包校验失败（sha256 不符）: ${arc.file}`);
    }
    const maxEntries = arc.maxEntries ?? 20000;
    const list = execFileSync('tar', ['-tzf', abs], { encoding: 'utf-8' })
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.trim().endsWith('/'))
      .map((l) => l.trim());
    assertSafeTarMembers(list);
    if (list.length > maxEntries) {
      throw new Error(`vendor 包条目数超限（${list.length} > ${maxEntries}）: ${arc.file}`);
    }
    fs.mkdirSync(engineDir, { recursive: true });
    execFileSync('tar', ['-xzf', abs, '-C', engineDir]);
  }
  if (vendor.probe) {
    const hit = probeCandidates(vendor.probe, process.platform).some((c) => {
      const probeAbs = path.resolve(staging, c);
      return probeAbs.startsWith(staging + path.sep) && fs.existsSync(probeAbs);
    });
    if (!hit) {
      throw new Error(
        `vendor 平台探针未命中（${vendor.probe} 不存在——引擎包与本平台不符或损坏，请确认平台变体）`,
      );
    }
  }
}

/**
 * staging → 注册的共用核心（zip 上传链 / hub 归档链两链同轨——等价性的物理保证）：
 * manifest 校验 → 原子落位 installed/<id>/<version>/ → PluginRecord 落库 →
 * 声明式组件激活（hooks/service/agents/mcp + 安装 ws 单行启用）→ 事件广播。
 * staging 由调用方解压完毕后传入；成功时 staging 被 rename 消费，失败时由
 * 调用方的 catch 清理（rename 后失败 staging 已不存在，rm force 为 no-op）。
 */
export function finalizePluginInstall(
  staging: string,
  manifest: PluginManifest,
  originWorkspaceId: string,
): PluginRecord {
  validateManifest(manifest, staging);
  validatePanelsAtRoot(staging, manifest, manifest.id);
  if (manifest.config) normalizeConfigSchema(manifest.config);
  extractVendorArchives(manifest, staging);

  const target = resolvePluginInstalledDir(manifest.id, manifest.version);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);

  const rec: PluginRecord = {
    id: manifest.id,
    version: manifest.version,
    manifestJson: JSON.stringify(manifest),
    state: 'active',
    source: 'zip',
    sourcePath: null,
    installedAt: new Date().toISOString(),
  };
  upsertPlugin(rec);
  // 单版本驻留：清同插件旧版本目录（spec §7.1）
  const versionRoot = path.dirname(target);
  for (const dir of fs.readdirSync(versionRoot)) {
    if (dir !== manifest.version) {
      fs.rmSync(path.join(versionRoot, dir), { recursive: true, force: true });
    }
  }
  activateDeclarativeComponents(rec, originWorkspaceId);
  emitPluginEvent('resourceInstalled', { type: 'plugin', id: rec.id });
  notifyPanelsChanged(); // I1 修复：zip 是 marketplace 主通道，与 dev 链对齐
  return rec;
}

export async function installPluginZip(
  data: Buffer,
  currentAppVersion: string,
  originWorkspaceId: string,
): Promise<PluginRecord> {
  assertOriginWorkspace(originWorkspaceId);
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
  try {
    fs.mkdirSync(staging, { recursive: true });
    // 实际解压尺寸守卫（审查 I2 纵深防御）：zip 头声明的 size 可说谎——声明值
    // 预检只拦诚实大包；此处按 getData() 实际长度累计，单 entry 或累计超限即抛。
    let actualTotal = 0;
    for (const e of entries) {
      let rel = e.entryName;
      if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
      if (!isSafeEntryRelPath(rel)) continue;
      const abs = path.resolve(staging, rel);
      if (abs !== staging && !abs.startsWith(staging + path.sep)) continue;
      const buf = e.getData();
      if (buf.length > MAX_TOTAL_UNCOMPRESSED) {
        throw new Error(`单文件实际解压超限（${buf.length} > ${MAX_TOTAL_UNCOMPRESSED} 字节）`);
      }
      actualTotal += buf.length;
      if (actualTotal > MAX_TOTAL_UNCOMPRESSED) {
        throw new Error(`实际解压超限（${actualTotal} > ${MAX_TOTAL_UNCOMPRESSED} 字节）`);
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
    }
    return finalizePluginInstall(staging, manifest, originWorkspaceId);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

/** dev 目录注册：不拷贝，直读源目录（改码→重载即生效的开发流，spec §7.2） */
export function installPluginDevDir(
  dir: string,
  currentAppVersion: string,
  originWorkspaceId: string,
): PluginRecord {
  assertOriginWorkspace(originWorkspaceId);
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`dev 插件目录不存在: ${abs}`);
  }
  const manifestPath = path.join(abs, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`目录内未找到 momo-plugin.json: ${manifestPath}`);
  }
  const manifest = parseManifest(fs.readFileSync(manifestPath, 'utf-8'));
  assertMinAppVersion(manifest.minAppVersion, currentAppVersion);
  validateManifest(manifest, abs);
  validatePanelsAtRoot(abs, manifest, manifest.id);
  if (manifest.config) normalizeConfigSchema(manifest.config);
  const rec: PluginRecord = {
    id: manifest.id,
    version: manifest.version,
    manifestJson: JSON.stringify(manifest),
    state: 'active',
    source: 'dev',
    sourcePath: abs,
    installedAt: new Date().toISOString(),
  };
  upsertPlugin(rec);
  activateDeclarativeComponents(rec, originWorkspaceId);
  emitPluginEvent('resourceInstalled', { type: 'plugin', id: rec.id });
  notifyPanelsChanged();
  return rec;
}

/** 安装作用域守卫（spec 2026-10-21 §5）：无 origin ws 即拒——scoped 语义下
 *  enablement 单行必须落在确定的工作空间，静默全局启用不可接受 */
function assertOriginWorkspace(originWorkspaceId: string): void {
  if (!originWorkspaceId) {
    throw new Error('无活动工作空间，无法确定安装作用域');
  }
}

/** 声明式组件激活（hooks 订阅 / service 启动 / agents 落库 / mcp 注册；
 * skills 零复制无激活步）。整层异常降级为 warn——安装不因单个组件面失败 */
function activateDeclarativeComponents(rec: PluginRecord, originWorkspaceId: string): void {
  try {
    syncPluginHooks(rec, getPluginBus());
  } catch (err) {
    logger.warn('插件 hooks 激活失败（可重载重试）', {
      pluginId: rec.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  void startPluginService(rec).catch(() => undefined);
  try {
    registerPluginAgents(rec);
  } catch (err) {
    logger.warn('插件 agents 激活失败（可重载重试）', {
      pluginId: rec.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    // scoped activation（spec §5）：MCP 定义照常注册（能力池），allocation 零写入——
    // agent 获得途径 = def 声明 / 工作空间显式授权 / 成员勾选
    syncPluginMcps(rec);
  } catch (err) {
    logger.warn('插件 MCP 激活失败（可重载重试）', {
      pluginId: rec.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // 安装 ws 单行启用（其他 ws 行缺失=停用；重装同 id 覆盖为新 origin）
  setPluginEnabled(rec.id, originWorkspaceId, true);
}

/**
 * 卸载：删注册行 + 删 installed 目录（zip 源；dev 源保留用户源目录——只解除注册）
 * + 按 keepData 决定 data 目录去留（spec §7.2）。
 */
export function uninstallPlugin(id: string, keepData: boolean): void {
  const rec = getPlugin(id);
  if (!rec) throw new Error(`插件不存在: ${id}`);
  // 级联先行（hooks 订阅、service 实例、成员/定义行、MCP 定义与 agent 引用）
  removePluginHooks(id, getPluginBus());
  void stopPluginService(id).catch(() => undefined);
  try {
    removePluginAgents(id);
  } catch (err) {
    logger.warn('插件卸载：agents 级联清理失败（残留行需手动清理）', {
      pluginId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }  try {
    // 授权行级联（spec 2026-10-21 §8）：先于目录删除扫 slug——防同 id 重装冒用继承
    const slugs = listAllPluginSkills().filter((s) => s.pluginId === id).map((s) => s.slug);
    removePluginCapabilityGrants(id, slugs);
  } catch (err) {
    logger.warn('插件卸载：授权行级联清理失败', {
      pluginId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    removePluginMcps(id);
  } catch (err) {
    logger.warn('插件卸载：MCP 级联清理失败', {
      pluginId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  removePluginRecord(id);
  emitPluginEvent('resourceRemoved', { type: 'plugin', id });
  notifyPanelsChanged();
  // hub 记账级联：hub 安装的插件（item_id = `hub:{id}`）卸载时同步删
  // installed_packages 行——否则 hub 页签残留「已从 momo-hub 安装」幽灵行
  //（插件设置页 / 资源库插件页两入口都汇入本函数，此处是唯一收口）。
  // 类型限定（T15a-F1）：`hub:{slug}` 不是跨类型唯一键——只删 item_type='plugin'
  // 行，同 item_id 的 agent/skill/mcp 记账不动。非 hub 安装（无该前缀行）为
  // 幂等 no-op。cache_path 指向的 installed 目录已在上/下行删除，
  // uninstallPackage 的 rm force 为 no-op。
  uninstallPackage(hubPackageItemId(id), 'plugin');
  if (rec.source === 'zip') {
    fs.rmSync(path.join(resolvePluginsDir(), 'installed', id), { recursive: true, force: true });
  }
  if (!keepData) {
    fs.rmSync(resolvePluginDataDir(id), { recursive: true, force: true });
    // I2 修复：keytar 敏感键随数据一起删（「删除数据」语义对密钥成立）——
    // 否则同 id 重装（marketplace 无签名，id 可冒用）经 sensitiveOverlaySync
    // 零用户操作继承前任凭据，跨信任边界外送
    try {
      const manifest = JSON.parse(rec.manifestJson) as {
        config?: { properties?: Record<string, { sensitive?: boolean }> };
      };
      const decls = Object.entries(manifest.config?.properties ?? {}).filter(([, d]) => d?.sensitive);
      for (const [key] of decls) {
        void deleteSecret(sensitiveRef(id, key)).catch(() => undefined);
      }
    } catch {
      // manifest 损坏——按无敏感键处理
    }
  }
  evictPluginConfigCache(id); // 缓存恒清（keepData=true 时下次激活边界重预热）
}
