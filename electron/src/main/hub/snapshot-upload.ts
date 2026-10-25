// electron/src/main/hub/snapshot-upload.ts
//
// 快照构建+上传编排（momo-hub M2 spec §5.2 第 2 步 / T8b，leader 侧向导 S2 消费）：
//
//   buildWorkspaceSnapshot（T7 构建）→ knownSecrets 红线复检 → multipart 上传
//   POST /workspaces/snapshots（manifest part 先于 payload part——hub T5 定序契约）
//
// knownSecrets 复检（T7 Minor#2 闭合）：构建器红线扫描不知 keychain 实值（构建时
// 只扫值形态），上传前把本机 provider key 实值回填 assertSnapshotRedline 对
// **归档实际内容**（解包后逐文件）做 belt-and-suspenders 复检——实值不含 sk-/64hex
// 等形态特征时，唯一防线就是本复检。违规即拒传（fail-closed，不上路）。
//
// 错误映射人话（publishToHub 同款纪律）：409 → 版本已存在 / 413 → 超 200MB 上限 /
// 401 → 连接失效 / 网络异常 → 无法连接 hub / 其余非 201 → hub 响应异常。

import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { getDeviceToken } from './creds';
import { hubGetStatus } from './index';
import { assertSnapshotRedline, buildWorkspaceSnapshot } from './snapshot-builder';
import { assertSafeTarMembers } from '../plugin/installer';
import { listProviders, getProviderApiKey } from '../agent/provider-crud';
import { resolveTmpDir } from '../paths';
import type { SnapshotManifest } from './protocol';

const execFileAsync = promisify(execFile);

/** 清单计数摘要（向导 S1 摘要卡 / S2 构建清单行——manifest 不出主进程，防结构漂移） */
export interface SnapshotSummary {
  /** agent 成员总数 */
  members: number;
  /** 内嵌自定义定义数（members 的子集——「X 资源引用 + Y 内嵌」展示形态） */
  embeddedMembers: number;
  teams: number;
  mcp: number;
  skills: number;
  plugins: number;
  providers: number;
  /** hub 补装位资源总数（resources） */
  resources: number;
}

/** 上传成功回执（向导 S2 完成态/S4 执行面消费） */
export interface SnapshotUploadResult {
  /** hub 存档 id（workspace.mirror 引用键） */
  snapshotId: string;
  /** 服务端自算权威 checksum（C6——与本地复算值对账后透出） */
  checksum: string;
  version: string;
  sizeBytes: number;
  /** 无 hub 记账被排除的插件 id（S1 excluded 提示条 + 构建回执） */
  excludedPlugins: string[];
  summary: SnapshotSummary;
}

/** 上传应答最小结构（fetch Response 消费面子集——测试注入用） */
export interface UploadResponseLike {
  status: number;
  json(): Promise<unknown>;
}

/** 注入缝：HTTP 边界 mock 只收窄在此（业务逻辑全真实） */
export interface SnapshotUploadDeps {
  fetchImpl?: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: FormData },
  ) => Promise<UploadResponseLike>;
}

/** keychain 中 provider key 实值清单（knownSecrets 复检回填源）。 */
async function collectProviderKeySecrets(): Promise<string[]> {
  const secrets: string[] = [];
  for (const p of listProviders()) {
    const key = await getProviderApiKey(p.id);
    if (key) secrets.push(key);
  }
  return secrets;
}

/** 归档内容红线复检：安全解包（tar 成员守卫）→ assertSnapshotRedline(manifest,
 *  解包目录, knownSecrets)。违规 throw（调用方不上传）。 */
async function assertArchiveRedline(
  manifest: SnapshotManifest,
  archivePath: string,
  knownSecrets: string[],
): Promise<void> {
  const members = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf-8' })
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.endsWith('/'));
  assertSafeTarMembers(members);
  const unpack = fs.mkdtempSync(path.join(resolveTmpDir(), 'ws-upload-check-'));
  try {
    await execFileAsync('tar', ['-xzf', archivePath, '-C', unpack]);
    assertSnapshotRedline(manifest, unpack, knownSecrets);
  } finally {
    fs.rmSync(unpack, { recursive: true, force: true });
  }
}

/**
 * 构建并上传工作空间快照（向导 S2 编排）：
 * 守卫（非 online / 无 token）→ 构建 → knownSecrets 复检（fail-closed）→
 * multipart 上传（manifest part 在前）→ 回执。上传成败均清理临时归档。
 */
