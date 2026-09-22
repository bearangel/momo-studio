// electron/tests/resource/hub-install.test.ts
//
// P2 Task 5：hub MCP 安装/卸载链路 + library 已装列表接入测试。
// 覆盖：
//   - Smithery stdio 安装全链路：install-config 请求形状（encodeURIComponent(slug) +
//     POST + body {profile:{}} + 10s 超时信号）→ npx 命令注册 → installed_packages
//     记账（item_id = `${source}:${slug}`）→ listHubInstalledResources 映射
//   - S1 安全专项（错误路径，momo-test-rules 铁律 3）：
//       install-config 返回非法 command（shell 元字符）→ 拒绝且双表均不落库
//       install-config HTTP 非 2xx → 抛错不落库
//       fetch 网络异常 → 上抛不落库
//       args 含 `"` 的项被过滤（注入防线）
//   - 重复安装幂等（mcp_definitions 一行 + installed_packages 一行 + 列表一条）
//   - 魔搭 remote 安装：https url 直注册（streamable_http + Authorization 装配）+
//     无 token 时 headers 为空 object + 非 https url 拒绝
//   - hub 卸载：mcp 行 + 记账行同删 + 幂等（二次卸载不抛）
//   - library 接入（needHub）：listResources 按 source 短路取 hub 已装条目；
//     无 source 过滤时 hub 并入合并面（真实 DB + 真空 catalog，契约测试：
//     生产者 listRegistered 真实产出 → 消费者 listResources 直接消费）
//
// DB 隔离沿用仓库既定模式（照抄 tests/mcp/host-manager-remote.test.ts）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - runMigrations() 经 getDb() 单例建表（真实跑全量迁移）
//   - closeDb() 在 afterEach 复位单例
// 网络边界：vi.stubGlobal('fetch', fetchSpy)（仅 mock 网络，业务逻辑全真实）。
// keychain 边界：setKeychainImpl 注入内存桩（keychain.ts 官方测试钩子）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl } from '../../src/main/storage/keychain';
import {
  installSmitheryMcp,
  installModelScopeMcp,
  uninstallHubMcp,
  listHubInstalledResources,
} from '../../src/main/resource/hub-install';
import { getMcpConfig } from '../../src/main/mcp/host-manager';
import { listResources } from '../../src/main/resource/library';

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
  // keychain 默认桩：无 token（魔搭带 token 用例各自覆盖注入）
  setKeychainImpl({
    setSecret: async () => {},
    getSecret: async () => null,
    deleteSecret: async () => {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('Smithery stdio 安装链路', () => {
  it('install-config → npx 命令注册 + 记账 + 列表可见', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        command: 'npx',
        args: ['-y', '@owner/weather-mcp'],
        env: { KEY: 'v' },
      }),
    );

    await installSmitheryMcp('@owner/weather');

    // 请求形状契约（硬规则 1）：POST + encodeURIComponent(slug) + body {profile:{}}
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://registry.smithery.ai/servers/%40owner%2Fweather/install-config');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ profile: {} });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    // 注册形态：stdio npx 命令 + source='smithery'
    const cfg = getMcpConfig('@owner/weather');
    expect(cfg?.command).toBe('npx');
    expect(cfg?.args).toEqual(['-y', '@owner/weather-mcp']);
    expect(cfg?.env).toEqual({ KEY: 'v' });
    expect(cfg?.source).toBe('smithery');
    expect(cfg?.transport).toBe('stdio');

    // 记账形状（硬规则 2）：item_id = `${source}:${slug}`，与 marketplace 不撞
    const pkg = getDb()
      .prepare('SELECT item_id, item_type, slug FROM installed_packages')
      .get() as { item_id: string; item_type: string; slug: string };
    expect(pkg).toEqual({
      item_id: 'smithery:@owner/weather',
      item_type: 'mcp',
      slug: '@owner/weather',
    });

    // 已装列表映射：installed/removable 翻转依赖此形状（Task 6 契约）
    const items = listHubInstalledResources('mcp');
    const item = items.find((i) => i.slug === '@owner/weather');
    expect(item).toMatchObject({
      id: 'smithery-mcp-@owner/weather',
      type: 'mcp',
      source: 'smithery',
      installed: true,
      installable: false,
      removable: true,
      name: 'owner/weather',
    });
  });

  it('install-config 返回非法 command（shell 元字符）→ S1 拒绝且不落库', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ command: 'sh -c "evil"', args: [], env: {} }),
    );

    await expect(installSmitheryMcp('bad')).rejects.toThrow(/非法|拒绝/);

    // 双表均不落库（校验失败不得留半成品）
    expect(getMcpConfig('bad')).toBeNull();
    const count = getDb()
      .prepare('SELECT COUNT(*) AS c FROM installed_packages')
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('重复安装幂等（INSERT OR REPLACE + 记账 REPLACE）', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ command: 'npx', args: ['-y', 'p'], env: {} }),
    );

    await installSmitheryMcp('dup');
    await installSmitheryMcp('dup');

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

  it('args 含双引号的项被过滤（注入防线）', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ command: 'npx', args: ['-y', 'p', 'bad"arg'], env: {} }),
    );

    await installSmitheryMcp('filter-args');

    expect(getMcpConfig('filter-args')?.args).toEqual(['-y', 'p']);
  });

  it('install-config HTTP 非 2xx → 抛错且不落库', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}, false, 503));

    await expect(installSmitheryMcp('srv-err')).rejects.toThrow(/install-config 失败/);
    expect(getMcpConfig('srv-err')).toBeNull();
    const count = getDb()
      .prepare('SELECT COUNT(*) AS c FROM installed_packages')
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('fetch 网络异常 → 上抛且不落库', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));

    await expect(installSmitheryMcp('net-err')).rejects.toThrow(/network down/);
    expect(getMcpConfig('net-err')).toBeNull();
  });
});

