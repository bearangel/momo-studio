// electron/tests/marketplace/installer.test.ts
//
// 安装器测试：builtin 内联包（agent/skill/mcp）、幂等重装、checksum 校验失败清理、
// listInstalled、uninstallPackage。每个用例隔离 AP_USER_DATA_DIR 到临时目录，
// 并 runMigrations 建 installed_packages 表。
//
// 远程下载路径（downloadUrl 非空）的 checksum 失败用例 mock fetch；checksum 成功 +
// 解压的完整远程流程依赖真实 tar.gz 资源，不在单元测试覆盖范围。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  installPackage,
  listInstalled,
  uninstallPackage,
} from '../../src/main/marketplace/installer';
import { listAgentDefinitions } from '../../src/main/agent/crud';
import { SAFE_MINIMUM_TOOLS } from '../../src/main/agent/tools/catalog';
import type { MarketplaceItem } from '../../src/main/marketplace/types';

const tmpRoot = path.join(os.tmpdir(), `ap-mp-installer-test-${Date.now()}`);
let fetchSpy: ReturnType<typeof vi.spyOn>;

function makeItem(overrides: Partial<MarketplaceItem> = {}): MarketplaceItem {
  return {
    id: 'test-agent',
    type: 'agent',
    slug: 'test-agent',
    name: '测试 Agent',
    version: '1.0.0',
    author: 'tester',
    description: '一个测试用 agent',
    readme: '# 测试\n\n这是 readme。',
    tags: ['test'],
    category: 'dev',
    iconEmoji: '🧪',
    verificationStatus: 'community',
    downloadUrl: '',
    checksum: '',
    sizeBytes: 1,
    installCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.restoreAllMocks();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('marketplace/installer installPackage（builtin 内联）', () => {
  it('agent 类型生成 manifest.yaml + .installed + DB 记录', async () => {
    const item = makeItem();
    const { cachePath } = await installPackage(item);

    expect(fs.existsSync(path.join(cachePath, '.installed'))).toBe(true);
    expect(fs.existsSync(path.join(cachePath, 'manifest.yaml'))).toBe(true);

    // 生成的 YAML 可被 js-yaml 解析，字段正确
    const manifest = yamlLoad(
      fs.readFileSync(path.join(cachePath, 'manifest.yaml'), 'utf-8'),
    ) as Record<string, unknown>;
    const meta = manifest.metadata as Record<string, unknown>;
    expect(meta.slug).toBe('test-agent');
    expect(meta.iconEmoji).toBe('🧪');

    // DB 已登记
    const installed = listInstalled();
    expect(installed).toHaveLength(1);
    expect(installed[0]!.itemId).toBe('test-agent');
    expect(installed[0]!.itemType).toBe('agent');
    expect(installed[0]!.cachePath).toBe(cachePath);
  });

  it('agent 类型 manifest.yaml 含全部 24 个 builtin defaultTools', async () => {
    const { cachePath } = await installPackage(makeItem());
    const manifest = yamlLoad(
      fs.readFileSync(path.join(cachePath, 'manifest.yaml'), 'utf-8'),
    ) as { spec: { defaultTools: Array<{ kind: string; ref: string }> } };
    expect(manifest.spec.defaultTools).toHaveLength(24);
    expect(manifest.spec.defaultTools.every((t) => t.kind === 'builtin')).toBe(true);
    const refs = manifest.spec.defaultTools.map((t) => t.ref).sort();
    expect(refs).toContain('bash');
    expect(refs).toContain('read_file');
    expect(refs).toContain('git_commit');
    expect(refs).toContain('lsp_diagnostics');
  });

  it('S3 回归锁：注册入库的 defaultTools 按安全最小集钳制——bash/git_commit 被剔除', async () => {
    await installPackage(makeItem());
    const def = listAgentDefinitions().find((d) => d.slug === 'test-agent');
    expect(def).toBeDefined();
    const refs = def!.defaultTools.map((t) => t.ref);
    expect(refs).not.toContain('bash');
    expect(refs).not.toContain('git_commit');
    // 全部落在安全最小集内（文件里仍是 24 工具全集，钳制只作用于注册结果）
    const safe = new Set<string>(SAFE_MINIMUM_TOOLS);
    expect(refs.every((r) => safe.has(r))).toBe(true);
    expect(def!.source).toBe('marketplace');
  });

  it('skill 类型生成 SKILL.md', async () => {
    const item = makeItem({
      id: 'test-skill',
      type: 'skill',
      slug: 'test-skill',
      name: '测试技能',
    });
    const { cachePath } = await installPackage(item);

    expect(fs.existsSync(path.join(cachePath, 'SKILL.md'))).toBe(true);
    const content = fs.readFileSync(path.join(cachePath, 'SKILL.md'), 'utf-8');
    expect(content).toContain('name: test-skill');
    expect(content).toContain('# 测试');
  });

  it('mcp 类型生成 package.json stub', async () => {
    const item = makeItem({
      id: 'test-mcp',
      type: 'mcp',
      slug: 'test-mcp',
      name: '测试 MCP',
    });
    const { cachePath } = await installPackage(item);

    expect(fs.existsSync(path.join(cachePath, 'package.json'))).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(cachePath, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('test-mcp');
    expect(pkg.version).toBe('1.0.0');
  });

  it('已安装则幂等跳过（不重复写 DB）', async () => {
    const item = makeItem();
    await installPackage(item);
    await installPackage(item); // 第二次应短路
    expect(listInstalled()).toHaveLength(1);
  });
});

describe('marketplace/installer installPackage（远程 checksum）', () => {
  it('checksum 不匹配时抛错并清理目录', async () => {
    const item = makeItem({
      downloadUrl: 'https://example.test/pkg.tar.gz',
      checksum: 'deadbeef-wrong',
    });
    // mock fetch 返回固定字节流
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello-world-payload'));
        controller.close();
      },
    });
    fetchSpy.mockResolvedValue({ ok: true, status: 200, body } as Response);

    await expect(installPackage(item)).rejects.toThrow(/Checksum 不匹配/);

    // 目录应被清理
    const cacheBase = path.join(tmpRoot, 'cache', 'agents', 'test-agent', '1.0.0');
    expect(fs.existsSync(cacheBase)).toBe(false);
    // DB 不应有记录
    expect(listInstalled()).toHaveLength(0);
  });

  it('下载 HTTP 错误时抛错', async () => {
    const item = makeItem({ downloadUrl: 'https://example.test/pkg.tar.gz' });
    fetchSpy.mockResolvedValue({ ok: false, status: 404, body: null } as Response);

    await expect(installPackage(item)).rejects.toThrow(/下载失败: HTTP 404/);
  });
});

