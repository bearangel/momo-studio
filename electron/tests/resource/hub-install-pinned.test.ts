// electron/tests/resource/hub-install-pinned.test.ts
//
// M3.4 B13 回归锁：installHubPackage 钉死版本（pinnedVersion）安装链。
// 测试形态沿用 hub-install-stale.test.ts：进程内 node:http 真 mock hub +
// __setHubContextResolverForTest 注入上下文；只 mock electron（进度广播边界）。
//
// 覆盖（spec §2.3.2 逐格）：
//   1. fresh + pinned ∈ versions → 下载钉死版 URL（/resources/{slug}/{pinned}/download）
//      + 记账版本 = pinned（含已装 agent 定义版本）
//   2. pinned ∉ versions（版本行不存在）→ HubPinnedVersionUnavailableError，
//      零下载请求（目录 versions 全集预检先行）
//   3. 已装 1.0.0 < pinned 1.5.0 → 升级到 pinned（M2.3「不升级旧版」边界打开，
//      仅 pinned 参数在场触发）
//   4. 已装 2.0.0 ≥ pinned 1.5.0 → alreadyLatest 零动作（零下载）
//   5. 对照：无 pinned → latest 语义不变（装 2.0.0）
//   6. 探测 404 竞态：目录 versions 声明有 pinned 但下载端点 404 → 软失败错误
//     （镜像链跳过依据——spec §2.3「下载 404 → 记 unresolvedRefs 不中止」）

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// electron 模块 mock（仅进度广播窗口边界；无窗口 → 静默跳过）
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  app: { getVersion: () => '2.1.0-test' },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { listAgentDefinitions } from '../../src/main/agent/crud';
import {
  HubPinnedVersionUnavailableError,
  installHubPackage,
} from '../../src/main/resource/hub-install';
import {
  __setHubContextResolverForTest,
  hubPackageItemId,
} from '../../src/main/resource/hub/momo-hub';
import { __resetTrustedDownloadOriginsForTest } from '../../src/main/marketplace/installer';
import { __resetCatalogCacheForTest } from '../../src/main/marketplace/client';

const tmpRoot = path.join(os.tmpdir(), `ap-hub-pinned-${Date.now()}`);

/** 多版本目录夹具：slug → 各版本真 tar.gz（agent 包） */
const fixtures = new Map<string, Map<string, { archive: Buffer; checksum: string }>>();
/** 目录 versions 声明覆写（与下载端点实际供给的差集 = 探测 404 竞态形态） */
let declaredVersions: string[] | null = null;
let hubRequests: string[] = [];
let hubUrl = '';
let hubServer: http.Server | null = null;

function packTarGz(files: Record<string, string>): Buffer {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-hub-pinned-pkg-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(stageDir, name), content);
  }
  const outPath = path.join(
    stageDir, '..', `pkg-${Date.now()}-${Math.random().toString(16).slice(2)}.tar.gz`,
  );
  execFileSync('tar', ['-czf', outPath, '-C', stageDir, ...Object.keys(files)]);
  const buf = fs.readFileSync(outPath);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.rmSync(outPath, { force: true });
  return buf;
}

function agentPackage(slug: string, version: string): Buffer {
  const manifest = [
    'apiVersion: v1',
    'kind: AgentDefinition',
    'metadata:',
    `  name: ${slug}`,
    `  slug: ${slug}`,
    `  version: ${version}`,
    '  description: pinned 链演示 agent',
    "  iconEmoji: '🤖'",
    'spec:',
    '  type: standalone',
    '  runtime: declarative',
    '  declarative:',
    `    systemPrompt: 你是 ${slug}@${version} 的演示 agent`,
    '    model:',
    '      provider: anthropic',
    '      model: claude-3-5-sonnet',
    '',
  ].join('\n');
  return packTarGz({ 'manifest.yaml': manifest });
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** semver 降序比较（三段数字——hub versions 不变量：latest = max 落 [0]） */
function semverDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  return (pb[0] ?? 0) - (pa[0] ?? 0) || (pb[1] ?? 0) - (pa[1] ?? 0) || (pb[2] ?? 0) - (pa[2] ?? 0);
}

/** 注册一个多版本 agent 条目（下载端点供给全部版本） */
function registerVersions(slug: string, versions: string[]): void {
  const byVersion = new Map<string, { archive: Buffer; checksum: string }>();
  for (const v of versions) {
    const archive = agentPackage(slug, v);
    byVersion.set(v, { archive, checksum: sha256(archive) });
  }
  fixtures.set(slug, byVersion);
}

