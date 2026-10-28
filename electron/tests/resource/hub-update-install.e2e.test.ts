// electron/tests/resource/hub-update-install.e2e.test.ts
//
// T15d / D6 回归锁：「更新」死路。
// 现象（验收 T12'/T14' 复验轮实证）：renderer 更新按钮走 onInstall → 同一
// resource:install 通道，但 ipc.handlers 的 `!item.installable` 守卫先于 hub
// 分支执行——已装 hub 项 installable 恒 false（fromCatalogItem / 兜底行口径）
// → 更新入口在主进程被「不可安装」拦死，T14 更新流真机从未可达。
//
// 测试形态：与 hub-install.e2e.test.ts 同款——进程内 node:http 真 mock hub
// （T15c 鉴权形态：无/错 Bearer 一律 401，不进业务 responder）+ 真实 DB 全链
// （捕获的 resource:install handler → resolveResourceById（真 library + 真目录
// 源）→ installHubPackage → installPackage 下载/校验/解压/记账/注册）。
// 唯一额外测试缝：electron 模块 mock（ipcMain.handle 捕获注册 + app.getVersion
// 边界）——IPC 边界走捕获的注册回调直调，其余全真。
//
// 覆盖（TDD 红→绿）：
//   1. 已装 hub agent 项（installable=false）经 resource:install → 放行进
//      installHubPackage 且版本更新落库（D6 修复前在此抛「不可安装」）
//   2. 目录轮换新版本（TTL 过期传播仿真）→ 同 id 再装 = 更新语义：
//      agent_definitions 版本落新 + installed_packages 记账单行落新（upsert
//      不翻倍）+ 下载带 Bearer 打到真 mock hub
//   3. 错误路径：已装 hub 项在目录中已下架（幽灵账兜底行）→ 报目录人话错
//      （installHubPackage 内），不再是守卫的「不可安装」

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// electron 模块 mock（IPC 边界）：ipcMain.handle 捕获 handler 注册表 +
// app.getVersion 仿真（hubInstallContext 消费——与 ipc-handlers.test.ts 同款边界）
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  app: { getVersion: () => '2.1.0-test' },
}));

import { ipcMain } from 'electron';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { listAgentDefinitions } from '../../src/main/agent/crud';
import { registerResourceHandlers } from '../../src/main/resource/ipc.handlers';
import { hubPackageItemId, __setHubContextResolverForTest } from '../../src/main/resource/hub/momo-hub';
import { listHubCatalogResources } from '../../src/main/resource/hub-install';
import {
  __resetTrustedDownloadOriginsForTest,
} from '../../src/main/marketplace/installer';
import { __resetCatalogCacheForTest } from '../../src/main/marketplace/client';

const tmpRoot = path.join(os.tmpdir(), `ap-hub-update-e2e-${Date.now()}`);

/** mock hub 收到的请求路径与鉴权头（更新下载的 Bearer 锁——T15c 形态） */
let hubRequests: string[] = [];
let hubAuths: Array<string | undefined> = [];

/** 目录 fixture：同一 slug 可运行中轮换版本（仿真 A 升版发布 + TTL 过期传播） */
const fixtures = new Map<string, { archive: Buffer; checksum: string; version: string }>();

