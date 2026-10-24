// electron/tests/resource/hub-install.e2e.test.ts
//
// T10 回归锁：三类资源 hub→安装端到端 + 五源并入。
//
// 测试形态：进程内 node:http 起真 mock hub（catalog 200 + download 真 tar.gz 流）
// ——HTTP 边界走真实栈；生产链全真：HubProvider 目录源 → MarketplaceItem →
// installPackage（下载 / sha256 校验 / 解压 / 注册表）→ agent_definitions /
// skill_definitions / mcp_definitions 落行。只注入「hub 上下文」一个缝
// （hubUrl + deviceToken），目录校验（协议包 validateHubCatalog）、SWR 状态机、
// downloadUrl 基址重写（RM1-12）、信任集放行全部走生产代码。
//
// 覆盖：
//   1. agent：真 manifest.yaml 打进 tar.gz → install → agent_definitions 落行 +
//      越权 defaultTools 钳制生效（marketplace 同款语义）+ source 正确
//   2. skill：真 SKILL.md 包 → install → skill_definitions 落行
//   3. mcp：真 package.json（合法 npm 名）→ install → mcp_definitions 注册
//   4. checksum 不匹配 → 拒绝安装 + cache 清理（不落库、不注册）
//   5. hub origin http（非 https）→ 白名单放行，下载真的打到 mock hub
//   6. resource:list 并入 hub 已装项 + 五源并列（builtin/marketplace/custom/
//      smithery/hub 同时在场，互不遮蔽）
//
// DB 隔离沿用仓库既定模式：AP_USER_DATA_DIR 指向临时目录 + runMigrations() +
// closeDb() 复位单例。marketplace 远程目录禁网（fetch 拦截）→ 回退本地 catalog。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { listAgentDefinitions } from '../../src/main/agent/crud';
import { SAFE_MINIMUM_TOOLS } from '../../src/main/agent/tools/catalog';
import { listRegistered, registerMcpDefinition } from '../../src/main/mcp/host-manager';
import { listResources } from '../../src/main/resource/library';
import {
  installHubPackage,
  listHubCatalogResources,
  uninstallHubPackage,
} from '../../src/main/resource/hub-install';
import {
  __setHubContextResolverForTest,
  hubPackageItemId,
  isHubCatalogDegraded,
} from '../../src/main/resource/hub/momo-hub';
import {
  installPackage,
  isTrustedDownloadUrl,
  __resetTrustedDownloadOriginsForTest,
} from '../../src/main/marketplace/installer';
import { __resetCatalogCacheForTest } from '../../src/main/marketplace/client';
import { resolveUserDataDir } from '../../src/main/paths';

const tmpRoot = path.join(os.tmpdir(), `ap-hub-install-e2e-${Date.now()}`);

/** hub 目录条目 fixture（slug/type/version + 真归档字节 + 校验和） */
interface HubFixture {
  slug: string;
  type: 'agent' | 'mcp' | 'skill';
  name: string;
  version: string;
  archive: Buffer;
  checksum: string;
}

/** mock hub 收到的请求路径与鉴权头（catalog / download 分流断言 + D1 Bearer 锁） */
let hubRequests: string[] = [];
let hubAuths: Array<string | undefined> = [];
let hub: MockHub | null = null;

/** mock hub 句柄：鉴权仿真层支持运行中轮换期望 token（仿真凭证中途失效） */
interface MockHub {
  url: string;
  setExpectedAuth(token: string): void;
  close(): Promise<void>;
}

/** 目录 fixture 表（slug → fixture） */
const fixtures = new Map<string, HubFixture>();

/**
 * 真 tar.gz 归档（安装链用 tar 解压 + sha256 校验——必须是真归档，
 * 不能用假字节冒充，否则 checksum/解压两段都不被覆盖）。
 */
function packTarGz(files: Record<string, string>): Buffer {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-hub-pkg-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(stageDir, name), content);
  }
  const outPath = path.join(stageDir, '..', `pkg-${Date.now()}-${Math.random().toString(16).slice(2)}.tar.gz`);
  execFileSync('tar', ['-czf', outPath, '-C', stageDir, ...Object.keys(files)]);
  const buf = fs.readFileSync(outPath);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.rmSync(outPath, { force: true });
  return buf;
}

