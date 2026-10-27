// electron/tests/hub/snapshot-upload.test.ts
//
// 快照构建+上传编排矩阵（T8b leader 侧 S2）：
//   1. 全链成功：构建（真 DB/真 tar）→ knownSecrets 复检通过 → multipart 定序
//      （manifest part 先于 payload——hub T5 收包契约）→ checksum 对账 → 回执形状
//   2. knownSecrets 复检变异（T7 Minor#2）：keychain 实值（无形态特征）出现在
//      custom skill 文件 → 构建器形态扫描放行、上传复检拒传（fail-closed 零上路）
//   3. 错误映射人话：409 / 413 / 401 / 网络异常 / 非 201 异常 / 回执缺字段
//   4. checksum 对账不符 → 拒采用
//   5. 守卫：非 online（零构建零上传）
//
// 环境注：真实 DB + 真实 fs + 真实 tar（AP_USER_DATA_DIR）；mock 只收窄在 HTTP 边界
// （fetchImpl）与 hub client 状态（manager.test/publish.test 同款替身）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { saveAgentDefinition, addMember } from '../../src/main/agent/crud';
import { createProvider } from '../../src/main/agent/provider-crud';
import { createWorkspace } from '../../src/main/workspace/crud';
import { listInstalled } from '../../src/main/skill/zip-uploader';
import type { EventEnvelope } from '../../src/main/hub/protocol';

