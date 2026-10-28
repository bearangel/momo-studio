// electron/tests/hub/publish.test.ts
//
// 发布编排（momo-hub M1 spec §6.4 / Task 13）：四类打包 + multipart 上传 + 人话错误 +
// C3 范围守卫 + IPC/推送接线。矩阵：
//   1. buildPublishPackage 四类形态（agent manifest.yaml 可逆解析 / skill 目录整包 /
//      mcp stub npm 名合法 / plugin 委派 T11）
//   2. publishToHub 错误映射矩阵（mock fetch：409/413/401/网络/400/201 回执）
//   3. multipart part 顺序（manifest 先于 package——hub 端 T6 定序依赖）+ Bearer 鉴权
//   4. C3 守卫（marketplace agent 拒 / 非 custom agent 拒 / url mcp 拒 / 非 npx mcp 拒 /
//      marketplace mcp 拒 / slug 非法拒 / readme 超限拒）
//   5. 非 online 拒（hub 未连接人话）
//   6. IPC 接线（hub:publishResource 注册 + 透传）+ manager onEvent
//      resource.published → hub:resourcePublished 推送链（manager mock 模式）
//
// 环境注：真实 DB + 真实 fs（AP_USER_DATA_DIR 注入）；manager 依赖（client/config-store）
// 用替身接管——publishToHub 的 HTTP 面经 deps.fetchImpl 注入（mock 只收窄在进程/网络边界）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { parseAgentManifest } from '../../src/main/agent/manifest-parser';
import { saveAgentDefinition } from '../../src/main/agent/crud';
import { createProvider } from '../../src/main/agent/provider-crud';
import { registerMcpDefinition } from '../../src/main/mcp/host-manager';
import { upsertPlugin } from '../../src/main/plugin/registry';
import { isValidNpmPackageName } from '../../src/main/marketplace/types';
import { EVT, type EventEnvelope } from '../../src/main/hub/protocol';
import type { PublishDeps, ResponseLike } from '../../src/main/hub/publish';

// ── manager 依赖替身（manager.test.ts 同款模式）────────────────────────────
// createHubClient 替身复刻真实状态语义：onStateChange 回调先更新 rec.state 再上抛
// ——publishToHub 的「非 online 拒」守卫读 hubGetStatus().state，依赖此语义。

interface CapturedOpts {
  url: string;
  nodeName: string;
  deviceToken: string;
  onStateChange(state: string, err?: string): void;
  onEvent(evt: EventEnvelope): void;
  onHelloSnapshot?: (nodes: Array<{ nodeId: string; nodeName: string }>) => void;
}

interface CapturedClient {
  opts: CapturedOpts;
  state: string;
  starts: number;
  stops: number;
}

const m = vi.hoisted(() => ({
  sent: [] as Array<{ channel: string; payload: unknown }>,
  clients: [] as CapturedClient[],
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...args: unknown[]) => unknown) => m.handlers.set(ch, fn),
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: unknown): void => {
            m.sent.push({ channel, payload });
          },
        },
      },
    ],
  },
}));

vi.mock('../../src/main/hub/client', () => ({
  createHubClient: (opts: CapturedOpts) => {
    const rec: CapturedClient = { opts, state: 'disconnected', starts: 0, stops: 0 };
    // 包一层：替身先落状态再回调（对齐真实 client 的 setState 语义）
    const orig = opts.onStateChange;
    opts.onStateChange = (state: string, err?: string): void => {
      rec.state = state;
      orig(state, err);
    };
    m.clients.push(rec);
    return {
      start: (): void => { rec.starts += 1; rec.state = 'connecting'; },
      stop: (): void => { rec.stops += 1; rec.state = 'disconnected'; },
      state: (): string => rec.state,
      hubProtoVer: (): string | null => null,
      // 查看同意上报链（M2e T14）在 online 回调发起 view.consent——桩补 request 面
      request: async (): Promise<unknown> => ({ ok: true }),
    };
  },
  enrollOverHttp: vi.fn(async () => ({ nodeId: 'node-1', deviceToken: 'tok-1' })),
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import * as manager from '../../src/main/hub/index';
import { registerHubIpc } from '../../src/main/hub/ipc.handlers';
import { buildPublishPackage, publishToHub, tarDirectory } from '../../src/main/hub/publish';

// ── 环境脚手架 ────────────────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-hubpub-'));
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) { memStore.set(k, v); },
  async getSecret(k) { return memStore.get(k) ?? null; },
  async deleteSecret(k) { memStore.delete(k); },
};

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();
  await manager.hubForget(); // 模块级单例复位（停连接 + 清配置 + 清凭证）
  m.sent.length = 0;
  m.clients.length = 0;
  m.handlers.clear();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

/** enroll 到 mock hub 并把连接推到 online（publishToHub 的发布面守卫放行态） */
async function goOnline(): Promise<void> {
  await manager.hubEnroll({ hubUrl: 'http://hub.test', enrollmentToken: 't', nodeName: 'studio-node' });
  m.clients[m.clients.length - 1]!.opts.onStateChange('online');
}

/** tar 成员清单（剥目录尾条目，只留文件成员） */
function tarList(archivePath: string): string[] {
  return execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf-8' })
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.endsWith('/'));
}

