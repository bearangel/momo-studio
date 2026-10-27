// electron/src/main/plugin/hub-install.ts
//
// hub 插件归档安装（momo-hub M1 spec §6.2 / Task 12）：下载 → 守卫 → 解压 →
// **复用本地安装注册链**（与 zip 上传链完全等价——等价性由共用
// finalizePluginInstall 物理保证：PluginRecord 落库 / 原子落位
// installed/<id>/<version>/ / activateDeclarativeComponents（hooks / service /
// agents / mcp-sync / 安装 ws 单行启用）/ 事件广播）。
//
// 防线（与 installer 域同款守卫）：
//   - checksum 强制：plugin 是可执行内容，目录项必须带合法 sha256 且与下载
//     字节复算一致（marketplace 三类「空 checksum 跳过校验」的宽松不适用于插件）
//   - 下载信任集：downloadFile 内 isTrustedDownloadUrl（hub origin 注册于
//     目录拉取时——RM1-12 重写后的地址天然落在信任 origin 下）
//   - tar 成员守卫：tar -tzf 清单先过 assertSafeTarMembers（../绝对路径拒）
//   - symlink / FIFO 拒绝：解压后 lstat 语义 walk（与打包侧 collectPackEntries
//     对称——不跟随、不遍历，非常规条目整包拒）
//   - id 锚定：manifest.id 必须等于目录 slug（与 T11 打包侧 id 漂移拒绝对称
//     ——否则 hub 记账 hub:{slug} 与 plugins 表 id 失锚，卸载链找不到插件）
//
// 归档内容契约 = T11 packPluginForPublish 输出：插件根相对路径树，顶层即
// momo-plugin.json（无单层包裹目录——zip 链的包裹容忍在此不适用）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { downloadFile, type InstallPhaseListener } from '../marketplace/installer';
import { isValidSha256Hex, type MarketplaceItem } from '../marketplace/types';
import { resolvePluginsDir } from '../paths';
import { parseManifest } from './manifest';
import {
  assertMinAppVersion,
  assertSafeTarMembers,
  finalizePluginInstall,
  MAX_ENTRIES,
  MAX_TOTAL_UNCOMPRESSED,
} from './installer';
import type { PluginManifest, PluginRecord } from './types';

const execFileAsync = promisify(execFile);

const MANIFEST_NAME = 'momo-plugin.json';

/** tar -tzf 成员清单（剥目录尾条目，只留文件成员——与 vendor 链同款） */
function listTarMembers(archivePath: string): string[] {
  return execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf-8' })
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.endsWith('/'));
}

/**
 * 解压后条目形态终审 + 解压炸弹守卫：lstat 语义 walk（Dirent 不跟随链接），
 * symlink 与 FIFO/设备等非常规条目整包拒绝——与打包侧 collectPackEntries 对称。
 * 炸弹守卫（T15a-F2）：walk 顺带累计条目数与解压总量，超 zip 链同款上限
 * （MAX_ENTRIES / MAX_TOTAL_UNCOMPRESSED 自 plugin/installer 单源引入——两链
 * 同闸防漂移）即拒。tar 与 zip 头一样可说谎，解压后的实际尺寸才是权威。
 * 上限经参数注入（缺省生产常量），测试以小上限走同一 walk 路径。
 */
export function assertRegularEntries(
  root: string,
  maxTotal: number = MAX_TOTAL_UNCOMPRESSED,
  maxEntries: number = MAX_ENTRIES,
): void {
  let count = 0;
  let total = 0;
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        walk(path.join(dir, ent.name));
        continue;
      }
      if (ent.isSymbolicLink()) {
        throw new Error(`插件包含符号链接条目，拒绝安装: ${ent.name}`);
      }
      if (!ent.isFile()) {
        throw new Error(`插件包含非常规文件条目（FIFO/设备等），拒绝安装: ${ent.name}`);
      }
      count += 1;
      if (count > maxEntries) {
        throw new Error(`插件条目数超限（${count} > ${maxEntries}）`);
      }
      total += fs.statSync(path.join(dir, ent.name)).size;
      if (total > maxTotal) {
        throw new Error(`插件解压总量超限（${total} > ${maxTotal} 字节）`);
      }
    }
  };
  walk(root);
}

/**
 * hub 插件归档安装入口（resource/hub-install 的 plugin 分支委派此处）。
 * item.type 必须为 'plugin'，downloadUrl 已由 toMarketplaceItem 按 RM1-12
 * 重写为 studio 自身 hubUrl 基址。成功返回 PluginRecord（与本地 zip 安装
 * 同轨）；任何失败清理 staging 与归档半成品，不留残留。
 */
export async function installPluginHubArchive(
  item: MarketplaceItem,
  currentAppVersion: string,
  originWorkspaceId: string,
  headers?: Record<string, string>,
  onProgress?: InstallPhaseListener,
): Promise<PluginRecord> {
  if (item.type !== 'plugin') {
    throw new Error(`installPluginHubArchive 仅接受 plugin 条目（收到 ${item.type}）`);
  }
  if (!originWorkspaceId) {
    throw new Error('无活动工作空间，无法确定安装作用域');
  }
  if (!isValidSha256Hex(item.checksum)) {
    throw new Error('hub 插件目录项缺少合法 sha256 校验和，拒绝安装（可执行内容必须校验）');
  }

  const pluginsDir = resolvePluginsDir();
  fs.mkdirSync(pluginsDir, { recursive: true });
  const staging = path.join(
    pluginsDir,
    `.staging-hub-${item.slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const archivePath = `${staging}.tar.gz`;
  try {
    // headers 透传 Bearer 凭证（hub spec §3.1 下载端点鉴权——resource/hub-install 注入）；
    // 阶段拍经 onProgress 上报（P2-7——plugin 是大包主场景，56MB 级下载需进度可见）
    onProgress?.('downloading');
    await downloadFile(
      item.downloadUrl,
      archivePath,
      undefined,
      headers,
      onProgress
        ? (receivedBytes, totalBytes) => onProgress('downloading', { receivedBytes, totalBytes })
        : undefined,
    );
    const actual = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
    if (actual !== item.checksum.toLowerCase()) {
      throw new Error(`hub 插件包校验失败（sha256 不符）: ${item.slug}`);
    }

    onProgress?.('extracting');
    assertSafeTarMembers(listTarMembers(archivePath));
    fs.mkdirSync(staging, { recursive: true });
    await execFileAsync('tar', ['-xzf', archivePath, '-C', staging]);
    assertRegularEntries(staging);

    const manifestPath = path.join(staging, MANIFEST_NAME);
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`hub 插件包顶层缺少 ${MANIFEST_NAME}（T11 打包契约：顶层即 manifest）`);
    }
    const manifest: PluginManifest = parseManifest(fs.readFileSync(manifestPath, 'utf-8'));
    assertMinAppVersion(manifest.minAppVersion, currentAppVersion);
    if (manifest.id !== item.slug) {
      throw new Error(
        `磁盘 manifest id 与目录 slug 不一致（${manifest.id} ≠ ${item.slug}），拒绝安装`,
      );
    }

    return finalizePluginInstall(staging, manifest, originWorkspaceId);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}
