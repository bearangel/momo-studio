// electron/tests/resource/hub-catalog-degraded.test.ts
//
// F1 回归锁：notEnrolled 路径必须复位 degraded。
//
// 背景：defaultSource 闭包内的 degraded 标志在目录拉取失败时置 true，但
// hubForget（configured=false）后 load() 走 notEnrolled 分支直接 return、
// 不清 degraded——两个 IPC 面结论相反：
//   - resource:getCatalogStatus → isHubCatalogDegraded() 持续 true
//   - registryList → hubProvider.list 走 notEnrolled 分支返回 degraded=false
// 修复：notEnrolled 分支内复位 degraded=false，两面同刻一致。
//
// 测试形态：只 mock defaultResolveHubContext 的两个生产依赖缝
// （hubGetStatus / getDeviceToken），hub HTTP 边界用真 node:http 起恒失败
// 端点——降级态由真实拉取路径制造，不是伪造状态。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const m = vi.hoisted(() => ({
  configured: false,
  hubUrl: null as string | null,
  token: null as string | null,
}));

vi.mock('../../src/main/hub', () => ({
  hubGetStatus: () => ({
    configured: m.configured,
    state: 'disconnected' as const,
    hubUrl: m.hubUrl,
    nodeName: null,
    nodeId: null,
    lastError: null,
  }),
}));
vi.mock('../../src/main/hub/creds', () => ({
  getDeviceToken: async () => m.token,
}));
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  hubProvider,
  isHubCatalogDegraded,
  listHubMarketplaceItems,
} from '../../src/main/resource/hub/momo-hub';
import { __resetTrustedDownloadOriginsForTest } from '../../src/main/marketplace/installer';

let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  // 恒失败目录端点（500）——经真实 fetch 路径制造 degraded
  server = http.createServer((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'boom' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  __resetTrustedDownloadOriginsForTest();
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  __resetTrustedDownloadOriginsForTest();
});

describe('F1: notEnrolled 路径复位 degraded（两 IPC 面一致）', () => {
  it('失败降级（degraded=true）→ forget（configured=false）→ isHubCatalogDegraded()===false 且 registryList notEnrolled 分支输出一致', async () => {
    // 1. 已接入 + 目录拉取失败 → 阻塞首拉失败，降级态成立
    m.configured = true;
    m.hubUrl = baseUrl;
    m.token = 'tok';
    expect(await listHubMarketplaceItems()).toEqual([]);
    expect(isHubCatalogDegraded()).toBe(true);
    // registryList 面此刻同样报 degraded（降级中，两面对齐）
    const degradedFace = await hubProvider.list('agent');
    expect(degradedFace.degraded).toBe(true);
    expect(degradedFace.notEnrolled).toBe(false);

    // 2. forget：configured=false、hubUrl/token 清空
    m.configured = false;
    m.hubUrl = null;
    m.token = null;

    // 3. notEnrolled 引导态：registryList 面空目录 + degraded=false + notEnrolled=true
    const face = await hubProvider.list('agent');
    expect(face.entries).toEqual([]);
    expect(face.notEnrolled).toBe(true);
    expect(face.degraded).toBe(false);
    // F1 核心断言：getCatalogStatus 面同步复位（修复前持续 true——两面矛盾）
    expect(isHubCatalogDegraded()).toBe(false);
    // install 消费面同刻输出一致（未接入 → 空）
    expect(await listHubMarketplaceItems()).toEqual([]);
  });
});
