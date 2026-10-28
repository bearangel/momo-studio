// electron/tests/resource/hub-catalog-events.test.ts
//
// M3.4 B10 回归锁：createHubCatalogSource 事件增量合并
//（applyPublishedEvent / applyUnpublishedEvent——spec §2.3.3）。
//
// 锁四件事：
//   1. published 即时可见：事件 upsert 进 cache，TTL 窗口内 load() 零网络可见
//     （消「新发布最长 5min 盲窗」）——新 slug 出展示级条目、在场 slug 升版本
//      （versions 按_semver 降序插入）
//   2. unpublished 即时消失：事件剔除 cache 条目，TTL 窗口内 load() 零网络不可见；
//      幂等（重复事件 no-op）、未知 slug no-op
//   3. lastGood 一致性：事件合并同步落 lastGood——TTL 过期 + 拉取失败退避后，
//      load() 返回的 lastGood 仍含合并结果（浏览链不因失败回吐事件前旧态）
//   4. revision 不伪造：事件不带修订号，合并前后 catalog.revision 原值不动
//
// 另锁旧 hub 兼容（UC-6）：catalog 无 revision 字段 → load 正常 + 归一 0。
// 全量拉取权威性（TTL 过期后真目录覆盖事件合并态）由 SWR 既有锁承担
//（hub-provider.test.ts 三锁），本文件不重复。
//
// 测试形态沿用 hub-provider.test.ts：进程内 node:http 真 mock hub，只注入
// hub 上下文缝（业务实现全真实）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import {
  createHubCatalogSource,
  HUB_CATALOG_CACHE_TTL_MS,
  type HubCatalogSource,
  type HubContext,
  type HubContextResolver,
} from '../../src/main/resource/hub/momo-hub';
import { __resetTrustedDownloadOriginsForTest } from '../../src/main/marketplace/installer';

interface MockHub {
  url: string;
  requests: string[];
  setRespond: (status: number, body: unknown) => void;
  close: () => Promise<void>;
}

async function startMockHub(initialBody: unknown): Promise<MockHub> {
  const requests: string[] = [];
  let status = 200;
  let body = initialBody;
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    setRespond: (s, b) => {
      status = s;
      body = b;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 单条目录项载荷（协议 HubResourceMeta 字段集） */
function item(slug: string, version: string, extra: Record<string, unknown> = {}): unknown {
  return {
    slug,
    type: 'skill',
    name: `条目 ${slug}`,
    version,
    author: 'node-a',
    description: `演示 ${slug}`,
    readme: '# x',
    tags: [],
    category: 'dev',
    iconEmoji: '🧪',
    verificationStatus: 'unverified',
    downloadUrl: `/resources/${slug}/${version}/download`,
    checksum: 'a'.repeat(64),
    sizeBytes: 42,
    publishedAt: 1_700_000_000_000,
    versions: [version],
    ...extra,
  };
}

function catalog(items: unknown[], revision?: number): unknown {
  return {
    version: '1.5.0',
    ...(revision !== undefined ? { revision } : {}),
    updatedAt: '2026-10-29T00:00:00.000Z',
    items,
  };
}

function resolverFor(hubUrl: string): HubContextResolver {
  return async (): Promise<HubContext> => ({ hubUrl, deviceToken: 'tok-events' });
}

const tmpRoot = path.join(os.tmpdir(), `ap-hub-events-${Date.now()}`);
let hub: MockHub | null = null;

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  __resetTrustedDownloadOriginsForTest();
});

