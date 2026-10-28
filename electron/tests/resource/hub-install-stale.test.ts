// electron/tests/resource/hub-install-stale.test.ts
//
// M2.4 T1 回归锁：失败路径如实化（hub 目录 loadFresh 回落 stale）。
//
// 背景（已定案）：loadFresh() 拉取失败会静默回落 cache/lastGood 快照，回落版本
// 若 == 已装版本 → installHubPackage 返回 alreadyLatest:true → 用户看到「已是最新」
// 而卡面「可更新」角标仍在；lastGood 缺失时回落 EMPTY → 报「可能已下架」= 假归因。
//
// 本文件锁三件事：
//   1. stale 三态：loadFresh 成功 false / 失败回落 true / load 退避命中 false
//      （且失败回落不写退避、不置 degraded——P2-9 浏览语义零变化）
//   2. 安装链判定矩阵 6 格互斥完备（enrolled → stale → item → 已装行 → cmp）：
//      ①②⑥ 现状零回退；③ HubCatalogStaleError（不说下架）；④ 首装照常；
//      ⑤ HubCatalogStaleError（不得 alreadyLatest）
//   3. HubCatalogStaleError.name 稳定（消费方按 name 判定）
//
// 测试形态沿用 hub-update-install.e2e.test.ts：进程内 node:http 真 mock hub +
// __setHubContextResolverForTest 注入上下文；只 mock electron（进度广播边界）。
// 目录失败用 catalogFails 开关仿真「hub 目录端点不可达」，下载端点仍可用——
// 契约明文「回落快照的 downloadUrl 仍指向该 hub，下载链是真闸门」。

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
  HubCatalogStaleError,
  installHubPackage,
} from '../../src/main/resource/hub-install';
import {
  __setHubContextResolverForTest,
  createHubCatalogSource,
  hubPackageItemId,
  listHubMarketplaceItems,
} from '../../src/main/resource/hub/momo-hub';
import { __resetTrustedDownloadOriginsForTest } from '../../src/main/marketplace/installer';
import { __resetCatalogCacheForTest } from '../../src/main/marketplace/client';

const tmpRoot = path.join(os.tmpdir(), `ap-hub-stale-${Date.now()}`);

/** 目录夹具：slug → 真 tar.gz 字节 + 版本（可运行中轮换仿真升版） */
const fixtures = new Map<string, { archive: Buffer; checksum: string; version: string }>();

/** 目录端点开关：true = 500（仿真 hub 离线/网络不可用），下载端点恒可用 */
let catalogFails = false;
let hubRequests: string[] = [];
let hubUrl = '';
let hubServer: http.Server | null = null;

/** 真 tar.gz 归档（安装链解压 + sha256 校验须为真归档） */
function packTarGz(files: Record<string, string>): Buffer {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-hub-stale-pkg-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(stageDir, name), content);
  }
  const outPath = path.join(
    stageDir,
    '..',
    `pkg-${Date.now()}-${Math.random().toString(16).slice(2)}.tar.gz`,
  );
  execFileSync('tar', ['-czf', outPath, '-C', stageDir, ...Object.keys(files)]);
  const buf = fs.readFileSync(outPath);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.rmSync(outPath, { force: true });
  return buf;
}

