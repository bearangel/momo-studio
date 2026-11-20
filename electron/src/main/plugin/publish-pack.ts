// electron/src/main/plugin/publish-pack.ts
//
// 插件发布打包（momo-hub M1 spec §6.4 / Task 11）：插件根目录 → tar.gz。
// 链路：getPlugin → resolvePluginRoot → 磁盘 manifest 过 parseManifest +
// validateManifest（发布侧第一闸）→ 白名单 walk 收集常规文件 →
// assertSafeTarMembers 终审（与安装侧同源）→ tar -czf（execFile 数组参数，
// 不经 shell——与 marketplace/installer extractTarGz 对称）→ sha256 + size。
//
// 打包白名单（spec §6.4「插件包须自身可 require」）：
//   - 仅常规文件入包
//   - node_modules/（含 vendor/node_modules）**入包**——插件 npm 依赖是运行必需
//     （2026-11-19 实锤：镜像节点装包后 Cannot find module 'mysql2'/'imapflow'，
//     email vendor/node_modules 被「任意深度排除」整目录剔除）。M1 原生边界
//     收窄为子规则：剔除 *.node 原生二进制（平台绑定不入包）与 .bin/ 脚本
//     目录（symlink 高发、无运行价值）；依赖树内 symlink/非常规条目跳过
//     不整包拒（pnpm 布局防御——跳过比拒绝务实；插件根部的 symlink 仍整包拒）
//   - 排除插件 dataDir（运行数据不入包；按 resolvePluginDataDir 路径锚定，
//     正常布局下它在插件根外，根内命中属防御性排除）
//   - 插件根部 symlink / FIFO / 设备等非常规条目 → 整包拒绝（不跟随、不遍历）
//
// 归档内容 = 插件根相对路径树（顶层即 momo-plugin.json），安装侧解压即得
// 等价目录（Task 12 hub 安装链的输入契约）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPlugin } from './registry';
import { resolvePluginRoot } from './assembly';
import { parseManifest, validateManifest } from './manifest';
import { assertSafeTarMembers } from './installer';
import { resolvePluginDataDir, resolveTmpDir } from '../paths';
import type { PluginManifest } from './types';

const execFileAsync = promisify(execFile);

/** 发布归档大小上限（200MB，spec §6.4 C5；与下载侧 MAX_DOWNLOAD_BYTES 对称） */
export const MAX_PUBLISH_ARCHIVE_BYTES = 200 * 1024 * 1024;

const MANIFEST_NAME = 'momo-plugin.json';

export interface PublishPackResult {
  archivePath: string;
  checksum: string;
  sizeBytes: number;
  manifest: PluginManifest;
}

/**
 * 白名单 walk：收集 root 下待打包的常规文件相对路径（posix 风格，供 tar 参数用）。
 * node_modules（任意深度，含 vendor/node_modules）入包——依赖树内剔除 .bin/ 与
 * *.node，symlink/非常规条目跳过；依赖树外（插件根部）symlink/非常规条目整包拒绝。
 * 排除 dataDir 与 extraExcludeDirs（vendor 声明者的 engine/ 重建态）；
 * 相对路径 .. / 绝对路径（正常 readdir 不产生）由 assertSafeTarMembers 在
 * tar 前终审——两层防线与安装侧 extractTarGz 对称。
 */
export function collectPackEntries(root: string, dataDir: string, extraExcludeDirs: string[] = []): string[] {
  const excluded = (abs: string): boolean => {
    if (abs === dataDir || abs.startsWith(dataDir + path.sep)) return true;
    return extraExcludeDirs.some((d) => abs === d || abs.startsWith(d + path.sep));
  };
  const out: string[] = [];
  const walk = (dir: string, relBase: string, inDeps: boolean): void => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const rel = relBase === '' ? ent.name : `${relBase}/${ent.name}`;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (excluded(abs)) continue;
        // 依赖树内 .bin/（脚本 symlink 高发，无运行价值）剔除
        if (inDeps && ent.name === '.bin') continue;
        walk(abs, rel, inDeps || ent.name === 'node_modules');
        continue;
      }
      // Dirent 判定均为 lstat 语义（不跟随链接）
      if (ent.isSymbolicLink()) {
        // 依赖树内跳过（pnpm 布局防御）；插件根部整包拒
        if (inDeps) continue;
        throw new Error(`插件包含符号链接条目，拒绝打包: ${rel}`);
      }
      if (!ent.isFile()) {
        if (inDeps) continue;
        throw new Error(`插件包含非常规文件条目（FIFO/设备等），拒绝打包: ${rel}`);
      }
      // 依赖树内原生二进制剔除（M1 原生边界——平台绑定不入包）
      if (inDeps && ent.name.endsWith('.node')) continue;
      out.push(rel);
    }
  };
  walk(root, '', false);
  return out;
}