/** 真 tar.gz 归档（安装链 tar 解压 + sha256 校验须为真归档） */
function packTarGz(files: Record<string, string>): Buffer {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-hub-pkg-'));
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

/** agent 真包（manifest version 参数化——升版仿真） */
function agentPackage(slug: string, version: string): Buffer {
  const manifest = [
    'apiVersion: v1',
    'kind: AgentDefinition',
    'metadata:',
    `  name: ${slug}`,
    `  slug: ${slug}`,
    `  version: ${version}`,
    `  description: hub 更新链演示 agent`,
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

/** 起 mock hub（T15c 鉴权形态：Bearer 校验先于业务，无/错 token 一律 401） */
async function startMockHub(expectedAuth: string): Promise<{ url: string; server: http.Server }> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    hubRequests.push(url);
    hubAuths.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${expectedAuth}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (url === '/resources/catalog') {
      const items = [...fixtures.entries()].map(([slug, f]) => ({
        slug,
        type: 'agent',
        name: slug,
        version: f.version,
        author: 'node-e2e',
        description: 'hub 更新链演示条目',
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
      res.end(JSON.stringify({ version: '1.0.0', updatedAt: '2026-10-24T00:00:00.000Z', items }));
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
  const addr = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${addr.port}`, server };
}

/** 真 fetch（marketplace 远程目录禁网拦截层委托回它，防自调用递归） */
const REAL_FETCH = globalThis.fetch;

function blockMarketplaceNetwork(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('raw.githubusercontent.com')) {
      return Promise.reject(new Error('测试环境禁外网：marketplace 远程目录不回退'));
    }
    return REAL_FETCH(input, init);
  }) as typeof fetch);
}

const SLUG = 'hub-update-agent';
const RES_ID = `hub-agent-${SLUG}`;

/** 捕获的 resource:install handler（IPC 边界直调——注册回调真实执行） */
function resourceInstallHandler(): (evt: unknown, id: string) => Promise<unknown> {
  const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
  const installCall = calls.find((c: unknown[]) => c[0] === 'resource:install');
  return installCall![1] as (evt: unknown, id: string) => Promise<unknown>;
}

/** installed_packages 记账行（item_id 寻址——hub 记账单点真源） */
function installedRows(): Array<{ version: string; cache_path: string }> {
  return getDb()
    .prepare('SELECT version, cache_path FROM installed_packages WHERE item_id = ? ORDER BY installed_at')
    .all(hubPackageItemId(SLUG)) as Array<{ version: string; cache_path: string }>;
}

let hubUrl = '';
let hubServer: http.Server | null = null;

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  hubRequests = [];
  hubAuths = [];
  fixtures.clear();
  __resetTrustedDownloadOriginsForTest();
  __resetCatalogCacheForTest();
  blockMarketplaceNetwork();

  const v1 = agentPackage(SLUG, '1.0.0');
  fixtures.set(SLUG, { archive: v1, checksum: sha256(v1), version: '1.0.0' });

  const hub = await startMockHub('tok-e2e');
  hubUrl = hub.url;
  hubServer = hub.server;
  __setHubContextResolverForTest(async () => ({ hubUrl, deviceToken: 'tok-e2e' }));

  (ipcMain.handle as ReturnType<typeof vi.fn>).mockClear();
  registerResourceHandlers();
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

describe('D6 e2e：已装 hub 项经 resource:install 更新（「更新」死路回归锁）', () => {
  it('未装 → 首装 v1.0.0；目录升版后同 id 再装 → 放行更新且版本落新（记账单行）', async () => {
    const handler = resourceInstallHandler();

    // 首装：目录项未装（installable=true），走 hub 分支
    await handler({}, RES_ID);
    expect(installedRows()).toEqual([{ version: '1.0.0', cache_path: expect.any(String) }]);
    expect(listAgentDefinitions().find((d) => d.slug === SLUG)!.version).toBe('1.0.0');

    // A 升版发布 + 目录 TTL 过期传播：fixture 轮换 v1.1.0，重注入解析器清目录缓存
    // （__setHubContextResolverForTest 切换即清缓存/退避/降级态——仿真 TTL 过期）
    const v11 = agentPackage(SLUG, '1.1.0');
    fixtures.set(SLUG, { archive: v11, checksum: sha256(v11), version: '1.1.0' });
    __setHubContextResolverForTest(async () => ({ hubUrl, deviceToken: 'tok-e2e' }));

    // 此刻 library 里该项已装（installable=false）——D6 修复前在此抛「不可安装」
    await handler({}, RES_ID);

    // 版本落新：agent_definitions 以同 id upsert 到 1.1.0（成员/能力消费面）
    const def = listAgentDefinitions().find((d) => d.slug === SLUG);
    expect(def).toBeDefined();
    expect(def!.version).toBe('1.1.0');
    expect(def!.systemPrompt).toContain('1.1.0');
    // 记账单行落新（upsert 不翻倍——幽灵账兜底行消费面防翻倍）
    const rows = installedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe('1.1.0');
    // 新版本缓存目录真实落盘
    expect(fs.existsSync(path.join(rows[0]!.cache_path, 'manifest.yaml'))).toBe(true);
    // T15c 鉴权形态：更新下载带 Bearer 打到真 mock hub（v1.1.0 download 端点）
    const dlIdx = hubRequests.indexOf(`/resources/${SLUG}/1.1.0/download`);
    expect(dlIdx).toBeGreaterThanOrEqual(0);
    expect(hubAuths[dlIdx]).toBe('Bearer tok-e2e');
  });

  it('错误路径：已装项在目录中已下架（幽灵账兜底行 installable=false）→ 目录人话错而非「不可安装」', async () => {
    const handler = resourceInstallHandler();
    await handler({}, RES_ID);

    // 目录下架：fixture 清空 + 清目录缓存 → library 走 installed_packages 兜底行
    fixtures.delete(SLUG);
    __setHubContextResolverForTest(async () => ({ hubUrl, deviceToken: 'tok-e2e' }));

    // D6 修复前：兜底行 installable=false → 守卫抛「不可安装」（误导——条目明明
    // 装过）。修复后：进 installHubPackage → 目录查不到 → 人话错误
    await expect(handler({}, RES_ID)).rejects.toThrow(/momo-hub 目录中未找到/);
  });
});

describe('D7 e2e：目录行透出已装版本（角标锚 installedVersion 数据面）', () => {
  it('目录先行 + 已装旧版：version=目录 head、installedVersion=记账版本（「可更新」判定源）', async () => {
    const handler = resourceInstallHandler();
    await handler({}, RES_ID); // 首装 v1.0.0（记账/注册全真链）

    // 目录升版 + TTL 过期传播（renderer 场景：目录快照先行、hubUpdates 事件迟到——
    // M1 T14 报告「已是最新断言盲区」：旧锚点 item.version 恒等于事件版本）
    const v11 = agentPackage(SLUG, '1.1.0');
    fixtures.set(SLUG, { archive: v11, checksum: sha256(v11), version: '1.1.0' });
    __setHubContextResolverForTest(async () => ({ hubUrl, deviceToken: 'tok-e2e' }));

    const items = await listHubCatalogResources('agent');
    const it = items.find((i) => i.slug === SLUG);
    expect(it).toBeDefined();
    expect(it!.installed).toBe(true);
    expect(it!.version).toBe('1.1.0'); // 目录 head（展示面不变）
    expect(it!.installedVersion).toBe('1.0.0'); // 已装版（D7 角标锚点）
  });

  it('幽灵账兜底行（目录已无此条目）：installedVersion = 记账版本', async () => {
    const handler = resourceInstallHandler();
    await handler({}, RES_ID);

    fixtures.delete(SLUG);
    __setHubContextResolverForTest(async () => ({ hubUrl, deviceToken: 'tok-e2e' }));

    const items = await listHubCatalogResources('agent');
    const it = items.find((i) => i.slug === SLUG);
    expect(it).toBeDefined();
    expect(it!.installed).toBe(true);
    expect(it!.installedVersion).toBe('1.0.0');
    expect(it!.version).toBe('1.0.0'); // 兜底行无目录元数据，version 即记账版本
  });
});

// ── M2.3 T2：版本取值链修复回归锁（裁定书 p1-0 D3-1~4 / O1-1）──────────────────
//
// 与上面 D6/D7 组的关键差异：**不再借 __setHubContextResolverForTest 重注入清缓存**
// 来仿真「TTL 过期传播」——D3 实锤正是安装链消费陈旧目录快照（TTL 命中/退避
// lastGood 直返旧值）。本组用真实时序复现：暖缓存后轮换 fixture 版本，目录缓存
// 仍是旧值，安装/更新链必须自己强制 fresh 拉取（findHubMarketplaceItem →
// loadFresh），不许消费陈旧快照。
//
// 已装判定 semver 化（D3-2）：target（fresh 目录版本）≤ 已装记账版本 → 如实
// 返回 alreadyLatest 零动作；> 已装 → 版本前进走安装。消除两条旧路径：
//   - installer `.installed` 标记幂等跳过的「静默成功零 DB 写入」（D3 现象闭环）
//   - 乱序/旧目录低版本下的降级安装（字符串比较无 semver 前进判定）

describe('M2.3 T2：D3/O-1 复现锁——fresh latest 取值 + 已装 semver 判定', () => {
  it('D3：v1 装后 hub 出 v2（目录 TTL 缓存陈旧）→ 更新 → 记账/def 前进 v2（现状：停留 v1 报成功）', async () => {
    const handler = resourceInstallHandler();
    await handler({}, RES_ID); // 首装 v1.0.0（顺带暖目录 TTL 缓存）
    expect(installedRows()[0]!.version).toBe('1.0.0');

    // hub 侧发布 v2.0.0——**不重注入解析器**（不清目录缓存）：TTL 5min 内旧快照仍在，
    // 这正是 D3 实锤时序（事件链 hubUpdates 已知 1.1.0/2.0.0，目录缓存另一套新鲜度）
    const v2 = agentPackage(SLUG, '2.0.0');
    fixtures.set(SLUG, { archive: v2, checksum: sha256(v2), version: '2.0.0' });

    await handler({}, RES_ID); // 「更新」

    // 版本前进：记账 + agent_definitions 落 v2（红现状：TTL 命中 v1 → 幂等跳过 → 停留 1.0.0）
    const rows = installedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe('2.0.0');
    const def = listAgentDefinitions().find((d) => d.slug === SLUG);
    expect(def!.version).toBe('2.0.0');
    expect(def!.systemPrompt).toContain('2.0.0');
    // v2 下载真的打到 mock hub（fresh 目录 → downloadUrl 版本段 2.0.0）
    expect(hubRequests).toContain(`/resources/${SLUG}/2.0.0/download`);
  });

  it('O-1：目录缓存陈旧场景全新安装 → 仍取 fresh latest（现状：取旧 meta 装 v1）', async () => {
    // 浏览目录暖缓存（v1.0.0 快照进 TTL）——用户先看了一眼资源库再装
    await listHubCatalogResources('agent');

    // hub 发布 v2.0.1（不清缓存——O-1 次轮实锤时序：P2-7 删除重装仍装旧版）
    const v201 = agentPackage(SLUG, '2.0.1');
    fixtures.set(SLUG, { archive: v201, checksum: sha256(v201), version: '2.0.1' });

    const handler = resourceInstallHandler();
    await handler({}, RES_ID); // 全新安装（无记账行）

    // 装的是 fresh latest（红现状：TTL 命中 v1.0.0 → 落装 1.0.0）
    const rows = installedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe('2.0.1');
    expect(hubRequests).toContain(`/resources/${SLUG}/2.0.1/download`);
  });

  it('D3-2 同版：target == 已装 → alreadyLatest 如实回执（经 IPC 透传），零下载零记账变更', async () => {
    const handler = resourceInstallHandler();
    await handler({}, RES_ID); // 首装 v1.0.0
    const before = installedRows();
    const dlCountBefore = hubRequests.filter((u) => u.endsWith('/download')).length;

    // 目录仍 v1.0.0（不轮换）——同版重装 = 更新按钮在 semver 判定下本不应出现，
    // 但若用户经其他入口触发（如兜底行），安装链必须如实报「已是最新」而非静默成功
    const result = (await handler({}, RES_ID)) as {
      cachePath: string;
      alreadyLatest?: boolean;
      version?: string;
    };

    expect(result.alreadyLatest).toBe(true); // 红现状：返回 {cachePath} 无 alreadyLatest（幂等跳过谎报成功）
    expect(result.version).toBe('1.0.0');
    expect(installedRows()).toEqual(before); // 记账零变更
    expect(listAgentDefinitions().find((d) => d.slug === SLUG)!.version).toBe('1.0.0');
    // 零下载（幂等跳过路径本就不下载；alreadyLatest 路径连 installPackage 都不进）
    expect(hubRequests.filter((u) => u.endsWith('/download')).length).toBe(dlCountBefore);
  });

  it('版本相等语义（Review Focus 1）：已装记账 1.0 vs 目录 1.0.0 缺段相等 → alreadyLatest 不重装', async () => {
    const handler = resourceInstallHandler();
    await handler({}, RES_ID); // 首装 1.0.0（缓存目录 .../1.0.0 带 .installed 标记）

    // 仿真存量记账行短版形态（旧数据/手工导入）：'1.0' 与目录 '1.0.0' semver 相等
    getDb()
      .prepare('UPDATE installed_packages SET version = ? WHERE item_id = ?')
      .run('1.0', hubPackageItemId(SLUG));

    const result = (await handler({}, RES_ID)) as { alreadyLatest?: boolean; version?: string };
    expect(result.alreadyLatest).toBe(true); // 红现状：无 semver 判定 → 进 installPackage → .installed 命中 → 谎报成功
    expect(result.version).toBe('1.0');
    // 记账版本原样保留（不重写为 1.0.0——零动作语义）
    expect(installedRows()[0]!.version).toBe('1.0');
  });

  it('乱序低版本目录（旧 hub 数据单版本，Review Focus 2）：已装 1.0.0 > 目录 0.9.0 → alreadyLatest 不降级', async () => {
    const handler = resourceInstallHandler();
    await handler({}, RES_ID); // 首装 1.0.0

    // 目录轮换到低版本 0.9.0（旧 hub v0.1.4 时序 latest / 乱序发布遗留数据），
    // 重注入解析器仿真缓存已过期——安装链可见 fresh 目录的 0.9.0
    const v09 = agentPackage(SLUG, '0.9.0');
    fixtures.set(SLUG, { archive: v09, checksum: sha256(v09), version: '0.9.0' });
    __setHubContextResolverForTest(async () => ({ hubUrl, deviceToken: 'tok-e2e' }));

    const result = (await handler({}, RES_ID)) as { alreadyLatest?: boolean; version?: string };
    expect(result.alreadyLatest).toBe(true); // 红现状：无 semver 前进判定 → 下载 0.9.0 降级落账
    expect(result.version).toBe('1.0.0');
    expect(installedRows()[0]!.version).toBe('1.0.0'); // 记账不降级
    // 降级下载未发生
    expect(hubRequests).not.toContain(`/resources/${SLUG}/0.9.0/download`);
  });

  it('版本前进跨数量级（字典序陷阱）：1.9.0 → 1.10.0 更新落账（数值段比较，非字符串序）', async () => {
    const handler = resourceInstallHandler();
    // 首装 1.9.0
    const v19 = agentPackage(SLUG, '1.9.0');
    fixtures.set(SLUG, { archive: v19, checksum: sha256(v19), version: '1.9.0' });
    __setHubContextResolverForTest(async () => ({ hubUrl, deviceToken: 'tok-e2e' }));
    await handler({}, RES_ID);
    expect(installedRows()[0]!.version).toBe('1.9.0');

    // hub 出 1.10.0（字符串序 '1.10.0' < '1.9.0'——字典序陷阱；semver 数值段 10 > 9）
    const v110 = agentPackage(SLUG, '1.10.0');
    fixtures.set(SLUG, { archive: v110, checksum: sha256(v110), version: '1.10.0' });

    const result = (await handler({}, RES_ID)) as { alreadyLatest?: boolean };
    expect(result.alreadyLatest).toBeFalsy(); // 前进 → 真安装（红现状：字符串比较也会装，但此用例锁 semver 判定不被后续改动退化为字符串）
    expect(installedRows()[0]!.version).toBe('1.10.0');
    expect(listAgentDefinitions().find((d) => d.slug === SLUG)!.version).toBe('1.10.0');
  });
});
