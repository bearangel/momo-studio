// electron/tests/resource/hub-install.test.ts
//
// hub 资源已装链保留面测试（2026-11-02 网络获取下线：smithery 安装链整体退役，
// 远端获取只保留 momo-hub——原 fetchSmitheryDetail / installSmitheryRemote /
// x-from 分流直装用例随功能删除；x-from 分流契约由 compose-remote-config.test.ts
// 独立锁定）。本文件覆盖保留下来的存量链：
//   - uninstallHubMcp：mcp 行 + 记账行同删、幂等（存量 smithery 行的本地卸载）
//   - listHubInstalledResources 映射：source 隔离（marketplace/custom 不进 hub 面）
//   - library 接入（filter.source=smithery 短路 + 合并面）
// 存量行以「registerMcpDefinition(source='smithery') + installed_packages 记账」
// 直接种子（与退役前的安装终态同形）。
//
// DB 隔离沿用仓库既定模式（照抄 tests/mcp/host-manager-remote.test.ts）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - runMigrations() 经 getDb() 单例建表（真实跑全量迁移）
//   - closeDb() 在 afterEach 复位单例

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { uninstallHubMcp, listHubInstalledResources } from '../../src/main/resource/hub-install';
import { registerMcpDefinition, getMcpConfig } from '../../src/main/mcp/host-manager';
import { listResources } from '../../src/main/resource/library';

const tmpRoot = path.join(os.tmpdir(), `ap-hub-install-test-${Date.now()}`);

/** 种子一条存量 smithery MCP（退役前 installSmitheryRemote 的终态同形：
 *  streamable_http 注册 + `smithery:` 前缀记账行） */
function seedSmitheryMcp(slug: string, url: string): void {
  registerMcpDefinition({
    id: randomUUID(),
    name: slug,
    version: '1.0.0',
    transport: 'streamable_http',
    url,
    headers: {},
    command: '',
    args: [],
    source: 'smithery',
  });
  const db = getDb();
  db.prepare('DELETE FROM installed_packages WHERE item_id = ?').run(`smithery:${slug}`);
  db.prepare(
    `INSERT INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
     VALUES (?, ?, 'mcp', ?, '1.0.0', '', '')`,
  ).run(randomUUID(), `smithery:${slug}`, slug);
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('hub 卸载（存量 smithery 行本地卸载通道）', () => {
  it('卸载 smithery 条目：mcp 行 + 记账行同删 + 列表消失；二次卸载幂等不抛', () => {
    seedSmitheryMcp('@owner/gone', 'https://gone.run.tools');
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
  it('type 非 mcp（hub 只有 mcp）→ 空数组；mcp 行映射含描述与 transport', () => {
    seedSmitheryMcp('brave', 'https://brave.run.tools');
    expect(listHubInstalledResources('agent')).toEqual([]);
    expect(listHubInstalledResources('skill')).toEqual([]);
    const items = listHubInstalledResources('mcp');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'smithery-mcp-brave',
      type: 'mcp',
      source: 'smithery',
      installed: true,
      installable: false,
      removable: true,
      description: '远程 MCP（https://brave.run.tools）',
      custom: { transport: 'streamable_http' },
    });
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

describe('library 接入（needSmithery 合并，契约测试：真实 DB 生产 → listResources 直接消费）', () => {
  it('filter.source=smithery 短路返回已装 hub 条目；无 source 过滤时并入合并面', async () => {
    seedSmitheryMcp('@owner/weather', 'https://weather.run.tools');

    // source 短路：只取对应 hub 源
    const bySmithery = await listResources({ source: 'smithery' });
    expect(bySmithery.map((i) => i.id)).toEqual(['smithery-mcp-@owner/weather']);

    // 合并面：无 source 过滤（type=mcp）时并入（catalog 本地直读——Momo 是 agent，不在此面）
    const mcpAll = await listResources({ type: 'mcp' });
    expect(mcpAll.map((i) => i.id).sort()).toEqual([
      'smithery-mcp-@owner/weather',
    ]);
  });
});