/** agent 真包：manifest.yaml（parseAgentManifest 可解析形态）+ 越权 defaultTools */
function agentPackage(slug: string): Buffer {
  const manifest = [
    'apiVersion: v1',
    'kind: AgentDefinition',
    'metadata:',
    `  name: ${slug}`,
    `  slug: ${slug}`,
    '  version: 1.0.0',
    '  description: hub 分发的演示 agent',
    "  iconEmoji: '🤖'",
    'spec:',
    '  type: standalone',
    '  runtime: declarative',
    '  declarative:',
    '    systemPrompt: 你是一个来自 momo-hub 的演示 agent',
    '    model:',
    '      provider: anthropic',
    '      model: claude-3-5-sonnet',
    '  defaultTools:',
    '    - kind: builtin',
    '      ref: read_file',
    '    - kind: builtin',
    '      ref: bash',
    '    - kind: builtin',
    '      ref: git_commit',
    '',
  ].join('\n');
  return packTarGz({ 'manifest.yaml': manifest });
}

/** skill 真包：SKILL.md（frontmatter + 正文） */
function skillPackage(slug: string): Buffer {
  const skillMd = [
    '---',
    `name: ${slug}`,
    'description: hub 分发的演示技能',
    'version: 1.0.0',
    '---',
    '',
    '# 演示技能',
    '',
    '正文。',
    '',
  ].join('\n');
  return packTarGz({ 'SKILL.md': skillMd });
}