/** agent 真包（manifest version 参数化） */
function agentPackage(slug: string, version: string): Buffer {
  const manifest = [
    'apiVersion: v1',
    'kind: AgentDefinition',
    'metadata:',
    `  name: ${slug}`,
    `  slug: ${slug}`,
    `  version: ${version}`,
    `  description: hub stale 链演示 agent`,
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

function registerFixture(slug: string, version: string): void {
  const archive = agentPackage(slug, version);
  fixtures.set(slug, { archive, checksum: sha256(archive), version });
}

/** 起 mock hub（catalog 可开关失败；download 恒按 fixture 服务） */
async function startMockHub(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    hubRequests.push(url);
    if (url === '/resources/catalog') {
      if (catalogFails) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'hub catalog 不可用' }));
        return;
      }
      const items = [...fixtures.entries()].map(([slug, f]) => ({
        slug,
        type: 'agent',
        name: slug,
        version: f.version,
        author: 'node-e2e',
        description: 'hub stale 链演示条目',
        readme: `# ${slug}`,
        tags: ['e2e'],
        category: 'dev',
        iconEmoji: '🧪',
        verificationStatus: 'unverified',
        downloadUrl: `http://untrusted.example.com/resources/${slug}/${f.version}/download`,
        checksum: f.checksum,
        sizeBytes: f.archive.length,
        publishedAt: 1_700_000_000_000,
        versions: [f.version],
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '1.0.0', updatedAt: '2026-10-28T00:00:00.000Z', items }));
      return;
    }
    const match = url.match(/^\/resources\/([^/]+)\/([^/]+)\/download$/);
    const fixture = match ? fixtures.get(decodeURIComponent(match[1]!)) : undefined;
    if (!fixture) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(fixture.archive.length),
    });
    res.end(fixture.archive);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function setEnrolled(): void {
  __setHubContextResolverForTest(async () => ({ hubUrl, deviceToken: 'tok-e2e' }));
}

function installedVersion(slug: string): string | undefined {
  const row = getDb()
    .prepare('SELECT version FROM installed_packages WHERE item_id = ?')
    .get(hubPackageItemId(slug)) as { version: string } | undefined;
  return row?.version;
}

/** 错误分类（矩阵签名用）：类型 + 文案关键片段 */
function errorSignature(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof HubCatalogStaleError) {
    if (message.includes('无法连接到 momo-hub 获取最新目录')) return 'stale-missing';
    if (message.includes('无法确认 momo-hub 上的最新版本')) return 'stale-installed';
    return 'stale-unknown';
  }
  if (message.includes('momo-hub 目录中未找到')) return 'missing';
  return 'other';
}

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  fixtures.clear();
  catalogFails = false;
  hubRequests = [];
  __resetTrustedDownloadOriginsForTest();
  __resetCatalogCacheForTest();
  hubServer = await startMockHub();
  const addr = hubServer.address() as AddressInfo;
  hubUrl = `http://127.0.0.1:${addr.port}`;
  setEnrolled();
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

// ── 1. stale 三态 ─────────────────────────────────────────────────────────

describe('stale 三态（loadFresh 成功 / 失败回落 / load 退避命中）', () => {
  it('loadFresh 成功 → stale=false；失败回落 → stale=true 且不写退避/不置 degraded；load 退避命中 → stale=false', async () => {
    registerFixture('stale-three', '1.0.0');
    const src = createHubCatalogSource(async () => ({ hubUrl, deviceToken: 'tok-e2e' }));

    // 成功路径恒 false
    const fresh = await src.loadFresh();
    expect(fresh.stale).toBe(false);
    expect(fresh.catalog.items).toHaveLength(1);

    // 失败回落已知快照 → stale=true；degraded 保持原值（不得置 true）、
    // 不得写退避（load() 仍走 TTL 缓存直达，不进入零网络窗口）
    catalogFails = true;
    const fallback = await src.loadFresh();
    expect(fallback.stale).toBe(true);
    expect(fallback.catalog.items).toHaveLength(1); // 回落 cache/lastGood
    expect(src.isDegraded()).toBe(false);
    const afterFailure = await src.load();
    expect(afterFailure.stale).toBe(false);
    expect(afterFailure.degraded).toBe(false); // TTL 命中，证明非退避窗口
    expect(afterFailure.catalog.items).toHaveLength(1);

    // 失败回落无 lastGood（首拉失败）→ stale=true 且空目录
    const coldSrc = createHubCatalogSource(async () => ({ hubUrl, deviceToken: 'tok-e2e' }));
    const cold = await coldSrc.loadFresh();
    expect(cold.stale).toBe(true);
    expect(cold.catalog.items).toEqual([]);

    // load() 退避命中 → stale=false（浏览链语义零变化，degraded=true）
    catalogFails = true;
    const backoffSrc = createHubCatalogSource(async () => ({ hubUrl, deviceToken: 'tok-e2e' }));
    const firstFail = await backoffSrc.load();
    expect(firstFail.degraded).toBe(true);
    expect(firstFail.stale).toBe(false);
    const backoffHit = await backoffSrc.load();
    expect(backoffHit.degraded).toBe(true);
    expect(backoffHit.stale).toBe(false);

    // 成功路径恢复 → stale=false
    catalogFails = false;
    const recovered = await src.loadFresh();
    expect(recovered.stale).toBe(false);
  });
});

