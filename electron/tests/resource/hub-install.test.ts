// electron/tests/resource/hub-install.test.ts
//
// P2.1 Task 3：Smithery 直连安装（deploymentUrl + x-from 配置分流）测试。
// install-config 端点已 404（死码移除）；本文件覆盖：
//   - fetchSmitheryDetail：GET /servers/{encodeURIComponent(slug)} + 10s 超时信号；
//     HTTP 非 2xx → 「Smithery 详情获取失败：HTTP {status}」；网络异常上抛
//   - installSmitheryRemote：x-from=query 字段 encodeURIComponent 拼进 URL query、
//     x-from=header 与缺省（实证样本均无 x-from 元数据，spec D5 缺省进 header）
//     进 headers；streamable_http 注册（command 空串占位）+ installed_packages 记账
//     （item_id = `smithery:${slug}`）
//   - S1 错误路径（momo-test-rules 铁律 3）：deploymentUrl 非 https → 拒绝且双表不落库
//   - 重复安装幂等 / hub 卸载（mcp 行 + 记账同删）/ listHubInstalledResources 映射
//     （remote 行描述 = 远程 MCP（域名））/ library 接入（needHub 合并契约）
//
// DB 隔离沿用仓库既定模式（照抄 tests/mcp/host-manager-remote.test.ts）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - runMigrations() 经 getDb() 单例建表（真实跑全量迁移）
//   - closeDb() 在 afterEach 复位单例
// 网络边界：vi.stubGlobal('fetch', fetchSpy)（仅 mock 网络，业务逻辑全真实）。
// installSmitheryRemote 本身零网络（url/config 由调用方给入）——fetch 桩只服务
// fetchSmitheryDetail 与 library 接入用例的 fetchCatalog。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  fetchSmitheryDetail,
  installSmitheryRemote,
  uninstallHubMcp,
  listHubInstalledResources,
} from '../../src/main/resource/hub-install';
import { getMcpConfig } from '../../src/main/mcp/host-manager';
import { listResources } from '../../src/main/resource/library';
import { logger } from '../../src/main/logger';

const tmpRoot = path.join(os.tmpdir(), `ap-hub-install-test-${Date.now()}`);
const fetchSpy = vi.fn();

/** 构造 fetch Response 桩（ok + status + json） */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

// 详情 mock（实证形状，task-0 §1.4 / brief Step 1）：
// x-from 实证样本均无——此处刻意注入双向 x-from 验证分流（header / query）
const DETAIL = {
  qualifiedName: 'brave',
  displayName: 'Brave Search',
  remote: true,
  connections: [
    {
      type: 'http',
      deploymentUrl: 'https://brave.run.tools',
      configSchema: {
        type: 'object',
        required: ['braveApiKey'],
        properties: {
          braveApiKey: { type: 'string', title: 'Brave API Key', 'x-from': 'header' as const },
          projectId: { type: 'string', 'x-from': 'query' as const },
        },
      },
    },
  ],
};

describe('fetchSmitheryDetail', () => {
  it('GET /servers/{encodeURIComponent(slug)}（10s 超时信号）并透传 connections', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(DETAIL));

    const detail = await fetchSmitheryDetail('@owner/weather');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://registry.smithery.ai/servers/%40owner%2Fweather');
    // GET 缺省——不显式带 method/body（与 install-config 时代的 POST 形状诀别）
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(detail.connections).toHaveLength(1);
    expect(detail.connections[0]).toMatchObject({
      type: 'http',
      deploymentUrl: 'https://brave.run.tools',
    });
  });

  it('HTTP 非 2xx → 抛「Smithery 详情获取失败：HTTP {status}」', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}, false, 503));
    await expect(fetchSmitheryDetail('srv-err')).rejects.toThrow(
      'Smithery 详情获取失败：HTTP 503',
    );
  });

  it('fetch 网络异常 → 原样上抛（不吞状态）', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    await expect(fetchSmitheryDetail('net-err')).rejects.toThrow(/network down/);
  });
});