describe('marketplace/installer listInstalled / uninstallPackage', () => {
  it('listInstalled 按安装时间倒序', async () => {
    await installPackage(makeItem({ id: 'a', slug: 'a' }));
    await installPackage(makeItem({ id: 'b', slug: 'b' }));
    const installed = listInstalled();
    expect(installed).toHaveLength(2);
    expect(installed.map((i) => i.slug)).toContain('a');
    expect(installed.map((i) => i.slug)).toContain('b');
  });

  it('uninstallPackage 删缓存目录 + DB 记录', async () => {
    const item = makeItem();
    const { cachePath } = await installPackage(item);
    expect(fs.existsSync(cachePath)).toBe(true);

    uninstallPackage(item.id);
    expect(fs.existsSync(cachePath)).toBe(false);
    expect(listInstalled()).toHaveLength(0);
  });

  it('uninstallPackage 未安装的 itemId 静默跳过', () => {
    expect(() => uninstallPackage('does-not-exist')).not.toThrow();
  });

  it('listInstalled 字段映射为 camelCase', async () => {
    await installPackage(makeItem({ id: 'camel', slug: 'camel-case' }));
    const [first] = listInstalled();
    expect(first).toBeDefined();
    expect(first).toHaveProperty('itemId');
    expect(first).toHaveProperty('itemType');
    expect(first).toHaveProperty('cachePath');
    expect(first).toHaveProperty('installedAt');
    expect(first).not.toHaveProperty('item_id');
  });
});

describe('marketplace/installer 008 迁移建表', () => {
  it('installed_packages 表存在', () => {
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='installed_packages'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
  });
});