/** mcp 真包：package.json（npm 名合法——注册时过 isValidNpmPackageName） */
function mcpPackage(slug: string, npmName: string): Buffer {
  const pkg = JSON.stringify({ name: npmName, version: '1.0.0', description: 'hub 分发的演示 MCP' }, null, 2);
  return packTarGz({ 'package.json': pkg });
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 目录条目 → hub catalog 元数据（协议包 validateHubCatalog 的字段集） */
function catalogItem(fixture: HubFixture, downloadHost: string): Record<string, unknown> {
  return {
    slug: fixture.slug,
    type: fixture.type,
    name: fixture.name,
    version: fixture.version,
    author: 'node-e2e',
    description: `hub 分发的 ${fixture.type} 演示条目`,
    readme: `# ${fixture.name}`,
    tags: ['e2e'],
    category: 'dev',
    iconEmoji: '🧪',
    verificationStatus: 'unverified',
    // catalog 自报的绝对地址（host 不可信——RM1-12 要求重写基址为 studio 自身 hubUrl）
    downloadUrl: `${downloadHost}/resources/${fixture.slug}/${fixture.version}/download`,
    checksum: fixture.checksum,
    sizeBytes: fixture.archive.length,
    publishedAt: 1_700_000_000_000,
    versions: [fixture.version],
  };
}

/**
 * 起真 mock hub（catalog + download 真字节流）。
 * 鉴权仿真（D1 保真锁——真实 hub 语义 spec §3.1：三个资源端点全部 Bearer 鉴权）：
 * 无 / 错 Bearer 一律 401，不进业务 responder。默认期望 token 与注入的 hub
 * 上下文一致（tok-e2e）；setExpectedAuth 可运行中轮换（仿真凭证失效）。
 */
async function startMockHub(expectedAuth: string = 'tok-e2e'): Promise<MockHub> {
  let auth = expectedAuth;
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    hubRequests.push(url);
    hubAuths.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${auth}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (url === '/resources/catalog') {
      const items = [...fixtures.values()].map((f) => catalogItem(f, 'http://untrusted.example.com'));
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
  return {
    url: `http://127.0.0.1:${addr.port}`,
    setExpectedAuth(token: string): void {
      auth = token;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 真 fetch（模块加载时捕获——测试内的 fetch 拦截层一律委托回它，避免自调用递归） */
const REAL_FETCH = globalThis.fetch;

/** marketplace 远程目录禁网（fetch 拦截 → 回退本地 catalog.json，零真实外网） */
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

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  fixtures.clear();
  hubRequests = [];
  hubAuths = [];
  __resetTrustedDownloadOriginsForTest();
  __resetCatalogCacheForTest();
  blockMarketplaceNetwork();

  fixtures.set('hub-e2e-agent', {
    slug: 'hub-e2e-agent',
    type: 'agent',
    name: '演示 Agent',
    version: '1.0.0',
    archive: agentPackage('hub-e2e-agent'),
    checksum: '',
  });
  fixtures.get('hub-e2e-agent')!.checksum = sha256(fixtures.get('hub-e2e-agent')!.archive);

  fixtures.set('hub-e2e-skill', {
    slug: 'hub-e2e-skill',
    type: 'skill',
    name: '演示技能',
    version: '1.0.0',
    archive: skillPackage('hub-e2e-skill'),
    checksum: '',
  });
  fixtures.get('hub-e2e-skill')!.checksum = sha256(fixtures.get('hub-e2e-skill')!.archive);

  fixtures.set('hub-e2e-mcp', {
    slug: 'hub-e2e-mcp',
    type: 'mcp',
    name: '演示 MCP',
    version: '1.0.0',
    archive: mcpPackage('hub-e2e-mcp', 'e2e-mcp-server'),
    checksum: '',
  });
  fixtures.get('hub-e2e-mcp')!.checksum = sha256(fixtures.get('hub-e2e-mcp')!.archive);

  hub = await startMockHub();
  // 注入 hub 上下文（hubUrl + deviceToken）——唯一测试缝，其余全真
  __setHubContextResolverForTest(async () => ({ hubUrl: hub!.url, deviceToken: 'tok-e2e' }));
});

afterEach(async () => {
  __setHubContextResolverForTest(null);
  if (hub) {
    await hub.close();
    hub = null;
  }
  vi.restoreAllMocks();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('T10 e2e：hub→安装全链（agent / skill / mcp）', () => {
  it('agent 真包 → agent_definitions 落行 + 越权 defaultTools 钳制生效', async () => {
    await installHubPackage('agent', 'hub-e2e-agent');

    const def = listAgentDefinitions().find((d) => d.slug === 'hub-e2e-agent');
    expect(def).toBeDefined();
    // hub 包走 marketplace 安装语义（spec §6.2 原样复用 installPackage）——
    // agent 定义的 source 域枚举无 'hub'，hub 出身由资源项 source='hub' 承载
    expect(def!.source).toBe('marketplace');
    expect(def!.systemPrompt).toContain('momo-hub');

    // 越权工具被剔除（bash / git_commit 非安全最小集）
    const refs = def!.defaultTools.map((t) => t.ref);
    expect(refs).not.toContain('bash');
    expect(refs).not.toContain('git_commit');
    // 安全工具保留，且结果整体落在安全最小集内
    expect(refs).toContain('read_file');
    expect(refs.every((r) => SAFE_MINIMUM_TOOLS.includes(r))).toBe(true);

    // 记账：installed_packages.item_id = `hub:{slug}`（零 schema 变更区分来源）
    const row = getDb()
      .prepare('SELECT item_id, item_type, slug, version FROM installed_packages WHERE item_id = ?')
      .get(hubPackageItemId('hub-e2e-agent')) as
      | { item_id: string; item_type: string; slug: string; version: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.item_type).toBe('agent');
    expect(row!.slug).toBe('hub-e2e-agent');
    expect(row!.version).toBe('1.0.0');
  });

  it('skill 真包 → skill_definitions 落行', async () => {
    await installHubPackage('skill', 'hub-e2e-skill');

    const row = getDb()
      .prepare('SELECT name, slug, version, cache_path FROM skill_definitions WHERE slug = ?')
      .get('hub-e2e-skill') as
      | { name: string; slug: string; version: string; cache_path: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.slug).toBe('hub-e2e-skill');
    expect(row!.name).toBe('演示技能');
    expect(row!.version).toBe('1.0.0');
    expect(fs.existsSync(path.join(row!.cache_path, 'SKILL.md'))).toBe(true);
  });

  it('mcp 真包（合法 npm 名）→ mcp_definitions 注册（名取 package.json）', async () => {
    await installHubPackage('mcp', 'hub-e2e-mcp');

    const registered = listRegistered().find((m) => m.name === 'e2e-mcp-server');
    expect(registered).toBeDefined();
    expect(registered!.command).toBe('npx');
    expect(registered!.args).toEqual(['e2e-mcp-server']);
    // hub 包走 marketplace 安装语义（spec §6.2）
    expect(registered!.source).toBe('marketplace');
  });

  it('checksum 不匹配 → 拒绝安装 + cache 清理（不落库、不注册）', async () => {
    const bad = agentPackage('hub-e2e-bad');
    fixtures.set('hub-e2e-bad', {
      slug: 'hub-e2e-bad',
      type: 'agent',
      name: '坏包 Agent',
      version: '1.0.0',
      archive: bad,
      // 目录自报另一个校验和 → 与实际归档字节不符
      checksum: 'f'.repeat(64),
    });

    await expect(installHubPackage('agent', 'hub-e2e-bad')).rejects.toThrow(/Checksum 不匹配/);

    // cache 目录已清理（安装器在校验失败时删半成品目录）
    const cacheDir = path.join(resolveUserDataDir(), 'cache', 'agents', 'hub-e2e-bad', '1.0.0');
    expect(fs.existsSync(cacheDir)).toBe(false);
    // 不落账、不注册
    const row = getDb()
      .prepare('SELECT id FROM installed_packages WHERE item_id = ?')
      .get(hubPackageItemId('hub-e2e-bad'));
    expect(row).toBeUndefined();
    expect(listAgentDefinitions().find((d) => d.slug === 'hub-e2e-bad')).toBeUndefined();
  });

  it('hub origin http（非 https）→ 信任集放行，下载真的打到 mock hub', async () => {
    // 目录项 downloadUrl 经 RM1-12 重写为 studio 自身配置的 hubUrl（http 明文自托管）
    const items = await listHubCatalogResources('agent');
    const item = items.find((i) => i.slug === 'hub-e2e-agent');
    expect(item).toBeDefined();
    expect(item!.marketplace?.downloadUrl).toBe(
      `${hub!.url}/resources/hub-e2e-agent/1.0.0/download`,
    );
    // http 地址靠信任集放行（https 恒放行之外的唯一通路）
    expect(item!.marketplace?.downloadUrl.startsWith('http://')).toBe(true);
    expect(isTrustedDownloadUrl(item!.marketplace!.downloadUrl)).toBe(true);

    await installHubPackage('agent', 'hub-e2e-agent');

    // 下载请求真的到达 mock hub（catalog 自报的 untrusted host 未被采信）
    expect(hubRequests).toContain('/resources/hub-e2e-agent/1.0.0/download');
    expect(hubRequests.some((u) => u.includes('untrusted.example.com'))).toBe(false);
    // D1 锁：下载请求与目录请求同凭证（Bearer 随下载链发出——鉴权仿真层放行即证明）
    const dlIdx = hubRequests.indexOf('/resources/hub-e2e-agent/1.0.0/download');
    expect(hubAuths[dlIdx]).toBe('Bearer tok-e2e');
  });
});

describe('T10 e2e：D1 下载链鉴权（错误路径专项）', () => {
  /** 由目录 fixture 构造可直接喂 installPackage 的 MarketplaceItem（不经目录链） */
  function directInstallItem(): Parameters<typeof installPackage>[0] {
    const fixture = fixtures.get('hub-e2e-agent')!;
    return {
      id: hubPackageItemId(fixture.slug),
      type: fixture.type,
      slug: fixture.slug,
      name: fixture.name,
      version: fixture.version,
      author: 'node-e2e',
      description: '',
      readme: '',
      tags: [],
      category: '',
      iconEmoji: '',
      verificationStatus: 'unverified',
      downloadUrl: `${hub!.url}/resources/${fixture.slug}/${fixture.version}/download`,
      checksum: fixture.checksum,
      sizeBytes: fixture.archive.length,
      installCount: 0,
    };
  }

  it('下载请求无凭证（downloadFile 不带 headers）→ mock hub 401 → 安装失败人话 + 不落账', async () => {
    // 先拉目录暖信任集（hub origin 注册进 installer——真实时序：用户先浏览目录
    // 再安装）。随后直连 installPackage 不传 headers——D1 修复前的真实形态（裸
    // fetch 无 Authorization 打全鉴权 hub）。仿真层 401 → 人话错误（含鉴权提示）。
    await listHubCatalogResources('agent');
    await expect(installPackage(directInstallItem())).rejects.toThrow(
      /下载失败: HTTP 401（鉴权失败/,
    );

    // 下载确实打到了 mock hub 且无 Bearer
    const dlIdx = hubRequests.indexOf('/resources/hub-e2e-agent/1.0.0/download');
    expect(dlIdx).toBeGreaterThanOrEqual(0);
    expect(hubAuths[dlIdx]).toBeUndefined();
    // 不落账、不注册
    const row = getDb()
      .prepare('SELECT id FROM installed_packages WHERE item_id = ?')
      .get(hubPackageItemId('hub-e2e-agent'));
    expect(row).toBeUndefined();
    expect(listAgentDefinitions().find((d) => d.slug === 'hub-e2e-agent')).toBeUndefined();
  });

  it('凭证中途失效（hub 轮换 token）→ 下载 401 → 安装失败人话 + 不落账', async () => {
    // 先拉目录建立 TTL 缓存（token 合法）——仿真真实时序：目录已缓存，hub 侧
    // 轮换 token 后安装，目录零网络直返，下载持旧 token 打真端点 → 401
    await listHubCatalogResources('agent');
    hub!.setExpectedAuth('tok-rotated');

    await expect(installHubPackage('agent', 'hub-e2e-agent')).rejects.toThrow(
      /下载失败: HTTP 401（鉴权失败/,
    );

    const dlIdx = hubRequests.indexOf('/resources/hub-e2e-agent/1.0.0/download');
    expect(hubAuths[dlIdx]).toBe('Bearer tok-e2e');
    const row = getDb()
      .prepare('SELECT id FROM installed_packages WHERE item_id = ?')
      .get(hubPackageItemId('hub-e2e-agent'));
    expect(row).toBeUndefined();
  });
});

describe('T10 e2e：resource:list 并入 hub 已装项 + 五源并列', () => {
  it('安装后 hub 条目进入 resource:list（source=hub / installed=true / 可卸载）', async () => {
    await installHubPackage('agent', 'hub-e2e-agent');

    const hubItems = await listResources({ source: 'hub' });
    const item = hubItems.find((i) => i.id === 'hub-agent-hub-e2e-agent');
    expect(item).toBeDefined();
    expect(item!.source).toBe('hub');
    expect(item!.installed).toBe(true);
    expect(item!.installable).toBe(false);
    expect(item!.removable).toBe(true);
    expect(item!.version).toBe('1.0.0');

    // 未装条目也在目录面（可装）——marketplace 同款口径
    const all = await listResources({ type: 'agent' });
    const uninstalled = all.find((i) => i.id === 'hub-agent-hub-e2e-agent');
    expect(uninstalled).toBeDefined();
  });

  it('五源并列：builtin / marketplace / custom / smithery / hub 同时在场互不遮蔽', async () => {
    // marketplace 远程目录 → 本地 catalog（内置项 + 一个远程项）
    const localCatalog = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../../resources/marketplace/catalog.json'),
        'utf-8',
      ),
    ) as { version: string; updatedAt: string; items: Array<Record<string, unknown>> };
    const remoteItem = {
      id: 'mcp-remote-demo',
      type: 'mcp',
      slug: 'remote-demo',
      name: '网络 Demo',
      version: '1.0.0',
      author: 'Momo Studio',
      description: '网络来源的演示 MCP',
      readme: '# 网络 Demo',
      tags: [],
      category: 'dev',
      iconEmoji: '🔌',
      verificationStatus: 'community',
      downloadUrl: 'https://example.com/remote-demo.tar.gz',
      checksum: 'a'.repeat(64),
      sizeBytes: 1,
      installCount: 0,
    };
    const builtinMcp = {
      id: 'mcp-builtin-demo',
      type: 'mcp',
      slug: 'builtin-demo',
      name: '预置 Demo',
      version: '1.0.0',
      author: 'Momo Studio',
      description: '预置的演示 MCP',
      readme: '# 预置 Demo',
      tags: [],
      category: 'dev',
      iconEmoji: '🧩',
      verificationStatus: 'official',
      downloadUrl: '',
      checksum: '',
      sizeBytes: 1,
      installCount: 0,
    };
    const catalog = {
      version: localCatalog.version,
      updatedAt: localCatalog.updatedAt,
      items: [...localCatalog.items, remoteItem, builtinMcp],
    };
    // 远程目录被禁网 → 回退本地文件；此处改写本地文件不可行，改为直接注入
    // fetch 拦截层：marketplace 目录请求返回上面的合成目录，hub 请求照常真发。
    const origFetch = REAL_FETCH;
    vi.mocked(globalThis.fetch).mockImplementation(((
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('raw.githubusercontent.com')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => catalog,
        } as unknown as Response);
      }
      return origFetch(input, init);
    }) as typeof fetch);

    // custom MCP
    registerMcpDefinition({
      id: 'custom-mcp-demo',
      name: 'custom-demo',
      version: '1.0.0',
      command: 'npx',
      args: ['custom-demo'],
      env: {},
      source: 'custom',
    });
    // smithery 已装 MCP（直连注册，零网络）
    const { installSmitheryRemote } = await import('../../src/main/resource/hub-install');
    await installSmitheryRemote('e2e-smithery', 'https://e2e.run.tools', {});
    // hub 已装 MCP（真包安装）
    await installHubPackage('mcp', 'hub-e2e-mcp');

    const items = await listResources({ type: 'mcp' });
    const bySource = new Map(items.map((i) => [i.source, i]));
    expect([...bySource.keys()].sort()).toEqual([
      'builtin',
      'custom',
      'hub',
      'marketplace',
      'smithery',
    ]);
    expect(bySource.get('hub')!.id).toBe('hub-mcp-hub-e2e-mcp');
    expect(bySource.get('hub')!.installed).toBe(true);
    expect(bySource.get('smithery')!.id).toBe('smithery-mcp-e2e-smithery');
    expect(bySource.get('custom')!.id).toBe('custom-mcp-custom-demo');
    expect(bySource.get('marketplace')!.id).toBe('marketplace-mcp-remote-demo');
    expect(bySource.get('builtin')!.id).toBe('builtin-mcp-builtin-demo');
  });

  it('hub 未接入（未配置）→ 目录空 + degraded=false + resource:list 无 hub 项', async () => {
    __setHubContextResolverForTest(async () => null);

    expect(await listHubCatalogResources('agent')).toEqual([]);
    expect(isHubCatalogDegraded()).toBe(false);
    const hubItems = await listResources({ source: 'hub' });
    expect(hubItems).toEqual([]);
  });

  it('卸载 hub 已装项 → 记账与缓存目录同删（item_id 前缀寻址）', async () => {
    await installHubPackage('skill', 'hub-e2e-skill');
    const cachePath = (
      getDb()
        .prepare('SELECT cache_path FROM installed_packages WHERE item_id = ?')
        .get(hubPackageItemId('hub-e2e-skill')) as { cache_path: string }
    ).cache_path;
    expect(fs.existsSync(cachePath)).toBe(true);

    uninstallHubPackage('skill', 'hub-e2e-skill');

    expect(fs.existsSync(cachePath)).toBe(false);
    const row = getDb()
      .prepare('SELECT id FROM installed_packages WHERE item_id = ?')
      .get(hubPackageItemId('hub-e2e-skill'));
    expect(row).toBeUndefined();
  });
});