describe('installSmitheryRemote x-from 分流', () => {
  it('x-from=query 拼进 URL（encodeURIComponent）、x-from=header 进 headers + 注册 + 记账', async () => {
    await installSmitheryRemote(
      'brave',
      'https://brave.run.tools',
      { braveApiKey: 'k1', projectId: 'p1' },
      DETAIL.connections[0]!.configSchema,
    );

    // 注册形态：streamable_http + query 并入后的最终 URL + headers 只含 header 字段
    const cfg = getMcpConfig('brave');
    expect(cfg).not.toBeNull();
    expect(cfg!.transport).toBe('streamable_http');
    expect(cfg!.url).toBe('https://brave.run.tools?projectId=p1');
    expect(cfg!.headers).toEqual({ braveApiKey: 'k1' });
    expect(cfg!.command).toBe('');
    expect(cfg!.args).toEqual([]);
    expect(cfg!.source).toBe('smithery');

    // 记账形状：item_id = `smithery:${slug}`，与 marketplace 不撞
    const pkg = getDb()
      .prepare('SELECT item_id, item_type, slug FROM installed_packages')
      .get() as { item_id: string; item_type: string; slug: string };
    expect(pkg).toEqual({
      item_id: 'smithery:brave',
      item_type: 'mcp',
      slug: 'brave',
    });

    // 已装列表映射：remote 行描述 = 远程 MCP（域名）（Task 6 契约）
    const items = listHubInstalledResources('mcp');
    const item = items.find((i) => i.slug === 'brave');
    expect(item).toMatchObject({
      id: 'smithery-mcp-brave',
      type: 'mcp',
      source: 'smithery',
      installed: true,
      installable: false,
      removable: true,
      description: '远程 MCP（https://brave.run.tools?projectId=p1）',
      // P2.2 Task 6：custom.transport 填充（ResourceDetail「配置」按钮显示条件消费）
      custom: { transport: 'streamable_http' },
    });
  });

  it('无 x-from 字段缺省进 headers（实证样本均无 x-from，spec D5）', async () => {
    // 完全不带 schema（ipc 直装路径 required 为空时不传 schema 也须成立）
    await installSmitheryRemote('plain', 'https://plain.run.tools', { token: 't1' });

    const cfg = getMcpConfig('plain');
    expect(cfg!.url).toBe('https://plain.run.tools');
    expect(cfg!.headers).toEqual({ token: 't1' });
  });

  // P2.2 Task 1：安装链落 config_schema——schema 原样落 mcp_definitions，
  // getMcpConfig 回读深等（后续编辑功能 Task 4 的表单回填数据源）
  it('安装链落 config_schema：getMcpConfig 回读安装时 schema 深等', async () => {
    await installSmitheryRemote(
      'schema-srv',
      'https://schema-srv.run.tools',
      { braveApiKey: 'k1' },
      {
        required: ['braveApiKey'],
        properties: { braveApiKey: { title: 'Brave API Key', 'x-from': 'header' as const } },
      },
    );

    const cfg = getMcpConfig('schema-srv');
    expect(cfg!.configSchema).toEqual({
      required: ['braveApiKey'],
      properties: { braveApiKey: { title: 'Brave API Key', 'x-from': 'header' } },
    });
  });

  it('不带 schema 安装 → config_schema 回读 undefined（"{}" 视为无）', async () => {
    await installSmitheryRemote('no-schema', 'https://no-schema.run.tools', { token: 't1' });

    expect(getMcpConfig('no-schema')?.configSchema).toBeUndefined();
  });

  it('schema 有 properties 但字段无 x-from → 同样缺省进 headers', async () => {
    await installSmitheryRemote(
      'no-xfrom',
      'https://no-xfrom.run.tools',
      { apiKey: 'a1', region: 'r1' },
      { properties: { apiKey: { title: 'API Key' }, region: { title: 'Region' } } },
    );

    const cfg = getMcpConfig('no-xfrom');
    expect(cfg!.url).toBe('https://no-xfrom.run.tools');
    expect(cfg!.headers).toEqual({ apiKey: 'a1', region: 'r1' });
  });

  it('query 值特殊字符被 encodeURIComponent（S1 注入防线：空格/& 不破 URL 结构）', async () => {
    await installSmitheryRemote(
      'esc',
      'https://esc.run.tools',
      { projectId: 'a b&c' },
      { properties: { projectId: { 'x-from': 'query' as const } } },
    );

    const cfg = getMcpConfig('esc');
    expect(cfg!.url).toBe('https://esc.run.tools?projectId=a%20b%26c');
    expect(cfg!.headers).toEqual({});
  });

  it('deploymentUrl 非 https → 拒绝且双表均不落库', async () => {
    await expect(
      installSmitheryRemote('insecure', 'http://insecure.run.tools', {}),
    ).rejects.toThrow(/https/);

    expect(getMcpConfig('insecure')).toBeNull();
    const count = getDb()
      .prepare('SELECT COUNT(*) AS c FROM installed_packages')
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('重复安装幂等（mcp_definitions 一行 + installed_packages 一行 + 列表一条）', async () => {
    await installSmitheryRemote('dup', 'https://dup.run.tools', {});
    await installSmitheryRemote('dup', 'https://dup.run.tools', {});

    const mcpCount = getDb()
      .prepare("SELECT COUNT(*) AS c FROM mcp_definitions WHERE name = 'dup'")
      .get() as { c: number };
    const pkgCount = getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM installed_packages WHERE item_id = 'smithery:dup'",
      )
      .get() as { c: number };
    expect(mcpCount.c).toBe(1);
    expect(pkgCount.c).toBe(1);
    expect(listHubInstalledResources('mcp').filter((i) => i.slug === 'dup')).toHaveLength(1);
  });

  // 终审 Important-1（spec §6 红线）：x-from=query 字段（可能是用户 API key 等
  // config 值）经 logger.info 落盘前必须剥离 query——日志只记基础 url。
  // 该测试为回归锁：任何人重写 logger.info 字段时若带回 finalUrl 必失败。
  it('x-from=query 字段安装时 logger.info 收到的 url 不含 query（config 值不落日志）', async () => {
    const SECRET_TOKEN = 'SECRET_API_KEY_xyz_should_never_log';
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      await installSmitheryRemote(
        'secrets',
        'https://secrets.run.tools',
        { token: SECRET_TOKEN },
        { properties: { token: { 'x-from': 'query' as const } } },
      );

      // 运行链路语义：注册的实际 URL 仍带 query（远程 MCP 需要 token）
      const cfg = getMcpConfig('secrets');
      expect(cfg!.url).toBe(`https://secrets.run.tools?token=${SECRET_TOKEN}`);

      // 日志链路语义：logger.info 的 url 必须是基础 URL，绝不携带 SECRET_TOKEN
      const calls = infoSpy.mock.calls.filter(
        (c) => c[0] === 'Smithery 远程 MCP 已安装',
      );
      expect(calls).toHaveLength(1);
      const payload = calls[0]![1] as { slug: string; url: string };
      expect(payload.slug).toBe('secrets');
      expect(payload.url).toBe('https://secrets.run.tools');
      expect(payload.url).not.toContain('?');
      expect(payload.url).not.toContain(SECRET_TOKEN);
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe('hub 卸载', () => {
  it('卸载 smithery 条目：mcp 行 + 记账行同删 + 列表消失；二次卸载幂等不抛', async () => {
    await installSmitheryRemote('@owner/gone', 'https://gone.run.tools', {});
    expect(getMcpConfig('@owner/gone')).not.toBeNull();

    uninstallHubMcp('smithery', '@owner/gone');

    expect(getMcpConfig('@owner/gone')).toBeNull();
    const pkgCount = getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM installed_packages WHERE item_id = 'smithery:@owner/gone'",
      )
      .get() as { c: number };
    expect(pkgCount.c).toBe(0);
    expect(listHubInstalledResources('mcp').some((i) => i.slug === '@owner/gone')).toBe(false);

    // 幂等：行不存在时静默通过
    expect(() => uninstallHubMcp('smithery', '@owner/gone')).not.toThrow();
  });
});

describe('listHubInstalledResources 过滤语义', () => {
  it('type 非 mcp（hub 只有 mcp）→ 空数组', async () => {
    await installSmitheryRemote('only-mcp', 'https://only.run.tools', {});
    expect(listHubInstalledResources('agent')).toEqual([]);
    expect(listHubInstalledResources('skill')).toEqual([]);
    expect(listHubInstalledResources('mcp')).toHaveLength(1);
  });

  it('marketplace/custom 源的 mcp 行不进 hub 列表（源隔离）', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO mcp_definitions (id, name, version, transport, command, args, env, source)
       VALUES ('m1', 'mk-row', '1.0.0', 'stdio', 'npx x', '[]', '{}', 'marketplace'),
              ('c1', 'cu-row', '1.0.0', 'stdio', 'npx y', '[]', '{}', 'custom')`,
    ).run();
    expect(listHubInstalledResources('mcp')).toEqual([]);
  });
});

describe('library 接入（needHub 合并，契约测试：真实 DB 生产 → listResources 直接消费）', () => {
  it('filter.source=smithery 短路返回已装 hub 条目；无 source 过滤时并入合并面', async () => {
    // installSmitheryRemote 零网络——fetch 桩只服务 fetchCatalog（空 catalog）
    fetchSpy.mockResolvedValue(jsonResponse({ version: '1.0', updatedAt: 't', items: [] }));

    await installSmitheryRemote('@owner/weather', 'https://weather.run.tools', {});

    // source 短路：只取对应 hub 源，不触发 fetchCatalog
    const bySmithery = await listResources({ source: 'smithery' });
    expect(bySmithery.map((i) => i.id)).toEqual(['smithery-mcp-@owner/weather']);

    // 合并面：无 source 过滤（type=mcp）时 hub 与空 catalog/custom/p2p 合并
    const mcpAll = await listResources({ type: 'mcp' });
    expect(mcpAll.map((i) => i.id).sort()).toEqual([
      'smithery-mcp-@owner/weather',
    ]);
  });
});