async function startMockHub(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    hubRequests.push(url);
    if (url === '/resources/catalog') {
      const items = [...fixtures.entries()].map(([slug, byVersion]) => {
        const versions = declaredVersions ?? [...byVersion.keys()].sort(semverDesc);
        const latest = versions[0] ?? [...byVersion.keys()][0]!;
        const f = byVersion.get(latest)!;
        return {
          slug,
          type: 'agent',
          name: slug,
          version: latest,
          author: 'node-e2e',
          description: 'pinned 链演示条目',
          readme: `# ${slug}`,
          tags: ['e2e'],
          category: 'dev',
          iconEmoji: '🧪',
          verificationStatus: 'unverified',
          downloadUrl: `http://untrusted.example.com/resources/${slug}/${latest}/download`,
          checksum: f.checksum,
          sizeBytes: f.archive.length,
          publishedAt: 1_700_000_000_000,
          versions,
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: '1.5.0',
        revision: 11,
        updatedAt: '2026-10-29T00:00:00.000Z',
        items,
      }));
      return;
    }
    const match = url.match(/^\/resources\/([^/]+)\/([^/]+)\/download$/);
    const byVersion = match ? fixtures.get(decodeURIComponent(match[1]!)) : undefined;
    const fixture = match ? byVersion?.get(decodeURIComponent(match[2]!)) : undefined;
    if (!fixture) {
      res.writeHead(404);
      res.end();
      return;
    }
    // hub 下载端点契约：逐版本权威校验和头（内容寻址 blob 单源）
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(fixture.archive.length),
      'X-Checksum-Sha256': fixture.checksum,
    });
    res.end(fixture.archive);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

/** 直插 hub 已装记账行（已装版本判定源——M5.2 起须真实安装形态：cache_path 非空） */
function seedInstalled(slug: string, version: string): void {
  getDb()
    .prepare(
      `INSERT INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
       VALUES (?, ?, 'agent', ?, ?, ?, '')`,
    )
    .run(crypto.randomUUID(), hubPackageItemId(slug), slug, version, `/cache/hub/${slug}/${version}`);
}

/** 直插发布记账行（cache_path=''——M5.2：不算已装，安装链不得据此报 alreadyLatest） */
function seedPublishAccounting(slug: string, version: string): void {
  getDb()
    .prepare(
      `INSERT INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
       VALUES (?, ?, 'agent', ?, ?, '', '')`,
    )
    .run(crypto.randomUUID(), hubPackageItemId(slug), slug, version);
}

function installedVersion(slug: string): string | undefined {
  const row = getDb()
    .prepare('SELECT version FROM installed_packages WHERE item_id = ?')
    .get(hubPackageItemId(slug)) as { version: string } | undefined;
  return row?.version;
}

function downloadRequests(): string[] {
  return hubRequests.filter((u) => u.includes('/download'));
}

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  fixtures.clear();
  declaredVersions = null;
  hubRequests = [];
  __resetTrustedDownloadOriginsForTest();
  __resetCatalogCacheForTest();
  hubServer = await startMockHub();
  const addr = hubServer.address() as AddressInfo;
  hubUrl = `http://127.0.0.1:${addr.port}`;
  __setHubContextResolverForTest(async () => ({ hubUrl, deviceToken: 'tok-pinned' }));
});