// ── 2. 矩阵 6 格逐格用例 ──────────────────────────────────────────────────

describe('安装链判定矩阵（逐格）', () => {
  it('① not enrolled → 现状「未找到条目」文案不变', async () => {
    __setHubContextResolverForTest(async () => null);
    await expect(installHubPackage('agent', 'grid-1')).rejects.toThrow(
      /momo-hub 目录中未找到 agent 条目「grid-1」/,
    );
    await expect(installHubPackage('agent', 'grid-1')).rejects.toBeInstanceOf(Error);
    // notEnrolled 语义是「未接入引导」，不是 stale 错误
    await expect(installHubPackage('agent', 'grid-1')).rejects.not.toBeInstanceOf(
      HubCatalogStaleError,
    );
  });

  it('② enrolled + fresh + item=null → 现状「可能已下架」文案不变', async () => {
    const err = await installHubPackage('agent', 'grid-2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(HubCatalogStaleError);
    expect((err as Error).message).toContain('momo-hub 目录中未找到');
    expect((err as Error).message).toContain('可能尚未接入 hub、hub 离线或该条目已下架');
  });

  it('③ stale + item=null → HubCatalogStaleError，且不说「下架」', async () => {
    catalogFails = true;
    const err = await installHubPackage('agent', 'grid-3').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubCatalogStaleError);
    expect((err as Error).name).toBe('HubCatalogStaleError');
    expect((err as Error).message).toContain('无法连接到 momo-hub 获取最新目录');
    expect((err as Error).message).toContain('已装版本保持不变');
    expect((err as Error).message).not.toContain('下架');
  });

  it('④ stale + item + 无已装行 → 首装走回落快照照常安装', async () => {
    registerFixture('grid-4', '1.0.0');
    // 先占一次成功拉取（cache/lastGood 建立），再让目录端点离线
    await listHubMarketplaceItems();
    catalogFails = true;

    const outcome = await installHubPackage('agent', 'grid-4');
    expect(outcome.alreadyLatest).toBeUndefined();
    expect(installedVersion('grid-4')).toBe('1.0.0');
    expect(listAgentDefinitions().find((d) => d.slug === 'grid-4')!.version).toBe('1.0.0');
    // 下载真打到 mock hub（回落快照 downloadUrl 仍指向该 hub）
    expect(hubRequests.some((u) => u === '/resources/grid-4/1.0.0/download')).toBe(true);
  });

  it('⑤ stale + item + 已装同版 → HubCatalogStaleError（不得 alreadyLatest）', async () => {
    registerFixture('grid-5', '1.0.0');
    await installHubPackage('agent', 'grid-5');
    catalogFails = true;

    const err = await installHubPackage('agent', 'grid-5').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubCatalogStaleError);
    expect((err as Error).message).toContain('无法确认 momo-hub 上的最新版本');
    expect((err as Error).message).toContain('网络不可用');
    // 已装版本不变（未发生下载/落账）
    expect(installedVersion('grid-5')).toBe('1.0.0');
  });

  it('⑥ fresh + 已装同版 → alreadyLatest 如实；fresh + 升版 → 装新版', async () => {
    registerFixture('grid-6', '1.0.0');
    await installHubPackage('agent', 'grid-6');

    const same = await installHubPackage('agent', 'grid-6');
    expect(same.alreadyLatest).toBe(true);
    expect(same.version).toBe('1.0.0');

    // 目录升版（fresh 成功路径）→ 更新
    registerFixture('grid-6', '1.1.0');
    const upgraded = await installHubPackage('agent', 'grid-6');
    expect(upgraded.alreadyLatest).toBeUndefined();
    expect(installedVersion('grid-6')).toBe('1.1.0');
    expect(listAgentDefinitions().find((d) => d.slug === 'grid-6')!.version).toBe('1.1.0');
  });
});