/** 计算文件 sha256 hex 校验和（与 marketplace/installer computeChecksum 同构：流式读） */
async function computeChecksum(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * 插件发布打包：目录 → tar.gz（hub publish 的前置步）。
 * 失败不留半成品归档；超限（源累计或归档实际尺寸 > maxArchiveBytes）抛错。
 */
export async function packPluginForPublish(
  pluginId: string,
  maxArchiveBytes: number = MAX_PUBLISH_ARCHIVE_BYTES,
): Promise<PublishPackResult> {
  const rec = getPlugin(pluginId);
  if (!rec) throw new Error(`插件不存在: ${pluginId}`);
  const root = resolvePluginRoot(rec);
  if (root === null) {
    throw new Error(`插件目录不可用（missing 态或 dev 目录已消失）: ${pluginId}`);
  }

  // manifest 以磁盘为准（注册行快照可能落后于 dev 目录现场改动）
  const manifestPath = path.join(root, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`插件根目录缺少 ${MANIFEST_NAME}: ${root}`);
  }
  const manifest = parseManifest(fs.readFileSync(manifestPath, 'utf-8'));
  validateManifest(manifest, root);
  // id 漂移拒绝：A 插件根目录打包出 B 身份会让 dataDir 排除错位、
  // hub 侧 slug 记账失锚——注册 id 与磁盘 manifest id 必须一致
  if (manifest.id !== pluginId) {
    throw new Error(
      `磁盘 manifest id 与注册插件 id 不一致（${manifest.id} ≠ ${pluginId}），拒绝打包`,
    );
  }

  // vendor 声明插件（installer.extractVendorArchives 对称面）：
  //   engine/ 是安装侧由 vendor 归档 sha256 校验后重建的派生态（dev 目录里
  //   已解压的引擎副本不入包——codegraph 234MB 超限根因）；发布包必须携带
  //   声明的 vendor 归档且校验吻合，否则目标节点安装必失败——发布侧第一闸。
  const extraExcludeDirs: string[] = [];
  if (manifest.vendor !== undefined && manifest.vendor.archives.length > 0) {
    extraExcludeDirs.push(path.join(root, 'engine'));
    for (const arc of manifest.vendor.archives) {
      const abs = path.resolve(root, arc.file);
      if (!abs.startsWith(root + path.sep)) {
        throw new Error(`vendor 包路径越界: ${arc.file}`);
      }
      if (!fs.existsSync(abs)) {
        throw new Error(
          `vendor 包缺失（${arc.file}）——需先构建 vendor 归档并回填 manifest sha256: ${pluginId}`,
        );
      }
      const actual = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      if (actual !== arc.sha256.toLowerCase()) {
        throw new Error(
          `vendor 包 sha256 与 manifest 不符（${arc.file}）——vendor 归档更新后需回填 manifest: ${pluginId}`,
        );
      }
    }
  }

  const entries = collectPackEntries(root, resolvePluginDataDir(pluginId), extraExcludeDirs);
  assertSafeTarMembers(entries); // tar 前终审：.. / 绝对路径成员拒绝（与安装侧同款）

  // 快速失败：源文件累计超限就不必花时间真打包（归档实际尺寸 tar 后终检）
  let totalSourceBytes = 0;
  for (const rel of entries) {
    totalSourceBytes += fs.statSync(path.join(root, rel)).size;
  }
  if (totalSourceBytes > maxArchiveBytes) {
    throw new Error(`打包内容超限（${totalSourceBytes} > ${maxArchiveBytes} 字节）: ${pluginId}`);
  }

  const archivePath = path.join(
    resolveTmpDir(),
    `publish-${pluginId}-${manifest.version}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tar.gz`,
  );
  try {
    // 显式文件清单入 tar：白名单外条目（含被排除目录）物理上进不了归档
    await execFileAsync('tar', ['-czf', archivePath, '-C', root, ...entries]);
    const sizeBytes = fs.statSync(archivePath).size;
    if (sizeBytes > maxArchiveBytes) {
      throw new Error(`发布归档超限（${sizeBytes} > ${maxArchiveBytes} 字节）: ${pluginId}`);
    }
    const checksum = await computeChecksum(archivePath);
    return { archivePath, checksum, sizeBytes, manifest };
  } catch (err) {
    fs.rmSync(archivePath, { force: true }); // 失败不留半成品
    throw err;
  }
}