afterEach(async () => {
  if (hub) {
    await hub.close();
    hub = null;
  }
  closeDb();
  __resetTrustedDownloadOriginsForTest();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('B10：applyPublishedEvent（published 即时可见）', () => {
  it('新 slug → TTL 窗口内 load() 即可见（零网络——事件合并消 5min 盲窗）；条目为展示级占位', async () => {
    hub = await startMockHub(catalog([item('demo-skill', '1.0.0')], 7));
    const source = createHubCatalogSource(resolverFor(hub.url));
    await source.load();
    expect(hub.requests).toHaveLength(1);

    source.applyPublishedEvent({
      slug: 'fresh-skill', type: 'mcp', name: '新发布 MCP', version: '0.3.0',
      author: 'node-b', at: 1_700_000_100_000,
    });

    const merged = await source.load();
    // 零网络（TTL 命中缓存）+ 新条目在场
    expect(hub.requests).toHaveLength(1);
    const entry = merged.catalog.items.find((m) => m.slug === 'fresh-skill');
    expect(entry).toBeDefined();
    expect(entry!.version).toBe('0.3.0');
    // 展示级占位契约：downloadUrl 为路径段（消费时经 RM1-12 重写补基址）、checksum 空
    expect(entry!.downloadUrl).toBe('/resources/fresh-skill/0.3.0/download');
    expect(entry!.checksum).toBe('');
  });

  it('在场 slug 升版本 → 缓存条目版本面更新（version/versions 降序插入，长字段保留缓存值）', async () => {
    hub = await startMockHub(catalog([
      item('demo-skill', '1.0.0', { description: '目录描述', versions: ['1.0.0'] }),
    ], 7));
    const source = createHubCatalogSource(resolverFor(hub.url));
    await source.load();

    source.applyPublishedEvent({
      slug: 'demo-skill', type: 'skill', name: '条目 demo-skill', version: '2.0.0',
      author: 'node-a', at: 1_700_000_200_000,
    });

    const merged = await source.load();
    const entry = merged.catalog.items.find((m) => m.slug === 'demo-skill');
    expect(entry).toBeDefined();
    expect(entry!.version).toBe('2.0.0');
    expect(entry!.versions).toEqual(['2.0.0', '1.0.0']);
    // 事件不带的字段（description 等）保留缓存原值——不造空值覆盖
    expect(entry!.description).toBe('目录描述');
    // revision 不伪造：事件不带修订号，原值 7 不动
    expect(merged.catalog.revision).toBe(7);
  });

  it('重复同版事件幂等：再发一次 → 条目唯一、版本面不变', async () => {
    hub = await startMockHub(catalog([item('demo-skill', '1.0.0')], 3));
    const source = createHubCatalogSource(resolverFor(hub.url));
    await source.load();

    const evt = {
      slug: 'demo-skill', type: 'skill' as const, name: '条目 demo-skill',
      version: '1.1.0', author: 'node-a', at: 1_700_000_300_000,
    };
    source.applyPublishedEvent(evt);
    source.applyPublishedEvent(evt);

    const merged = await source.load();
    expect(merged.catalog.items.filter((m) => m.slug === 'demo-skill')).toHaveLength(1);
    expect(merged.catalog.items.find((m) => m.slug === 'demo-skill')!.versions).toEqual(['1.1.0', '1.0.0']);
  });
});

describe('B10：applyUnpublishedEvent（unpublished 即时消失）', () => {
  it('TTL 窗口内 load() 即不可见（零网络）；幂等 + 未知 slug no-op', async () => {
    hub = await startMockHub(catalog([item('gone-skill', '1.0.0'), item('keep-skill', '1.0.0')], 9));
    const source = createHubCatalogSource(resolverFor(hub.url));
    await source.load();

    source.applyUnpublishedEvent({ slug: 'gone-skill', by: 'node-a', at: 1 });
    // 幂等 + 未知 slug（目录本就无此条目）
    source.applyUnpublishedEvent({ slug: 'gone-skill', by: 'node-a', at: 2 });
    source.applyUnpublishedEvent({ slug: 'never-skill', by: 'node-a', at: 3 });

    const merged = await source.load();
    expect(hub.requests).toHaveLength(1); // 零网络
    expect(merged.catalog.items.map((m) => m.slug)).toEqual(['keep-skill']);
    expect(merged.catalog.revision).toBe(9);
  });
});

describe('B10：lastGood 一致性（事件合流与失败回落不打架）', () => {
  it('published 合并后 TTL 过期 + 拉取失败 → lastGood 仍含合并条目（不回吐事件前旧态）', async () => {
    hub = await startMockHub(catalog([item('demo-skill', '1.0.0')], 7));
    const source: HubCatalogSource = createHubCatalogSource(resolverFor(hub.url));
    await source.load();

    source.applyPublishedEvent({
      slug: 'demo-skill', type: 'skill', name: '条目 demo-skill', version: '2.0.0',
      author: 'node-a', at: 1_700_000_400_000,
    });

    // TTL 过期 + hub 目录 500：首次 load 返回过期缓存（含合并态）+ 后台刷新失败
    source.rewindCacheForTest(HUB_CATALOG_CACHE_TTL_MS + 1000);
    hub.setRespond(500, { error: 'boom' });
    const stale = await source.load();
    expect(stale.catalog.items.find((m) => m.slug === 'demo-skill')?.version).toBe('2.0.0');
    // 后台刷新失败落退避——下一拉走 lastGood：合并结果必须同样在场
    await vi.waitFor(() => expect(hub?.requests.length).toBe(2));
    const backoff = await source.load();
    expect(backoff.degraded).toBe(true);
    expect(backoff.catalog.items.find((m) => m.slug === 'demo-skill')?.version).toBe('2.0.0');
  });

  it('unpublished 剔除后失败回落 → lastGood 同样无此条目（撤回不被回吐）', async () => {
    hub = await startMockHub(catalog([item('gone-skill', '1.0.0')], 7));
    const source = createHubCatalogSource(resolverFor(hub.url));
    await source.load();

    source.applyUnpublishedEvent({ slug: 'gone-skill', by: 'node-a', at: 1 });
    source.rewindCacheForTest(HUB_CATALOG_CACHE_TTL_MS + 1000);
    hub.setRespond(500, { error: 'boom' });

    const stale = await source.load();
    expect(stale.catalog.items.some((m) => m.slug === 'gone-skill')).toBe(false);
    await vi.waitFor(() => expect(hub?.requests.length).toBe(2));
    const backoff = await source.load();
    expect(backoff.catalog.items.some((m) => m.slug === 'gone-skill')).toBe(false);
  });

  it('全量拉取仍权威：恢复后 fresh 目录覆盖事件合并态（revision 同步回真值）', async () => {
    hub = await startMockHub(catalog([item('demo-skill', '1.0.0')], 7));
    const source = createHubCatalogSource(resolverFor(hub.url));
    await source.load();

    // 乱序演示：unpublished 先到、published 后到（事件幂等终态 = 在场 3.0.0）
    source.applyUnpublishedEvent({ slug: 'demo-skill', by: 'node-a', at: 1 });
    source.applyPublishedEvent({
      slug: 'demo-skill', type: 'skill', name: '条目 demo-skill', version: '3.0.0',
      author: 'node-a', at: 2,
    });

    // hub 恢复且真目录说 1.0.0（republish 未发生）——fresh 拉取以 hub 为准
    const fresh = await source.loadFresh();
    expect(fresh.catalog.items.find((m) => m.slug === 'demo-skill')?.version).toBe('1.0.0');
    expect(fresh.catalog.revision).toBe(7);
    const after = await source.load();
    expect(after.catalog.items.find((m) => m.slug === 'demo-skill')?.version).toBe('1.0.0');
  });
});

describe('旧 hub 兼容（UC-6：1.4 目录无 revision 字段）', () => {
  it('catalog 无 revision → load 正常且归一 0；事件合并不炸、不伪造修订号', async () => {
    hub = await startMockHub(catalog([item('demo-skill', '1.0.0')]));
    const source = createHubCatalogSource(resolverFor(hub.url));

    const loaded = await source.load();
    expect(loaded.degraded).toBe(false);
    expect(loaded.catalog.revision).toBe(0);

    source.applyPublishedEvent({
      slug: 'legacy-skill', type: 'skill', name: '旧 hub 新发布', version: '1.0.0',
      author: 'node-old', at: 1,
    });
    const merged = await source.load();
    expect(merged.catalog.items.some((m) => m.slug === 'legacy-skill')).toBe(true);
    expect(merged.catalog.revision).toBe(0);
  });
});
