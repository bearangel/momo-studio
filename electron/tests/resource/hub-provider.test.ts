// electron/tests/resource/hub-provider.test.ts
//
// T9 回归锁：momo-hub provider（资源库第五源）——目录拉取 / SWR 缓存 / 退避 /
// degraded / 未接入引导态 / plugin 预过滤 / RM1-12 downloadUrl 重写。
//
// 测试形态：进程内 node:http 起真 mock hub（不是 mock fetch）——HTTP 边界走真实
// 栈（状态码 / 头 / 超时中止都是真实语义）；只注入「hub 上下文」这一个缝
// （hubUrl + deviceToken），生产实现（协议包 validateHubCatalog 校验、SWR 状态机、
// 映射与过滤）全部走真实代码。
//
// 覆盖：
//   1. catalog 200 → 条目映射逐项断言（含 RM1-12：downloadUrl 基址换成 studio
//      自身配置的 hubUrl，catalog 自报的绝对地址不被盲信）
//   2. plugin 项在 M1c 过滤不输出（M1d 接通）
//   3. Bearer deviceToken 头随请求发出
//   4. 401 → degraded=true（token 失效不静默空目录）
//   5. 超时 → degraded=true
//   6. 未接入引导态 → 空目录 + degraded=false + notEnrolled=true + 零网络
//   7. SWR：首拉阻塞 / TTL 内零网络 / 退避窗内零网络 / 退避过后直返 lastGood +
//      后台单飞刷新（并发两次只发一次网络）
//   8. hub origin 注册进 installer 信任集（下载放行）

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import {
  createHubCatalogSource,
  createHubProvider,
  HUB_CATALOG_CACHE_TTL_MS,
  type HubContext,
  type HubContextResolver,
} from '../../src/main/resource/hub/momo-hub';
import {
  isTrustedDownloadUrl,
  __resetTrustedDownloadOriginsForTest,
} from '../../src/main/marketplace/installer';

type Responder = (req: http.IncomingMessage, res: http.ServerResponse) => void;

interface MockHub {
  url: string;
  requests: Array<{ method: string; url: string; auth: string | undefined }>;
  close: () => Promise<void>;
}