afterEach(async () => {
  __setHubContextResolverForTest(null);
  if (hubServer) {
    hubServer.closeAllConnections();
    await new Promise<void>((resolve) => hubServer!.close(() => resolve()));
    hubServer = null;
  }
  vi.restoreAllMocks();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('installHubPackage 钉死版本（B13）', () => {
  it('fresh + pinned ∈ versions → 下载钉死版 URL + 记账/定义版本 = pinned（sha256 实校验过）', async () => {
    registerVersions('pin-agent', ['1.0.0', '1.5.0', '2.0.0']);

    const outcome = await installHubPackage('agent', 'pin-agent', { pinnedVersion: '1.5.0' });

    expect(outcome.alreadyLatest).toBeUndefined();
    // 下载/探测全部命中钉死版 URL（不取 latest 2.0.0）
    expect(downloadRequests().length).toBeGreaterThanOrEqual(1);
    expect(downloadRequests().every((u) => u === '/resources/pin-agent/1.5.0/download')).toBe(true);
    expect(installedVersion('pin-agent')).toBe('1.5.0');
    const def = listAgentDefinitions().find((d) => d.slug === 'pin-agent');
    expect(def?.version).toBe('1.5.0');
  });

  it('pinned ∉ versions（版本行不存在）→ HubPinnedVersionUnavailableError + 零下载请求', async () => {
    registerVersions('pin-missing', ['1.0.0', '2.0.0']);

    await expect(
      installHubPackage('agent', 'pin-missing', { pinnedVersion: '1.5.0' }),
    ).rejects.toBeInstanceOf(HubPinnedVersionUnavailableError);
    await expect(
      installHubPackage('agent', 'pin-missing', { pinnedVersion: '1.5.0' }),
    ).rejects.toThrow(/无版本 1\.5\.0/);
    expect(downloadRequests()).toEqual([]);
  });

  it('已装 1.0.0 < pinned 1.5.0 → 升级到 pinned（M2.3 边界打开——仅 pinned 在场触发）', async () => {
    registerVersions('pin-upgrade', ['1.0.0', '1.5.0', '2.0.0']);
    seedInstalled('pin-upgrade', '1.0.0');

    const outcome = await installHubPackage('agent', 'pin-upgrade', { pinnedVersion: '1.5.0' });

    expect(outcome.alreadyLatest).toBeUndefined();
    expect(installedVersion('pin-upgrade')).toBe('1.5.0');
    expect(downloadRequests().every((u) => u === '/resources/pin-upgrade/1.5.0/download')).toBe(true);
  });

  it('已装 2.0.0 ≥ pinned 1.5.0 → alreadyLatest 零动作（零下载）', async () => {
    registerVersions('pin-ahead', ['1.0.0', '1.5.0', '2.0.0']);
    seedInstalled('pin-ahead', '2.0.0');

    const outcome = await installHubPackage('agent', 'pin-ahead', { pinnedVersion: '1.5.0' });

    expect(outcome.alreadyLatest).toBe(true);
    expect(outcome.version).toBe('2.0.0');
    expect(downloadRequests()).toEqual([]);
    expect(installedVersion('pin-ahead')).toBe('2.0.0');
  });

  it('M5.2 回归锁：仅发布记账行（cache_path 空）在场 → 不得报 alreadyLatest，必须真实下载安装', async () => {
    registerVersions('pin-pubacc', ['1.0.0', '2.0.0']);
    seedPublishAccounting('pin-pubacc', '2.0.0');

    const outcome = await installHubPackage('agent', 'pin-pubacc');

    expect(outcome.alreadyLatest).toBeUndefined();
    expect(downloadRequests()).toEqual(['/resources/pin-pubacc/2.0.0/download']);
    const row = getDb()
      .prepare('SELECT cache_path FROM installed_packages WHERE item_id = ?')
      .get(hubPackageItemId('pin-pubacc')) as { cache_path: string } | undefined;
    expect(row?.cache_path).not.toBe('');
  });

  it('对照：无 pinned → latest 语义不变（装 2.0.0，即使目录同时有旧版）', async () => {
    registerVersions('pin-latest', ['1.0.0', '1.5.0', '2.0.0']);

    const outcome = await installHubPackage('agent', 'pin-latest');

    expect(outcome.alreadyLatest).toBeUndefined();
    expect(installedVersion('pin-latest')).toBe('2.0.0');
    expect(downloadRequests()).toEqual(['/resources/pin-latest/2.0.0/download']);
  });

  it('探测 404 竞态：目录 versions 声明有 pinned 但下载端点 404 → 软失败错误（镜像链跳过依据）', async () => {
    // 下载端点只供给 1.0.0/2.0.0；目录声明含 1.5.0（目录/数据面极窄竞态形态）
    registerVersions('pin-race', ['1.0.0', '2.0.0']);
    declaredVersions = ['2.0.0', '1.5.0', '1.0.0'];

    await expect(
      installHubPackage('agent', 'pin-race', { pinnedVersion: '1.5.0' }),
    ).rejects.toBeInstanceOf(HubPinnedVersionUnavailableError);
    await expect(
      installHubPackage('agent', 'pin-race', { pinnedVersion: '1.5.0' }),
    ).rejects.toThrow(/下载不可得/);
  });
});