/** 从归档取单个文件内容（tar -xO 原样输出） */
function tarRead(archivePath: string, member: string): string {
  return execFileSync('tar', ['-xOzf', archivePath, member], { encoding: 'utf-8' });
}

/** mock fetch 应答构造 */
function res(status: number, body: unknown): ResponseLike {
  return { status, json: async () => body };
}

/** 落一个 custom agent 定义（source 可注入；返回 id） */
function seedAgent(id: string, slug: string, source: 'custom' | 'marketplace' | 'builtin' = 'custom'): string {
  saveAgentDefinition({
    id, name: `${slug}-name`, slug, version: '1.2.0', runtime: 'declarative',
    systemPrompt: '你是发布助手', defaultTools: [], source,
    description: '发布测试 agent', iconEmoji: '🚀',
    defaultMcps: [], defaultSkills: [], workspaceId: null,
    modelProviderId: null, modelName: 'gpt-4o',
  });
  return id;
}

/** 落一个 custom skill 上传目录（.sha256 标记 + 资源文件） */
function seedCustomSkill(slug: string, version = '0.3.0'): string {
  const dir = path.join(tmpRoot, 'skills', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${slug} 名\ndescription: 自定义 skill\nversion: ${version}\n---\n\n正文内容。\n`,
  );
  fs.writeFileSync(path.join(dir, 'notes.txt'), '附加资源');
  fs.writeFileSync(path.join(dir, '.sha256'), 'deadbeef');
  return dir;
}

/** 落一个 marketplace 装面 skill（installer.registerInstalledPackage 同款形态）：
 *  版本化 cache 目录 <userData>/cache/skills/<slug>/<version>（.installed 标记 +
 *  SKILL.md）+ skill_definitions 行（cache_path 指向版本化目录——basename 是版本号）。 */
function seedMarketplaceSkill(slug: string, version: string): string {
  const cachePath = path.join(tmpRoot, 'cache', 'skills', slug, version);
  fs.mkdirSync(cachePath, { recursive: true });
  fs.writeFileSync(
    path.join(cachePath, 'SKILL.md'),
    `---\nname: ${slug} 名\ndescription: marketplace 装面 skill\nversion: ${version}\n---\n\n正文内容。\n`,
  );
  fs.writeFileSync(path.join(cachePath, '.installed'), new Date().toISOString());
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO skill_definitions
       (id, name, slug, version, description, allowed_tools, cache_path, tags)
       VALUES (?, ?, ?, ?, ?, '[]', ?, '[]')`,
    )
    .run(randomUUID(), `${slug} 名`, slug, version, 'marketplace 装面 skill', cachePath);
  return cachePath;
}

/** 落一个 dev 插件目录并注册（publish-pack.test.ts 同款最小合法插件） */
function seedPlugin(id: string): string {
  const dir = path.join(tmpRoot, 'plugins');
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'momo-plugin.json'),
    JSON.stringify({
      id, name: `${id} 插件`, version: '0.1.0', description: '发布测试插件',
      components: { tools: './tools' },
    }),
  );
  fs.writeFileSync(path.join(dir, 'tools', 'main.js'), 'module.exports.createTools = () => ({});');
  upsertPlugin({
    id, version: '0.1.0',
    manifestJson: JSON.stringify({ id, version: '0.1.0' }),
    state: 'active', source: 'dev', sourcePath: path.resolve(dir),
    installedAt: new Date().toISOString(),
  });
  return dir;
}

