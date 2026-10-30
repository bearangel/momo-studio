// electron/tests/resource/hub-unpublish.test.ts
//
// M3.4 §2.3.4 回归锁：unpublishHubResource（B12 撤回客户端）。
// 测试形态沿用 hub-provider.test.ts：进程内 node:http 真 mock hub（含 Bearer
// 鉴权仿真——无/错 token 一律 401，不进 responder）+ __setHubContextResolverForTest
// 注入上下文缝；unpublishHubResource 的守卫/错误映射/请求形状全部走真实实现。
//
// 覆盖：
//   1. 200 → resolve（请求形状：POST /resources/unpublish + Bearer + body {slug}）
//   2. 404 → 「资源不存在或已撤回」（UC-6 人话——下架按钮 toast 直接消费）
//   3. 401 → 「连接已失效」（token 失效引导重接入）
//   4. 5xx → 「hub 响应异常: HTTP …」
//   5. 网络不可达 → 「无法连接 hub」
//   6. 未接入（resolver null）→ 人话拒绝
//   7. keychain 空（deviceToken null）→ 人话拒绝
//   8. 200 幂等语义：已撤回再撤同 200 → resolve（不制造假错误）

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import {
  __setHubContextResolverForTest,
  unpublishHubResource,
} from '../../src/main/resource/hub/momo-hub';

const AUTH_TOKEN = 'tok-unpub';

interface MockHub {
  url: string;
  requests: Array<{ method: string; url: string; auth: string | undefined; body: string }>;
  setStatus: (status: number) => void;
  setReply: (status: number, body: unknown) => void;
  close: () => Promise<void>;
}

async function startMockHub(): Promise<MockHub> {
  const requests: MockHub['requests'] = [];
  let replyStatus = 200;
  let replyBody: unknown = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body });
      // 鉴权仿真（真实 hub 语义）：无 / 错 Bearer 一律 401，不进业务分支
      if (req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (req.url === '/resources/unpublish') {
        res.writeHead(replyStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(replyBody ?? { ok: replyStatus === 200 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    setStatus: (s) => { replyStatus = s; replyBody = null; },
    setReply: (s, b) => { replyStatus = s; replyBody = b; },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const tmpRoot = path.join(os.tmpdir(), `ap-hub-unpub-${Date.now()}`);
let hub: MockHub | null = null;

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(async () => {
  __setHubContextResolverForTest(null);
  if (hub) {
    await hub.close();
    hub = null;
  }
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('unpublishHubResource（B12 撤回客户端）', () => {
  it('200 → resolve；请求形状 = POST /resources/unpublish + Bearer + JSON body {slug}', async () => {
    hub = await startMockHub();
    __setHubContextResolverForTest(async () => ({ hubUrl: hub!.url, deviceToken: AUTH_TOKEN }));

    await expect(unpublishHubResource('demo-skill')).resolves.toBeUndefined();

    expect(hub.requests).toHaveLength(1);
    expect(hub.requests[0]).toMatchObject({
      method: 'POST',
      url: '/resources/unpublish',
      auth: `Bearer ${AUTH_TOKEN}`,
    });
    expect(JSON.parse(hub.requests[0]!.body)).toEqual({ slug: 'demo-skill' });
  });

  it('幂等：已撤回再撤（hub 200）→ resolve 不制造假错误', async () => {
    hub = await startMockHub();
    __setHubContextResolverForTest(async () => ({ hubUrl: hub!.url, deviceToken: AUTH_TOKEN }));

    await expect(unpublishHubResource('twice-skill')).resolves.toBeUndefined();
    await expect(unpublishHubResource('twice-skill')).resolves.toBeUndefined();
  });

  it('404 → 人话「资源不存在或已撤回」（下架按钮 toast 直接消费——UC-6）', async () => {
    hub = await startMockHub();
    hub.setStatus(404);
    __setHubContextResolverForTest(async () => ({ hubUrl: hub!.url, deviceToken: AUTH_TOKEN }));

    await expect(unpublishHubResource('ghost-skill')).rejects.toThrow('资源不存在或已撤回');
  });

  it('401 → 人话「连接已失效」（token 失效引导重接入）', async () => {
    hub = await startMockHub();
    __setHubContextResolverForTest(async () => ({ hubUrl: hub!.url, deviceToken: 'tok-stale' }));

    await expect(unpublishHubResource('demo-skill')).rejects.toThrow(/连接已失效/);
  });

  it('5xx → 「hub 响应异常: HTTP …」如实透传状态码', async () => {
    hub = await startMockHub();
    hub.setStatus(500);
    __setHubContextResolverForTest(async () => ({ hubUrl: hub!.url, deviceToken: AUTH_TOKEN }));

    await expect(unpublishHubResource('demo-skill')).rejects.toThrow('hub 响应异常: HTTP 500');
  });

  it('403 not_owner（携 owner_name）→ 「该资源属于节点 X，无法下架」（M5.0 §7.2）', async () => {
    hub = await startMockHub();
    hub.setReply(403, { error: 'not_owner', owner_name: 'studio-a' });
    __setHubContextResolverForTest(async () => ({ hubUrl: hub!.url, deviceToken: AUTH_TOKEN }));

    await expect(unpublishHubResource('demo-skill')).rejects.toThrow(
      '该资源属于节点 studio-a，无法下架',
    );
  });

  it('403 体异形（无 owner_name）→ 兜底「其他节点，无法下架」', async () => {
    hub = await startMockHub();
    hub.setReply(403, { error: 'not_owner' });
    __setHubContextResolverForTest(async () => ({ hubUrl: hub!.url, deviceToken: AUTH_TOKEN }));

    await expect(unpublishHubResource('demo-skill')).rejects.toThrow(
      '该资源属于节点 其他节点，无法下架',
    );
  });

  it('网络不可达 → 「无法连接 hub」', async () => {
    // 已关闭的端口——fetch 网络层异常（不是 HTTP 状态码路径）
    hub = await startMockHub();
    const deadUrl = hub.url;
    await hub.close();
    hub = null;
    __setHubContextResolverForTest(async () => ({ hubUrl: deadUrl, deviceToken: AUTH_TOKEN }));

    await expect(unpublishHubResource('demo-skill')).rejects.toThrow(/无法连接 hub/);
  });

  it('未接入（resolver null）→ 人话拒绝（零网络）', async () => {
    hub = await startMockHub();
    __setHubContextResolverForTest(async () => null);

    await expect(unpublishHubResource('demo-skill')).rejects.toThrow(/hub 未接入/);
    expect(hub.requests).toHaveLength(0);
  });

  it('keychain 空（deviceToken null）→ 人话拒绝（零网络）', async () => {
    hub = await startMockHub();
    __setHubContextResolverForTest(async () => ({ hubUrl: hub!.url, deviceToken: null }));

    await expect(unpublishHubResource('demo-skill')).rejects.toThrow(/本地缺少 device token/);
    expect(hub.requests).toHaveLength(0);
  });
});