export async function buildAndUploadWorkspaceSnapshot(
  workspaceId: string,
  deps: SnapshotUploadDeps = {},
): Promise<SnapshotUploadResult> {
  const status = hubGetStatus();
  if (status.state !== 'online' || !status.hubUrl) {
    throw new Error('hub 未连接，请先在设置中接入 momo-hub 并等待连接建立');
  }
  const deviceToken = await getDeviceToken();
  if (!deviceToken) throw new Error('连接已失效，请重新接入 hub（本地缺少 device token）');

  const built = await buildWorkspaceSnapshot(workspaceId);
  try {
    const knownSecrets = await collectProviderKeySecrets();
    await assertArchiveRedline(built.manifest, built.archivePath, knownSecrets);
    const uploaded = await uploadSnapshot(status.hubUrl, deviceToken, built.manifest, built.archivePath, deps);
    // 服务端权威 checksum 与本地复算对账（不一致 = hub 实现漂移，fail-fast）
    if (uploaded.checksum !== built.checksum) {
      throw new Error(
        `hub 回执 checksum 与本地复算不一致（hub=${uploaded.checksum.slice(0, 12)}… 本地=${built.checksum.slice(0, 12)}…），拒绝采用该存档`,
      );
    }
    return {
      snapshotId: uploaded.snapshotId,
      checksum: uploaded.checksum,
      version: built.manifest.version,
      sizeBytes: fs.statSync(built.archivePath).size,
      excludedPlugins: built.excludedPlugins,
      summary: {
        members: built.manifest.config.agentMembers.length,
        embeddedMembers: built.manifest.config.agentMembers.filter((mem) => mem.customDefinition !== undefined).length,
        teams: built.manifest.config.teams.length,
        mcp: built.manifest.config.mcpEnabled.length,
        skills: built.manifest.config.skills.length,
        plugins: built.manifest.config.pluginsEnabled.length,
        providers: built.manifest.config.providerRefs.length,
        resources: built.manifest.resources.length,
      },
    };
  } finally {
    fs.rmSync(built.archivePath, { force: true });
  }
}

/** multipart 上传（hub T5 契约：part 名 manifest/payload，manifest 先 append）。 */
async function uploadSnapshot(
  hubUrl: string,
  deviceToken: string,
  manifest: SnapshotManifest,
  archivePath: string,
  deps: SnapshotUploadDeps,
): Promise<{ snapshotId: string; checksum: string }> {
  const fetchImpl =
    deps.fetchImpl ??
    (async (url: string, init: { method: string; headers: Record<string, string>; body: FormData }) =>
      fetch(url, init));
  // 定序契约（hub collectManifestAndPayload）：manifest part 先 append——FormData
  // 保持 append 序，undici 按序产出 multipart body；content-type 由 fetch 自动带
  const form = new FormData();
  form.append(
    'manifest',
    new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
    'manifest.json',
  );
  form.append(
    'payload',
    new Blob([fs.readFileSync(archivePath)], { type: 'application/gzip' }),
    'payload.tar.gz',
  );

  let response: UploadResponseLike;
  try {
    response = await fetchImpl(`${hubUrl.replace(/\/+$/, '')}/workspaces/snapshots`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}` },
      body: form,
    });
  } catch {
    throw new Error('无法连接 hub（网络不可达或服务未启动）');
  }

  if (response.status === 201) {
    const body = (await response.json().catch(() => null)) as {
      snapshotId?: unknown; checksum?: unknown;
    } | null;
    if (typeof body?.snapshotId !== 'string' || typeof body?.checksum !== 'string') {
      throw new Error('hub 响应异常（快照回执缺字段）');
    }
    return { snapshotId: body.snapshotId, checksum: body.checksum };
  }
  if (response.status === 409) {
    throw new Error('该版本已存在（hub 上同工作空间+版本已存档），请重新构建（版本号自动变化）');
  }
  if (response.status === 413) {
    throw new Error('快照超过 200MB 上限，请精简工作空间后重试');
  }
  if (response.status === 401) {
    throw new Error('连接已失效，请重新接入 hub（设置 → 节点互联）');
  }
  throw new Error(`hub 响应异常: HTTP ${response.status}`);
}

/** checksum 短码（v3 · 9c4f21e0 形态——前 8 位，向导完成态 chip 展示）。 */
export function checksumShort(checksum: string): string {
  return checksum.slice(0, 8);
}