// ── 1. buildPublishPackage 四类形态 ────────────────────────────────────────
describe('buildPublishPackage 四类打包', () => {
  it('agent：custom 定义 → manifest.yaml + README.md；manifest 可被 parseAgentManifest 逆解析', async () => {
    seedAgent('def-pub', 'pub-agent');
    const r = await buildPublishPackage('agent', 'def-pub', {});

    const list = tarList(r.archivePath);
    expect(list).toContain('manifest.yaml');
    expect(list).toContain('README.md');

    const def = parseAgentManifest(tarRead(r.archivePath, 'manifest.yaml'));
    expect(def.name).toBe('pub-agent-name');
    expect(def.slug).toBe('pub-agent');
    expect(def.version).toBe('1.2.0');
    expect(def.systemPrompt).toBe('你是发布助手');
    expect(def.modelName).toBe('gpt-4o');
    expect(def.source).toBe('custom'); // parseAgentManifest 恒产 custom——安装侧再覆写

    // 发布 manifest 形状（协议字段全量 + author 回填 + unverified）
    expect(r.manifest).toMatchObject({
      slug: 'pub-agent', type: 'agent', name: 'pub-agent-name',
      version: '1.2.0', verificationStatus: 'unverified',
      author: 'momo-studio', // 未接入时 nodeName null → 兜底
    });
  });

  it('agent：modelProviderId 解析出平台（anthropic provider → manifest provider=anthropic）', async () => {
    const prov = await createProvider({
      name: 'Anthropic 直连', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-test', platform: 'anthropic',
    });
    saveAgentDefinition({
      id: 'def-ant', name: 'A', slug: 'ant-agent', version: '1.0.0', runtime: 'declarative',
      systemPrompt: 'p', defaultTools: [], source: 'custom', description: 'd', iconEmoji: '🤖',
      defaultMcps: [], defaultSkills: [], workspaceId: null,
      modelProviderId: prov.id, modelName: 'claude-3-5-sonnet',
    });
    const r = await buildPublishPackage('agent', 'def-ant', {});
    // provider 不进 AgentDefinition（yaml 只留 model.model）——经 manifest.yaml 原文断言
    expect(tarRead(r.archivePath, 'manifest.yaml')).toContain('provider: anthropic');
    expect(() => parseAgentManifest(tarRead(r.archivePath, 'manifest.yaml'))).not.toThrow();
  });

  it('skill：cachePath 目录 → tar.gz 含 SKILL.md 与资源文件，排除安装标记', async () => {
    seedCustomSkill('my-skill');
    const r = await buildPublishPackage('skill', 'my-skill', {});

    const list = tarList(r.archivePath);
    expect(list).toContain('SKILL.md');
    expect(list).toContain('notes.txt');
    expect(list).not.toContain('.sha256'); // 安装侧标记不入包
    expect(r.manifest).toMatchObject({ slug: 'my-skill', type: 'skill', version: '0.3.0' });
  });

  it('mcp：npx 形态 → package.json stub，npm 名合法（安装侧 npx <name> 可复原）', async () => {
    registerMcpDefinition({
      id: randomUUID(), name: 'my-tools', version: '1.0.1',
      command: 'npx', args: ['@scope/tool-server'], source: 'custom',
    });
    const r = await buildPublishPackage('mcp', 'my-tools', {});

    expect(tarList(r.archivePath)).toEqual(['package.json']);
    const pkg = JSON.parse(tarRead(r.archivePath, 'package.json')) as { name: string; version: string };
    expect(pkg.name).toBe('@scope/tool-server');
    expect(isValidNpmPackageName(pkg.name)).toBe(true);
    expect(pkg.version).toBe('1.0.1');
    expect(r.manifest).toMatchObject({ slug: 'my-tools', type: 'mcp', version: '1.0.1' });
  });

  it('plugin：委派 packPluginForPublish（归档含 momo-plugin.json，slug 取插件 id）', async () => {
    seedPlugin('pub-plugin');
    const r = await buildPublishPackage('plugin', 'pub-plugin', {});

    expect(tarList(r.archivePath)).toContain('momo-plugin.json');
    expect(r.manifest).toMatchObject({ slug: 'pub-plugin', type: 'plugin', version: '0.1.0' });
  });

  it('meta 覆盖：name/version/readme/tags 进发布 manifest（本地定义仅兜底）', async () => {
    seedAgent('def-meta', 'meta-agent');
    const r = await buildPublishPackage('agent', 'def-meta', {
      name: '市场名', version: '2.0.0', readme: 'README 正文', tags: ['a', 'b'], category: '效率',
    });
    expect(r.manifest).toMatchObject({
      name: '市场名', version: '2.0.0', readme: 'README 正文', tags: ['a', 'b'], category: '效率',
    });
    // 归档内 README.md 同步用 meta.readme（人读面与目录元数据一致）
    expect(tarRead(r.archivePath, 'README.md')).toBe('README 正文');
  });
});