async function startMockHub(responder: Responder): Promise<MockHub> {
  const requests: MockHub['requests'] = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      auth: req.headers.authorization,
    });
    responder(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function jsonResponder(status: number, body: unknown): Responder {
  return (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

/** 合法的 hub 目录载荷（protocol 包 validateHubCatalog 的字段集） */
function catalogPayload(): unknown {
  return {
    version: '1.1.0',
    updatedAt: '2026-10-24T00:00:00.000Z',
    items: [
      {
        slug: 'demo-agent',
        type: 'agent',
        name: '演示 Agent',
        version: '1.0.0',
        author: 'node-a',
        description: '一个演示 agent',
        readme: '# demo agent',
        tags: ['demo'],
        category: 'dev',
        iconEmoji: '🤖',
        verificationStatus: 'unverified',
        // catalog 自报的绝对地址（host 不可信——RM1-12 要求重写基址）
        downloadUrl: 'http://untrusted.example.com/resources/demo-agent/1.0.0/download',
        checksum: 'a'.repeat(64),
        sizeBytes: 123,
        publishedAt: 1_700_000_000_000,
        versions: ['1.0.0'],
      },
      {
        slug: 'demo-skill',
        type: 'skill',
        name: '演示技能',
        version: '2.0.0',
        author: 'node-b',
        description: '一个演示 skill',
        readme: '# demo skill',
        tags: ['demo', 'tool'],
        category: 'dev',
        iconEmoji: '🧰',
        verificationStatus: 'unverified',
        downloadUrl: 'http://untrusted.example.com/resources/demo-skill/2.0.0/download',
        checksum: 'b'.repeat(64),
        sizeBytes: 456,
        publishedAt: 1_700_000_001_000,
        versions: ['2.0.0', '1.0.0'],
      },
      {
        slug: 'demo-plugin',
        type: 'plugin',
        name: '演示插件',
        version: '0.1.0',
        author: 'node-c',
        description: '一个演示 plugin',
        readme: '# demo plugin',
        tags: ['demo'],
        category: 'dev',
        iconEmoji: '🧩',
        verificationStatus: 'unverified',
        downloadUrl: 'http://untrusted.example.com/resources/demo-plugin/0.1.0/download',
        checksum: 'c'.repeat(64),
        sizeBytes: 789,
        publishedAt: 1_700_000_002_000,
        versions: ['0.1.0'],
      },
    ],
  };
}

/** 注入用上下文解析器（固定 hubUrl + token） */
function resolverFor(hubUrl: string, deviceToken: string | null = 'tok-123'): HubContextResolver {
  return async (): Promise<HubContext> => ({ hubUrl, deviceToken });
}

const tmpRoot = path.join(os.tmpdir(), `ap-hub-provider-test-${Date.now()}`);
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

describe('T9: momo-hub provider 目录源', () => {
  it('catalog 200 → 条目映射逐项断言（downloadUrl 基址按 RM1-12 重写为 studio 自身 hubUrl）', async () => {
    hub = await startMockHub(jsonResponder(200, catalogPayload()));
    const source = createHubCatalogSource(resolverFor(hub.url));
    const provider = createHubProvider(source);

    const result = await provider.list('agent');

    expect(result.degraded).toBe(false);
    expect(result.notEnrolled).toBe(false);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.id).toBe('hub-agent-demo-agent');
    expect(entry.type).toBe('agent');
    expect(entry.name).toBe('演示 Agent');
    expect(entry.version).toBe('1.0.0');
    expect(entry.tags).toEqual(['demo']);
    expect(entry.category).toBe('dev');
    // item 段（ResourceItem 形态——source='hub'，未装可装）
    expect(entry.item.source).toBe('hub');
    expect(entry.item.slug).toBe('demo-agent');
    expect(entry.item.installed).toBe(false);
    expect(entry.item.installable).toBe(true);
    expect(entry.item.removable).toBe(false);
    expect(entry.item.marketplace?.author).toBe('node-a');
    expect(entry.item.marketplace?.verificationStatus).toBe('unverified');
    expect(entry.item.marketplace?.checksum).toBe('a'.repeat(64));
    // RM1-12：基址换成 studio 自身配置的 hubUrl，路径部分保留 catalog 给的
    expect(entry.item.marketplace?.downloadUrl).toBe(
      `${hub.url}/resources/demo-agent/1.0.0/download`,
    );
  });

  it('plugin 项输出（T12 消费面接通：M1c 预过滤解开）+ provider types 含 plugin', async () => {
    hub = await startMockHub(jsonResponder(200, catalogPayload()));
    const source = createHubCatalogSource(resolverFor(hub.url));
    const provider = createHubProvider(source);

    // provider 元信息含 plugin（resource:registryProviders 透传——hub 页签类型面）
    expect(provider.types).toContain('plugin');

    const pluginResult = await provider.list('plugin');
    expect(pluginResult.entries).toHaveLength(1);
    expect(pluginResult.entries[0]!.type).toBe('plugin');
    expect(pluginResult.entries[0]!.item.slug).toBe('demo-plugin');
    expect(pluginResult.entries[0]!.item.installable).toBe(true);

    const skillResult = await provider.list('skill');
    expect(skillResult.entries).toHaveLength(1);
    expect(skillResult.entries[0]!.item.slug).toBe('demo-skill');
  });

  it('Bearer deviceToken 头随目录请求发出', async () => {
    hub = await startMockHub(jsonResponder(200, catalogPayload()));
    const source = createHubCatalogSource(resolverFor(hub.url, 'tok-abc'));
    await source.load();

    expect(hub.requests).toHaveLength(1);
    expect(hub.requests[0]!.url).toBe('/resources/catalog');
    expect(hub.requests[0]!.auth).toBe('Bearer tok-abc');
  });

  it('401（token 失效）→ degraded=true + 空目录（不静默空目录）', async () => {
    hub = await startMockHub(jsonResponder(401, { error: 'unauthorized' }));
    const source = createHubCatalogSource(resolverFor(hub.url));
    const provider = createHubProvider(source);

    const result = await provider.list('agent');

    expect(result.entries).toHaveLength(0);
    expect(result.degraded).toBe(true);
    expect(result.notEnrolled).toBe(false);
    expect(source.isDegraded()).toBe(true);
  });

  it('请求超时 → degraded=true', async () => {
    hub = await startMockHub(() => {
      /* 永不响应——触发客户端超时中止 */
    });
    const source = createHubCatalogSource(resolverFor(hub.url), { timeoutMs: 200 });
    const provider = createHubProvider(source);

    const result = await provider.list('agent');

    expect(result.entries).toHaveLength(0);
    expect(result.degraded).toBe(true);
  });

  it('未接入引导态 → 空目录 + degraded=false + notEnrolled=true + 零网络', async () => {
    hub = await startMockHub(jsonResponder(200, catalogPayload()));
    const source = createHubCatalogSource(async () => null);
    const provider = createHubProvider(source);

    const result = await provider.list('agent');

    expect(result.entries).toHaveLength(0);
    expect(result.degraded).toBe(false);
    expect(result.notEnrolled).toBe(true);
    expect(hub.requests).toHaveLength(0);
  });

  it('SWR：首拉阻塞拿真目录 → TTL 内二次调用零网络', async () => {
    hub = await startMockHub(jsonResponder(200, catalogPayload()));
    const source = createHubCatalogSource(resolverFor(hub.url));

    const first = await source.load();
    expect(first.catalog.items).toHaveLength(3);
    expect(first.degraded).toBe(false);

    const second = await source.load();
    expect(second.catalog.items).toHaveLength(3);
    expect(hub.requests).toHaveLength(1);
  });

  it('SWR：失败退避窗内零网络（直返 lastGood 或空目录）', async () => {
    hub = await startMockHub(jsonResponder(500, { error: 'boom' }));
    const source = createHubCatalogSource(resolverFor(hub.url));

    const first = await source.load();
    expect(first.degraded).toBe(true);
    expect(hub.requests).toHaveLength(1);

    const second = await source.load();
    expect(second.degraded).toBe(true);
    expect(hub.requests).toHaveLength(1);
  });

  it('SWR：TTL 过期后直返 lastGood + 后台单飞刷新（并发两次只发一次网络）', async () => {
    hub = await startMockHub(jsonResponder(200, catalogPayload()));
    const source = createHubCatalogSource(resolverFor(hub.url));

    await source.load();
    expect(hub.requests).toHaveLength(1);

    // TTL 过期（时钟前移，不伪造系统时钟）
    source.rewindCacheForTest(HUB_CATALOG_CACHE_TTL_MS + 1000);

    const [a, b] = await Promise.all([source.load(), source.load()]);
    expect(a.catalog.items).toHaveLength(3);
    expect(b.catalog.items).toHaveLength(3);

    // 后台刷新完成——总请求数 2（并发两次 load 只触发一次刷新）
    await vi.waitFor(() => expect(hub?.requests.length).toBe(2));
  });

  it('hub origin 注册进 installer 信任集（下载放行——T8 白名单）', async () => {
    hub = await startMockHub(jsonResponder(200, catalogPayload()));
    const source = createHubCatalogSource(resolverFor(hub.url));

    await source.load();

    expect(isTrustedDownloadUrl(`${hub.url}/resources/demo-agent/1.0.0/download`)).toBe(true);
  });
});