// —— manager 依赖替身（publish.test.ts 同款：createHubClient 捕获 opts，状态可推动）
const m = vi.hoisted(() => ({
  clients: [] as Array<{ opts: { onStateChange(state: string, err?: string): void }; state: string }>,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../src/main/hub/client', () => ({
  createHubClient: (opts: {
    onStateChange(state: string, err?: string): void;
    onEvent(evt: EventEnvelope): void;
  }) => {
    const rec = { opts, state: 'disconnected' };
    const orig = opts.onStateChange;
    opts.onStateChange = (state: string, err?: string): void => {
      rec.state = state;
      orig(state, err);
    };
    m.clients.push(rec as (typeof m.clients)[number]);
    return {
      start: (): void => { rec.state = 'connecting'; },
      stop: (): void => { rec.state = 'disconnected'; },
      state: (): string => rec.state,
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
import { buildAndUploadWorkspaceSnapshot, checksumShort } from '../../src/main/hub/snapshot-upload';
import type { SnapshotUploadDeps, UploadResponseLike } from '../../src/main/hub/snapshot-upload';

// ── 环境脚手架 ────────────────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-wsupload-'));
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
  await manager.hubForget(); // 模块级单例复位（清配置 + 清凭证 + 停连接）
  m.clients.length = 0;
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

/** enroll 到 mock hub 并推 online（上传面守卫放行态——publish.test goOnline 同款） */
async function goOnline(): Promise<void> {
  await manager.hubEnroll({ hubUrl: 'http://hub.test', enrollmentToken: 't', nodeName: 'studio-node' });
  m.clients[m.clients.length - 1]!.opts.onStateChange('online');
}

async function mkWorkspace(name: string): Promise<string> {
  const ws = await createWorkspace(
    { name, directoryPath: path.join(tmpRoot, `wsdir-${randomUUID().slice(0, 8)}`) },
    'owner',
  );
  return ws.id;
}

function seedCustomDef(slug: string): void {
  saveAgentDefinition({
    id: `def-${slug}`,
    name: slug,
    slug,
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: `你是 ${slug}`,
    defaultTools: [],
    source: 'custom',
    description: '',
    iconEmoji: '🤖',
    defaultMcps: [],
    defaultSkills: [],
    workspaceId: null,
    modelProviderId: null,
    modelName: 'glm-5.3',
  });
}

/** 落定义并加入工作空间（构建器读的是成员面——只落定义不成成员） */
async function seedMember(wsId: string, slug: string): Promise<void> {
  seedCustomDef(slug);
  await addMember(wsId, `def-${slug}`, `@${slug}:momo.local`);
}

/** mock fetch 应答构造 */
function res(status: number, body: unknown): UploadResponseLike {
  return { status, json: async () => body };
}

// ── skill 四桶 fixture（snapshot-builder.test.ts 同款形态）──────────────────

/** installed_packages 落一条 hub 记账行（item_id = `hub:{slug}`，M1 §6.2 形态） */
function seedHubAccounting(itemType: 'skill', slug: string): void {
  getDb()
    .prepare(
      `INSERT INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      `hub:${slug}`,
      itemType,
      slug,
      '1.0.0',
      path.join(tmpRoot, 'cache', slug),
      crypto.createHash('sha256').update(slug).digest('hex'),
    );
}

/** 落一个 custom skill 上传目录（内嵌桶——listInstalled 目录扫描识别为 custom） */
function seedCustomSkillDir(slug: string): void {
  const dir = path.join(tmpRoot, 'skills', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${slug} 名\ndescription: 内嵌 skill\nversion: 0.3.0\n---\n\n正文内容。`,
  );
  fs.writeFileSync(path.join(dir, '.sha256'), 'deadbeef');
}

/** skill_definitions 落一条 marketplace 安装行（hub 安装同表——无记账即纯目录桶） */
function seedMarketplaceSkillRow(slug: string): void {
  getDb()
    .prepare(
      `INSERT INTO skill_definitions (id, name, slug, version, description, cache_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), `${slug}-name`, slug, '1.0.0', '市场 skill', path.join(tmpRoot, 'cache', slug));
}

interface CapturedPart { name: string; blob: Blob }

/**
 * 捕获上传请求的 fetch 替身：成功应答按 payload part 实算 sha256（与本地构建器
 * 复算天然一致——对账路径真实走通，而非写死值）。
 */
function captureUploadFetch(): { deps: SnapshotUploadDeps; captured: Array<{ url: string; headers: Record<string, string>; parts: CapturedPart[] }> } {
  const captured: Array<{ url: string; headers: Record<string, string>; parts: CapturedPart[] }> = [];
  const deps: SnapshotUploadDeps = {
    fetchImpl: async (url, init) => {
      const parts = [...init.body.entries()].map(([name, v]) => ({ name, blob: v as Blob }));
      captured.push({ url, headers: init.headers, parts });
      const payload = parts.find((p) => p.name === 'payload')!;
      const checksum = crypto.createHash('sha256')
        .update(Buffer.from(await payload.blob.arrayBuffer()))
        .digest('hex');
      return res(201, { snapshotId: 'snap-returned', checksum });
    },
  };
  return { deps, captured };
}

describe('buildAndUploadWorkspaceSnapshot', () => {
  it('全链成功：构建 → 复检通过 → multipart 定序（manifest 先）→ checksum 对账 → 回执形状', async () => {
    const wsId = await mkWorkspace('上传空间');
    await seedMember(wsId, 'up-agent');
    await goOnline();

    const { deps, captured } = captureUploadFetch();
    const result = await buildAndUploadWorkspaceSnapshot(wsId, deps);

    expect(captured).toHaveLength(1);
    const up = captured[0]!;
    expect(up.url).toBe('http://hub.test/workspaces/snapshots');
    expect(up.headers.authorization).toBe('Bearer tok-1');
    // 定序契约（hub T5 collectManifestAndPayload）：manifest part 必须先于 payload
    expect(up.parts.map((p) => p.name)).toEqual(['manifest', 'payload']);
    const manifest = JSON.parse(await up.parts[0]!.blob.text()) as { workspaceName: string; version: string };
    expect(manifest.workspaceName).toBe('上传空间');
    expect(manifest.version).toBe(result.version);

    expect(result.snapshotId).toBe('snap-returned');
    expect(result.checksum).toHaveLength(64);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.summary.members).toBe(1);
    expect(result.summary.embeddedMembers).toBe(1);
    expect(result.summary.resources).toBe(0);
    // 无自定义/hub 记账 skill：分桶两计数为零（builtin 桶只进 skills 总数）
    expect(result.summary.skillResources).toBe(0);
    expect(result.summary.skillEmbedded).toBe(0);
    expect(checksumShort(result.checksum)).toBe(result.checksum.slice(0, 8));
  });

  it('summary skill 分桶（P2-6）：hub 记账补装 / custom 内嵌 / builtin 与 marketplace 目录桶只入总数', async () => {
    const wsId = await mkWorkspace('分桶空间');
    await seedMember(wsId, 'bucket-agent');
    // 四桶混合：hub 记账（补装位）/ custom 目录（内嵌）/ marketplace 无记账 / builtin（应用实物）
    seedMarketplaceSkillRow('hub-skill');
    seedHubAccounting('skill', 'hub-skill');
    seedCustomSkillDir('embed-skill');
    seedMarketplaceSkillRow('bare-market-skill');
    await goOnline();

    const { deps } = captureUploadFetch();
    const result = await buildAndUploadWorkspaceSnapshot(wsId, deps);

    const installed = listInstalled();
    // builtin 桶在场（electron/resources/skills 实物——清单总数含它但不装包）
    const builtinCount = installed.filter((s) => s.source === 'builtin').length;
    expect(builtinCount).toBeGreaterThan(0);
    expect(installed.map((s) => s.slug)).toEqual(
      expect.arrayContaining(['hub-skill', 'embed-skill', 'bare-market-skill']),
    );
    // 装包面 = hub 记账桶（resources 补装位）+ 内嵌 custom 桶——与 S4 实际装包口径一致
    expect(result.summary.skillResources).toBe(1);
    expect(result.summary.skillEmbedded).toBe(1);
    // 总数字段向后兼容：四桶之和
    expect(result.summary.skills).toBe(installed.length);
    expect(result.summary.skills).toBeGreaterThan(
      result.summary.skillResources + result.summary.skillEmbedded,
    );
  });

  it('knownSecrets 复检变异：keychain 实值（无形态特征）渗入 custom skill → 拒传不上路', async () => {
    const wsId = await mkWorkspace('渗漏空间');
    seedCustomDef('leak-agent');
    // provider key 实值 = 无形态特征字符串（构建器值形态扫描天然放行——唯一防线是上传复检）
    await createProvider({
      name: 'P', baseUrl: 'https://api.example.com',
      apiKey: 'zz-custom-secret-value-no-shape', platform: 'openai',
    });
    const skillDir = path.join(tmpRoot, 'skills', 'leak-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: leak 名\ndescription: d\nversion: 0.1.0\n---\n\n配置示例 zz-custom-secret-value-no-shape',
    );
    fs.writeFileSync(path.join(skillDir, '.sha256'), 'deadbeef');
    await goOnline();

    const { deps, captured } = captureUploadFetch();
    await expect(buildAndUploadWorkspaceSnapshot(wsId, deps)).rejects.toThrow('快照红线校验失败');
    expect(captured).toHaveLength(0); // 渗漏 = 上传前拒——HTTP 零上路
  });

  it('错误映射人话：409 / 413 / 401 / 网络异常 / 非 201 / 回执缺字段', async () => {
    const wsId = await mkWorkspace('错误空间');
    seedCustomDef('err-agent');
    await goOnline();

    const cases: Array<{ status: number | 'network'; body: unknown; message: string }> = [
      { status: 409, body: { error: 'version_exists' }, message: '该版本已存在' },
      { status: 413, body: { error: 'too_large' }, message: '200MB' },
      { status: 401, body: { error: 'unauthorized' }, message: '连接已失效' },
      { status: 500, body: {}, message: 'hub 响应异常: HTTP 500' },
      { status: 201, body: {}, message: '快照回执缺字段' },
    ];
    for (const c of cases) {
      const deps: SnapshotUploadDeps = {
        fetchImpl: async () => res(c.status as number, c.body),
      };
      await expect(buildAndUploadWorkspaceSnapshot(wsId, deps)).rejects.toThrow(c.message);
    }
    const netDeps: SnapshotUploadDeps = {
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    };
    await expect(buildAndUploadWorkspaceSnapshot(wsId, netDeps)).rejects.toThrow('无法连接 hub');
  });

  it('hub 回执 checksum 与本地复算不符 → 拒采用该存档', async () => {
    const wsId = await mkWorkspace('对账空间');
    seedCustomDef('match-agent');
    await goOnline();

    const deps: SnapshotUploadDeps = {
      fetchImpl: async () => res(201, { snapshotId: 'snap-x', checksum: '0'.repeat(64) }),
    };
    await expect(buildAndUploadWorkspaceSnapshot(wsId, deps)).rejects.toThrow('checksum 与本地复算不一致');
  });

  it('守卫：非 online → 人话拒绝（零构建零上传）', async () => {
    const wsId = await mkWorkspace('守卫空间');
    seedCustomDef('guard-agent');
    // 已 enroll 但未推 online（connecting 态）——守卫读 state 而非 configured
    await manager.hubEnroll({ hubUrl: 'http://hub.test', enrollmentToken: 't', nodeName: 'studio-node' });

    const { deps, captured } = captureUploadFetch();
    await expect(buildAndUploadWorkspaceSnapshot(wsId, deps)).rejects.toThrow('hub 未连接');
    expect(captured).toHaveLength(0);
  });
});