// ── 1b. marketplace 装面 skill 发布 slug 契约（M2.2 批1 Critical）──────────
// skill_definitions.cache_path 恒为版本化路径（…/<slug>/<version>，basename=版本号）。
// 发布 slug 若从 basename 推导会得到版本号：isValidHubSlug('1.4.0') 放行 → 静默
// 上传错名条目 + hub:{slug} 记账键与 collectSkills 反查键（skill_definitions.slug）
// 错位 → 镜像 resources 不携带。slug 语义来源必须是 skill_definitions 行的 slug 列。
describe('marketplace 装面 skill 发布 slug 契约', () => {
  it('marketplace 形态：manifest.slug = skill_definitions.slug（不是 cache_path 的 basename 版本号）', async () => {
    seedMarketplaceSkill('superpowers-brainstorm', '1.4.0');
    const r = await buildPublishPackage('skill', 'superpowers-brainstorm', {});

    expect(r.manifest.slug).toBe('superpowers-brainstorm');
    expect(r.manifest.version).toBe('1.4.0');
    expect(tarList(r.archivePath)).toContain('SKILL.md');
  });

  it('同版本多 skill 不互撞：两个 marketplace skill 同 version 1.4.0 → manifest slug 各异（+ custom 形态同版不撞）', async () => {
    seedMarketplaceSkill('superpowers-brainstorm', '1.4.0');
    seedMarketplaceSkill('code-reviewer', '1.4.0');
    seedCustomSkill('my-skill', '1.4.0');

    const a = await buildPublishPackage('skill', 'superpowers-brainstorm', {});
    const b = await buildPublishPackage('skill', 'code-reviewer', {});
    const c = await buildPublishPackage('skill', 'my-skill', {});

    expect(a.manifest.slug).toBe('superpowers-brainstorm');
    expect(b.manifest.slug).toBe('code-reviewer');
    expect(c.manifest.slug).toBe('my-skill');
    expect(new Set([a.manifest.slug, b.manifest.slug, c.manifest.slug]).size).toBe(3);
  });

  it('端到端键一致性锁：发布回执 slug（hub:{slug} 记账键）== skill_definitions.slug（collectSkills 反查键）', async () => {
    await goOnline();
    seedMarketplaceSkill('superpowers-brainstorm', '1.4.0');
    registerHubIpc();

    // 仿真 hub T6 行为：解析 manifest part，201 回执按 manifest 权威回 echo slug
    const fetchMock = vi.fn(async (_url: string, init: { body: FormData }) => {
      const manifestPart = Array.from(init.body.entries()).find(([k]) => k === 'manifest')!;
      const sent = JSON.parse(await (manifestPart[1] as Blob).text()) as { slug: string; version: string };
      return res(201, { slug: sent.slug, version: sent.version, checksum: 'a'.repeat(64), sizeBytes: 1 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      // 走真实 IPC 编排：publishToHub → recordPublishAccountingSafe(result.slug, …)
      const out = await m.handlers.get('hub:publishResource')!(null, {
        type: 'skill', ref: 'superpowers-brainstorm',
      });
      expect(out).toMatchObject({ slug: 'superpowers-brainstorm', version: '1.4.0' });

      const accRows = getDb()
        .prepare("SELECT item_id FROM installed_packages WHERE item_type = 'skill'")
        .all() as Array<{ item_id: string }>;
      const defRow = getDb()
        .prepare("SELECT slug FROM skill_definitions WHERE slug = 'superpowers-brainstorm'")
        .get() as { slug: string };

      // 记账键 hub:{slug} 必须命中 collectSkills 的反查键（skill_definitions.slug）
      expect(accRows.map((r) => r.item_id)).toEqual([`hub:${defRow.slug}`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── 2. publishToHub 错误映射矩阵 + multipart 契约 ───────────────────────────
describe('publishToHub', () => {
  it('非 online 拒：hub 未连接人话（未接入即拒，不触打包）', async () => {
    seedCustomSkill('guard-skill');
    await expect(publishToHub({ type: 'skill', ref: 'guard-skill' })).rejects.toThrow(/hub 未连接/);
  });

  it('201：回执透传 {slug,version,checksum,sizeBytes}；归档上传后清理', async () => {
    await goOnline();
    seedCustomSkill('ok-skill');
    const calls: Array<{ url: string; init: { headers: Record<string, string>; body: FormData } }> = [];
    const deps: PublishDeps = {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return res(201, { slug: 'ok-skill', version: '0.3.0', checksum: 'c'.repeat(64), sizeBytes: 42 });
      },
    };
    const out = await publishToHub({ type: 'skill', ref: 'ok-skill' }, deps);
    expect(out).toEqual({ slug: 'ok-skill', version: '0.3.0', checksum: 'c'.repeat(64), sizeBytes: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://hub.test/resources/publish');
    expect(calls[0]!.init.headers.authorization).toBe('Bearer tok-1'); // mock enroll 派生 token
  });

  it('multipart 定序：manifest part 先于 package part（hub 端 T6 契约）+ part 形状', async () => {
    await goOnline();
    seedCustomSkill('order-skill');
    let captured: FormData | null = null;
    const deps: PublishDeps = {
      fetchImpl: async (_url, init) => {
        captured = init.body;
        return res(201, { slug: 'order-skill', version: '0.3.0', checksum: 'x', sizeBytes: 1 });
      },
    };
    await publishToHub({ type: 'skill', ref: 'order-skill' }, deps);
    const entries = Array.from(captured!.entries());
    expect(entries.map(([k]) => k)).toEqual(['manifest', 'package']); // 顺序锁：manifest 在前
    const blobs = entries.map(([, v]) => v as Blob);
    const manifestBlob = blobs[0]!;
    const pkgBlob = blobs[1]!;
    expect(manifestBlob.type).toBe('application/json');
    const parsed = JSON.parse(await manifestBlob.text()) as { slug: string; type: string };
    expect(parsed.slug).toBe('order-skill');
    expect(parsed.type).toBe('skill');
    expect(pkgBlob.type).toBe('application/gzip');
    expect(pkgBlob.size).toBeGreaterThan(0);
  });

  it('409 → 该版本已存在（版本不可变）', async () => {
    await goOnline();
    seedCustomSkill('dup-skill');
    const deps: PublishDeps = { fetchImpl: async () => res(409, { error: 'version_exists' }) };
    await expect(publishToHub({ type: 'skill', ref: 'dup-skill' }, deps)).rejects.toThrow(/该版本已存在/);
  });

  it('413 → 超过 200MB 上限', async () => {
    await goOnline();
    seedCustomSkill('big-skill');
    const deps: PublishDeps = { fetchImpl: async () => res(413, { error: 'too_large' }) };
    await expect(publishToHub({ type: 'skill', ref: 'big-skill' }, deps)).rejects.toThrow(/200MB/);
  });

  it('401 → 连接已失效，请重新接入', async () => {
    await goOnline();
    seedCustomSkill('auth-skill');
    const deps: PublishDeps = { fetchImpl: async () => res(401, { error: 'unauthorized' }) };
    await expect(publishToHub({ type: 'skill', ref: 'auth-skill' }, deps)).rejects.toThrow(/连接已失效.*重新接入/);
  });

  it('网络异常（fetch 抛错）→ 无法连接 hub', async () => {
    await goOnline();
    seedCustomSkill('net-skill');
    const deps: PublishDeps = {
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    };
    await expect(publishToHub({ type: 'skill', ref: 'net-skill' }, deps)).rejects.toThrow(/无法连接 hub/);
  });

  it('其余非 201（如 400）→ hub 响应异常带状态码；失败同样清理归档', async () => {
    await goOnline();
    seedCustomSkill('bad-skill');
    let archiveSeen = '';
    const deps: PublishDeps = {
      fetchImpl: async (_url, init) => {
        // 经 package blob 尺寸旁证归档在场（失败路径也建了包）
        const pkg = Array.from(init.body.entries()).find(([k]) => k === 'package')!;
        archiveSeen = String((pkg[1] as Blob).size);
        return res(400, { error: 'invalid_manifest' });
      },
    };
    await expect(publishToHub({ type: 'skill', ref: 'bad-skill' }, deps)).rejects.toThrow(/hub 响应异常.*400/);
    expect(archiveSeen).not.toBe('');
    // 清理断言：tmp 下无 publish-* 残留
    const tmpDir = path.join(tmpRoot, 'tmp');
    if (fs.existsSync(tmpDir)) {
      expect(fs.readdirSync(tmpDir).filter((f) => f.startsWith('publish-'))).toEqual([]);
    }
  });
});

// ── 3. C3 范围守卫 + 入参校验 ──────────────────────────────────────────────
describe('C3 范围守卫与人话错误', () => {
  it('agent 非 custom（marketplace 安装）→ 拒绝', async () => {
    seedAgent('def-mkt', 'mkt-agent', 'marketplace');
    await expect(buildPublishPackage('agent', 'def-mkt', {})).rejects.toThrow(/仅自定义.*agent.*发布/);
  });

  it('agent 非 custom（builtin 预置）→ 拒绝', async () => {
    seedAgent('def-blt', 'blt-agent', 'builtin');
    await expect(buildPublishPackage('agent', 'def-blt', {})).rejects.toThrow(/仅自定义.*agent.*发布/);
  });

  it('agent slug 不在 hub 白名单（大写）→ 拒绝并给 slug 规则', async () => {
    seedAgent('def-bad', 'Bad_Agent'); // 大写 + 下划线（下划线合法、大写非法）
    await expect(buildPublishPackage('agent', 'def-bad', {})).rejects.toThrow(/slug 非法/);
  });

  it('mcp url 形态（streamable_http）→ 红线：url 形态 MCP 不可发布', async () => {
    registerMcpDefinition({
      id: randomUUID(), name: 'remote-mcp', version: '1.0.0',
      transport: 'streamable_http', url: 'https://x.test/mcp', command: '', args: [],
      source: 'custom',
    });
    await expect(buildPublishPackage('mcp', 'remote-mcp', {})).rejects.toThrow(/url 形态 MCP 不可发布/);
  });

  it('mcp stdio 非 npx 形态 → 拒绝（stub 只能复原 npx 包）', async () => {
    registerMcpDefinition({
      id: randomUUID(), name: 'local-bin', version: '1.0.0',
      command: '/usr/local/bin/server', args: [], source: 'custom',
    });
    await expect(buildPublishPackage('mcp', 'local-bin', {})).rejects.toThrow(/仅支持 npx 形态/);
  });

  it('mcp 非 custom（marketplace 安装）→ 拒绝', async () => {
    registerMcpDefinition({
      id: randomUUID(), name: 'mkt-mcp', version: '1.0.0',
      command: 'npx', args: ['some-pkg'], source: 'marketplace',
    });
    await expect(buildPublishPackage('mcp', 'mkt-mcp', {})).rejects.toThrow(/仅自定义.*MCP.*发布/);
  });

  it('目标不存在（agent / skill / mcp / plugin 四态人话）', async () => {
    await expect(buildPublishPackage('agent', 'nope', {})).rejects.toThrow(/agent 定义不存在/);
    await expect(buildPublishPackage('skill', 'nope', {})).rejects.toThrow(/skill 不存在/);
    await expect(buildPublishPackage('mcp', 'nope', {})).rejects.toThrow(/MCP 不存在/);
    await expect(buildPublishPackage('plugin', 'nope', {})).rejects.toThrow(/插件不存在/);
  });

  it('type 非法 / ref 为空 → 400 文案', async () => {
    await expect(buildPublishPackage('tool' as 'agent', 'x', {})).rejects.toThrow(/发布类型非法/);
    await expect(buildPublishPackage('agent', '', {})).rejects.toThrow(/ref 不能为空/);
  });

  it('readme 超 64KB → 客户端预校验拒绝（不白发 200MB）', async () => {
    seedAgent('def-big-readme', 'big-readme');
    await expect(
      buildPublishPackage('agent', 'def-big-readme', { readme: 'x'.repeat(64 * 1024 + 1) }),
    ).rejects.toThrow(/readme 超过 64KB/);
  });
});

// ── 4. IPC 接线 + resourcePublished 推送链 ─────────────────────────────────
describe('IPC 接线与推送链', () => {
  it('registerHubIpc 注册三十六通道（M1 发布 + M2b 工作组 + M2c 镜像 + M2.1 登记查询/路由提交/看板投影 + M2e 委派设置/task.*/查看八通道 + T12 本机等待清单 + 工作目录两通道 + M2.5 T3 节点清单补拉 + M3.1 远程代答）', () => {
    registerHubIpc();
    expect([...m.handlers.keys()].sort()).toEqual([
      'hub:configure', 'hub:delegationBoard', 'hub:enroll', 'hub:forget', 'hub:getDelegationSettings', 'hub:getNodes', 'hub:getStatus',
      'hub:getViewSettings', 'hub:getWorkspaceDirSettings', 'hub:groupCreate', 'hub:groupInvite', 'hub:groupJoin', 'hub:groupLeave', 'hub:groupList',
      'hub:groupTransfer', 'hub:localWaiting', 'hub:mirrorRegistry', 'hub:mirrorWorkspace', 'hub:publishResource', 'hub:retryDispatch', 'hub:routingPrecheck', 'hub:setDelegationSettings', 'hub:setViewSettings', 'hub:setWorkspaceDirSettings',
      'hub:snapshotBuildUpload', 'hub:submitRoutedTask', 'hub:taskAnswer', 'hub:taskCancel', 'hub:taskDelegate', 'hub:taskList',
      'hub:viewMessages', 'hub:viewSessions', 'hub:viewSubscribe', 'hub:viewTasks', 'hub:viewUnsubscribe', 'hub:viewWorkspace',
    ]);
  });

  it('hub:publishResource 透传 publishToHub（type 非法文案经 IPC rejection 透出）', async () => {
    registerHubIpc();
    await expect(
      m.handlers.get('hub:publishResource')!(null, { type: 'tool', ref: 'x' }),
    ).rejects.toThrow(/发布类型非法/);
  });

  it('hub:publishResource 非 online → hub 未连接（守卫在编排层生效）', async () => {
    registerHubIpc();
    seedCustomSkill('ipc-skill');
    await expect(
      m.handlers.get('hub:publishResource')!(null, { type: 'skill', ref: 'ipc-skill' }),
    ).rejects.toThrow(/hub 未连接/);
  });

  it('resource.published 事件 → 广播 hub:resourcePublished（载荷六字段原样）', async () => {
    await goOnline();
    m.sent.length = 0;
    m.clients[m.clients.length - 1]!.opts.onEvent({
      v: 1, kind: 'evt', method: EVT.resourcePublished,
      payload: { slug: 's1', type: 'skill', name: '技能', version: '1.0.0', author: 'peer', at: 123 },
    });
    expect(m.sent).toContainEqual({
      channel: 'hub:resourcePublished',
      payload: { slug: 's1', type: 'skill', name: '技能', version: '1.0.0', author: 'peer', at: 123 },
    });
  });
});

describe('T15a-F3：发布体积预检（tarDirectory 归档终检）', () => {
  function mkSrc(name: string, size: number): string {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'x'.repeat(size));
    return dir;
  }

  it('归档实际尺寸超注入上限 → 拒（人话错误）+ 半成品归档清理', async () => {
    const dir = mkSrc('size-cap-src', 4096);
    // 注入 16 字节上限走同一 tar + statSync 终检路径（生产默认 200MB 无法在单测造出）
    await expect(tarDirectory(dir, [], 'size-cap', 16)).rejects.toThrow(/资源包超过 200MB 上限/);
    const tmpDir = path.join(tmpRoot, 'tmp');
    const leftovers = fs.existsSync(tmpDir)
      ? fs.readdirSync(tmpDir).filter((f) => f.startsWith('publish-size-cap'))
      : [];
    expect(leftovers).toEqual([]);
  });

  it('上限内 → 放行并返回归档路径（生产默认常量路径）', async () => {
    const dir = mkSrc('size-ok-src', 64);
    const archivePath = await tarDirectory(dir, [], 'size-ok');
    expect(fs.existsSync(archivePath)).toBe(true);
    fs.rmSync(archivePath, { force: true });
  });
});