describe('魔搭 remote 安装链路（骨架期无 UI 入口，函数实现保留供 P3 复核）', () => {
  it('https url 直注册（streamable_http）+ token 装配 Authorization + 记账', async () => {
    setKeychainImpl({
      setSecret: async () => {},
      getSecret: async () => 'tk-123',
      deleteSecret: async () => {},
    });

    await installModelScopeMcp('ms-weather', 'https://api.modelscope.ai/mcp/weather', '魔搭天气');

    const cfg = getMcpConfig('ms-weather');
    expect(cfg?.transport).toBe('streamable_http');
    expect(cfg?.url).toBe('https://api.modelscope.ai/mcp/weather');
    expect(cfg?.headers).toEqual({ Authorization: 'Bearer tk-123' });
    expect(cfg?.command).toBe(''); // NOT NULL 占位
    expect(cfg?.source).toBe('modelscope');

    // 记账：modelscope 前缀与 marketplace/smithery 不撞
    const pkg = getDb()
      .prepare('SELECT item_id FROM installed_packages')
      .get() as { item_id: string };
    expect(pkg.item_id).toBe('modelscope:ms-weather');

    // 列表映射：远程形态描述携带 url
    const item = listHubInstalledResources('mcp').find((i) => i.slug === 'ms-weather');
    expect(item?.source).toBe('modelscope');
    expect(item?.description).toContain('https://api.modelscope.ai/mcp/weather');
  });

  it('无 token → headers 为空 object（无 Authorization 头）', async () => {
    await installModelScopeMcp('ms-anon', 'https://api.modelscope.ai/mcp/anon', '匿名');

    expect(getMcpConfig('ms-anon')?.headers).toEqual({});
  });

  it('非 https url → 拒绝且不落库', async () => {
    await expect(
      installModelScopeMcp('ms-bad', 'http://api.modelscope.ai/mcp/bad', '坏地址'),
    ).rejects.toThrow(/https/);
    expect(getMcpConfig('ms-bad')).toBeNull();
    const count = getDb()
      .prepare('SELECT COUNT(*) AS c FROM installed_packages')
      .get() as { c: number };
    expect(count.c).toBe(0);
  });
});

describe('hub 卸载', () => {
  it('卸载 smithery 条目：mcp 行 + 记账行同删 + 列表消失；二次卸载幂等不抛', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ command: 'npx', args: ['-y', 'p'], env: {} }),
    );
    await installSmitheryMcp('@owner/gone');
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
    fetchSpy.mockResolvedValue(
      jsonResponse({ command: 'npx', args: [], env: {} }),
    );
    await installSmitheryMcp('only-mcp');
    expect(listHubInstalledResources('agent')).toEqual([]);
    expect(listHubInstalledResources('skill')).toEqual([]);
    expect(listHubInstalledResources('mcp')).toHaveLength(1);
  });

  it('marketplace/custom 源的 mcp 行不进 hub 列表（源隔离）', async () => {
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
  it('filter.source=smithery/modelscope 短路返回已装 hub 条目；无 source 过滤时并入合并面', async () => {
    // fetch 按 URL 分流：smithery install-config 返回 npx 配置，其余（fetchCatalog）返回空 catalog
    fetchSpy.mockImplementation(async (url: unknown) => {
      if (String(url).includes('registry.smithery.ai')) {
        return jsonResponse({ command: 'npx', args: ['-y', 'p'], env: {} });
      }
      return jsonResponse({ version: '1.0', updatedAt: 't', items: [] });
    });

    await installSmitheryMcp('@owner/weather');
    await installModelScopeMcp('ms-a', 'https://api.modelscope.example/mcp/a', 'A');

    // source 短路：只取对应 hub 源，不触发 fetchCatalog
    const bySmithery = await listResources({ source: 'smithery' });
    expect(bySmithery.map((i) => i.id)).toEqual(['smithery-mcp-@owner/weather']);
    const byModelScope = await listResources({ source: 'modelscope' });
    expect(byModelScope.map((i) => i.id)).toEqual(['modelscope-mcp-ms-a']);

    // 合并面：无 source 过滤（type=mcp）时 hub 与空 catalog/custom/p2p 合并
    const mcpAll = await listResources({ type: 'mcp' });
    expect(mcpAll.map((i) => i.id).sort()).toEqual([
      'modelscope-mcp-ms-a',
      'smithery-mcp-@owner/weather',
    ]);
  });
});