// ── 3. 矩阵互斥完备遍历（6 组输入各命中一格，签名两两不同）───────────────

type GridLabel =
  | 'not-enrolled'
  | 'missing'
  | 'stale-missing'
  | 'stale-first-install'
  | 'stale-installed'
  | 'fresh-installed';

describe('矩阵互斥完备遍历断言', () => {
  interface GridOutcome {
    /** 行为签名：stale 类型 + 文案类别 + 是否发生目录网络请求 */
    signature: string;
    installed: boolean;
  }

  /** 单格执行：按输入构造状态后调用生产 installHubPackage */
  async function runCase(label: GridLabel, slug: string): Promise<GridOutcome> {
    catalogFails = false; // 上一格可能遗留离线开关——每格从可达态开始
    if (label === 'stale-first-install' || label === 'stale-installed' || label === 'fresh-installed') {
      registerFixture(slug, '1.0.0');
    }
    if (label === 'not-enrolled') {
      __setHubContextResolverForTest(async () => null);
    } else {
      setEnrolled();
    }
    if (label === 'stale-first-install') {
      await listHubMarketplaceItems(); // 建立回落快照
    }
    if (label === 'stale-installed' || label === 'fresh-installed') {
      await installHubPackage('agent', slug); // 先装 v1.0.0
      hubRequests = [];
    }
    catalogFails =
      label === 'stale-missing' || label === 'stale-first-install' || label === 'stale-installed';

    const requestsBefore = hubRequests.length;
    try {
      const result = await installHubPackage('agent', slug);
      const kind = result.alreadyLatest ? 'already-latest' : 'installed';
      return {
        signature: `${kind}|${hubRequests.length - requestsBefore}`,
        installed: installedVersion(slug) !== undefined,
      };
    } catch (err) {
      return {
        signature: `${errorSignature(err)}|${hubRequests.length - requestsBefore}`,
        installed: installedVersion(slug) !== undefined,
      };
    }
  }

  it('6 组输入各命中一格：签名集合大小 = 6（互斥且完备）', async () => {
    const rows: Array<{ label: GridLabel; slug: string }> = [
      { label: 'not-enrolled', slug: 'mx-1' },
      { label: 'missing', slug: 'mx-2' },
      { label: 'stale-missing', slug: 'mx-3' },
      { label: 'stale-first-install', slug: 'mx-4' },
      { label: 'stale-installed', slug: 'mx-5' },
      { label: 'fresh-installed', slug: 'mx-6' },
    ];
    const results: Array<{ label: string; signature: string }> = [];
    for (const row of rows) {
      const outcome = await runCase(row.label, row.slug);
      results.push({ label: row.label, signature: outcome.signature });
      // 每格行为与契约表格一一对应
      if (row.label === 'not-enrolled' || row.label === 'missing') {
        expect(outcome.signature.startsWith('missing|')).toBe(true);
      }
      if (row.label === 'stale-missing') {
        expect(outcome.signature.startsWith('stale-missing|')).toBe(true);
      }
      if (row.label === 'stale-first-install') {
        expect(outcome.signature.startsWith('installed|')).toBe(true);
        expect(outcome.installed).toBe(true);
      }
      if (row.label === 'stale-installed') {
        expect(outcome.signature.startsWith('stale-installed|')).toBe(true);
      }
      if (row.label === 'fresh-installed') {
        expect(outcome.signature.startsWith('already-latest|')).toBe(true);
      }
    }
    // 互斥：6 格行为签名两两不同（① 无网络请求 / ② 有目录请求 → 即便同文案也能区分）
    expect(new Set(results.map((r) => r.signature)).size).toBe(6);
    // 完备：6 个输入全部命中（无落空分支）
    expect(results.map((r) => r.label)).toEqual([
      'not-enrolled',
      'missing',
      'stale-missing',
      'stale-first-install',
      'stale-installed',
      'fresh-installed',
    ]);
  });
});
