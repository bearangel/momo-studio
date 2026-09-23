// electron/tests/resource/ipc-handlers.test.ts
//
// Task 5 测试：resource IPC handlers 注册 + 4 通道路由。
// 重点验证 resource:delete 按 source+type 分流到对应底层删除函数。
//
// P3 Task 7 追加：resource:registerMcp（注册 custom mcp + 返回 ResourceItem）与
// resource:uploadSkill（转调 zip-uploader 返回 UploadedSkill[]）——注册面收敛到
// resource:* 命名空间（mcp:register / skill:uploadZip 退役）。
//
// P2 Task 4 追加：resource:registryProviders / resource:registryList（hub provider
// 框架 IPC 面）。hub 模块整体 mock——provider 行为由 tests/resource/hub/* 单测覆盖。
//
// P2 Task 7 追加：resource:registerMcp 二态透传（remote 输入 transport/url 传给
// registerMcpDefinition）。真实 DB 全链往返由 register-mcp-remote-contract.test.ts
// 覆盖，本文件只锁 handler 的调用形状。
//
// P2.1 Task 3 追加：resource:install smithery 分支两态（needsConfig 判定——拉详情
// 后 required 非空返回 schema 不注册；否则直装）+ 新通道 resource:installSmitheryRemote
// （needsConfig 二段安装：反解 id → 重拉详情 → 带用户配置直装）。
//
// P2.2 Task 6 追加：resource:getMcpConfig / resource:updateMcpConfig /
// resource:danglingMcpRefs 三通道（spec §4.1/§4.2/§4.3）。业务语义（三级降级 /
// compose 重组 / 悬空聚合）由 tests/resource/mcp-config.test.ts 真实 DB 覆盖，
// 本文件只锁 IPC 边界：通道注册、参数透传、返回保真、中文异常上抛、空入参防御。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// mock electron 模块（ipcMain.handle 在测试环境不存在）。
// P2.3 Task 2：补 shell.openExternal spy——misc:openExternal 校验放行后的唯一副作用，
// 经 vi.hoisted 声明共享（同 smitheryList 先例，避免 mock 工厂提升导致 TDZ）。
const { shellOpenExternal } = vi.hoisted(() => ({
  shellOpenExternal: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: shellOpenExternal },
}));

// mock library
vi.mock('../../src/main/resource/library', () => ({
  listResources: vi.fn(),
  resolveResourceById: vi.fn(),
}));

// mock 底层 delete/install
vi.mock('../../src/main/mcp/host-manager', () => ({
  deleteRegistered: vi.fn(),
  registerMcpDefinition: vi.fn(),
}));
vi.mock('../../src/main/skill/zip-uploader', () => ({
  deleteCustomSkill: vi.fn(),
  uploadSkillZip: vi.fn(),
}));
vi.mock('../../src/main/agent/crud', () => ({
  deleteDefinition: vi.fn(),
  // P2.2 Task 5：卸载级联 helper——返回空名单（IPC 路由层只锁调用事实，
  // 真实级联语义由 tests/agent/crud-remove-mcp-refs.test.ts 真 DB 覆盖）
  removeMcpRefsFromAgents: vi.fn(() => []),
}));
vi.mock('../../src/main/marketplace/installer', () => ({
  installPackage: vi.fn(),
  uninstallPackage: vi.fn(),
}));

// P2 Task 4：hub provider 模块整体 mock（真实行为由 tests/resource/hub/* 覆盖）。
// vi.mock 工厂会被提升到文件顶部——共享 spy 须经 vi.hoisted 声明，避免 TDZ。
const { smitheryList } = vi.hoisted(() => ({
  smitheryList: vi.fn(),
}));
vi.mock('../../src/main/resource/hub/smithery', () => ({
  smitheryProvider: {
    key: 'smithery', label: 'Smithery', region: 'intl', types: ['mcp'], list: smitheryList,
  },
  isSmitheryDegraded: vi.fn(() => false),
  __resetHubBackoffForTest: vi.fn(),
}));

// P2 Task 5：hub 安装/卸载模块 mock（真实链路由 tests/resource/hub-install.test.ts
// 以真实 DB + fetch 桩覆盖；本文件只测 IPC 路由分支）。
// P2.1 Task 3：installSmitheryMcp（install-config 死码）退役，换成
// fetchSmitheryDetail + installSmitheryRemote 两函数。
// P2.1 Task 5：bundle-import（DXT/MCPB 本地包导入）——真实行为由
// tests/mcp/bundle-import.test.ts 以真实 DB + AdmZip 全量覆盖；本文件仅测
// IPC handler 的转调与 delete 分支路由。
const { hubInstallMocks } = vi.hoisted(() => ({
  hubInstallMocks: {
    fetchSmitheryDetail: vi.fn(),
    installSmitheryRemote: vi.fn(),
    uninstallHubMcp: vi.fn(),
    listHubInstalledResources: vi.fn(() => []),
  },
}));
vi.mock('../../src/main/resource/hub-install', () => hubInstallMocks);
vi.mock('../../src/main/mcp/bundle-import', () => ({
  parseMcpBundle: vi.fn(),
  importMcpBundle: vi.fn(),
  uninstallMcpBundle: vi.fn(),
  isBundleInstalled: vi.fn(() => false),
  resolveBundleCommand: vi.fn(),
}));

// P2.2 Task 6：MCP 配置编辑/悬空引用服务 mock（真实链路由 tests/resource/
// mcp-config.test.ts 以真实 DB 覆盖；本文件只锁 IPC 透传形状）
const { mcpConfigMocks } = vi.hoisted(() => ({
  mcpConfigMocks: {
    getMcpConfigView: vi.fn(),
    updateRemoteMcpConfig: vi.fn(),
    listDanglingMcpRefs: vi.fn((): unknown[] => []),
  },
}));
vi.mock('../../src/main/resource/mcp-config', () => mcpConfigMocks);

// mock fetchCatalog（marketplace delete 分支需要）。catalog id 刻意不同于 ResourceItem.id，
// 以回归保护"误传 ResourceItem.id 给 uninstallPackage"的静默 no-op bug。
vi.mock('../../src/main/marketplace/client', () => ({
  fetchCatalog: vi.fn(async () => ({
    version: '1.0',
    updatedAt: '2026-08-11',
    items: [
      {
        id: 'catalog-id-remote',
        type: 'skill',
        slug: 'remote',
        name: 'Remote',
        version: '1',
        author: '@x',
        description: 'd',
        readme: 'r',
        tags: [],
        category: 'c',
        iconEmoji: '📦',
        verificationStatus: 'community',
        downloadUrl: 'http://x',
        checksum: 'x',
        sizeBytes: 0,
        installCount: 0,
      },
    ],
  })),
}));

import { ipcMain } from 'electron';
import { registerResourceHandlers } from '../../src/main/resource/ipc.handlers';
import { listResources, resolveResourceById } from '../../src/main/resource/library';
import { deleteRegistered, registerMcpDefinition } from '../../src/main/mcp/host-manager';
import { deleteCustomSkill, uploadSkillZip } from '../../src/main/skill/zip-uploader';
import {
  parseMcpBundle,
  importMcpBundle,
  uninstallMcpBundle,
  isBundleInstalled,
} from '../../src/main/mcp/bundle-import';
import { deleteDefinition, removeMcpRefsFromAgents } from '../../src/main/agent/crud';
import { uninstallPackage } from '../../src/main/marketplace/installer';
import { setBuiltinAgentsDir } from '../../src/main/agent/builtin';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('registerResourceHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerResourceHandlers();
  });

  it('注册 6 个 IPC 通道', () => {
    const channels = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(channels).toEqual(
      expect.arrayContaining([
        'resource:list',
        'resource:getDetail',
        'resource:install',
        'resource:delete',
        'resource:registerMcp',
        'resource:uploadSkill',
        // P2.1 Task 3：smithery needsConfig 二段安装通道
        'resource:installSmitheryRemote',
        // P2.1 Task 5：DXT/MCPB 本地包两阶段导入通道
        'resource:parseMcpBundle',
        'resource:importMcpBundle',
      ]),
    );
  });

  it('resource:list 调 listResources(filter)', async () => {
    (listResources as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const listCall = calls.find((c: unknown[]) => c[0] === 'resource:list');
    const handler = listCall![1] as (evt: unknown, filter: unknown) => Promise<unknown>;
    await handler({}, { type: 'mcp' });
    expect(listResources).toHaveBeenCalledWith({ type: 'mcp' });
  });

  it('resource:delete custom-mcp-* 路由到 deleteRegistered', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'custom-mcp-github',
      type: 'mcp',
      source: 'custom',
      slug: 'github',
      removable: true,
      name: 'github',
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const deleteCall = calls.find((c: unknown[]) => c[0] === 'resource:delete');
    const handler = deleteCall![1] as (evt: unknown, id: string) => Promise<void>;
    await handler({}, 'custom-mcp-github');
    expect(deleteRegistered).toHaveBeenCalledWith('github');
    // P2.2 Task 5：直删断面删行成功后级联清理 agent 引用
    expect(removeMcpRefsFromAgents).toHaveBeenCalledWith('github');
  });

  it('resource:delete builtin-* 抛错（不可移除）', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'builtin-agent-pm',
      source: 'builtin',
      removable: false,
      name: 'PM',
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const deleteCall = calls.find((c: unknown[]) => c[0] === 'resource:delete');
    const handler = deleteCall![1] as (evt: unknown, id: string) => Promise<void>;
    await expect(handler({}, 'builtin-agent-pm')).rejects.toThrow(/系统预置不可移除/);
  });

  it('resource:delete custom-skill-* 路由到 deleteCustomSkill', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'custom-skill-xlsx',
      type: 'skill',
      source: 'custom',
      slug: 'xlsx',
      removable: true,
      name: 'xlsx',
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const deleteCall = calls.find((c: unknown[]) => c[0] === 'resource:delete');
    const handler = deleteCall![1] as (evt: unknown, id: string) => Promise<void>;
    await handler({}, 'custom-skill-xlsx');
    expect(deleteCustomSkill).toHaveBeenCalledWith('xlsx');
  });

  it('resource:delete custom-agent-* 路由到 deleteDefinition', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'custom-agent-uuid1',
      type: 'agent',
      source: 'custom',
      slug: 'uuid1',
      removable: true,
      name: 'my agent',
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const deleteCall = calls.find((c: unknown[]) => c[0] === 'resource:delete');
    const handler = deleteCall![1] as (evt: unknown, id: string) => Promise<void>;
    await handler({}, 'custom-agent-uuid1');
    expect(deleteDefinition).toHaveBeenCalledWith('uuid1');
  });

  it('resource:delete marketplace-* 路由到 uninstallPackage（传 catalog id，非 ResourceItem.id）', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'marketplace-skill-remote',
      type: 'skill',
      source: 'marketplace',
      slug: 'remote',
      removable: true,
      name: 'remote',
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const deleteCall = calls.find((c: unknown[]) => c[0] === 'resource:delete');
    const handler = deleteCall![1] as (evt: unknown, id: string) => Promise<void>;
    await handler({}, 'marketplace-skill-remote');
    // 必须传 catalog 的 MarketplaceItem.id（'catalog-id-remote'），不是 ResourceItem.id
    // （'marketplace-skill-remote'）——后者会让 uninstallPackage 查无此行触发静默 no-op。
    expect(uninstallPackage).toHaveBeenCalledWith('catalog-id-remote');
  });

  it('resource:registerMcp 转调 registerMcpDefinition（source=custom，id/version 主进程补全）', async () => {
    const item = {
      id: 'custom-mcp-github',
      type: 'mcp',
      source: 'custom',
      slug: 'github',
      name: 'github',
      description: '自定义 MCP（npx）',
      installed: true,
      installable: false,
      removable: true,
    };
    (listResources as ReturnType<typeof vi.fn>).mockResolvedValueOnce([item]);
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const registerCall = calls.find((c: unknown[]) => c[0] === 'resource:registerMcp');
    const handler = registerCall![1] as (
      evt: unknown,
      config: { name: string; command: string; args?: string[]; env?: Record<string, string> },
    ) => Promise<unknown>;
    const result = await handler({}, {
      name: 'github',
      command: 'npx',
      args: ['-y', 'server.js'],
      env: { API_KEY: 'secret' },
    });
    expect(registerMcpDefinition).toHaveBeenCalledTimes(1);
    const config = (registerMcpDefinition as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(config).toMatchObject({
      name: 'github',
      command: 'npx',
      args: ['-y', 'server.js'],
      env: { API_KEY: 'secret' },
      source: 'custom',
    });
    // stdio 路径不受二态扩展污染：不传 transport/url 时两字段不落入注册配置
    expect(config.transport).toBeUndefined();
    expect(config.url).toBeUndefined();
    expect(typeof config.id).toBe('string');
    expect((config.id as string).length).toBeGreaterThan(0);
    expect(typeof config.version).toBe('string');
    expect((config.version as string).length).toBeGreaterThan(0);
    expect(result).toBe(item);
  });

  it('resource:registerMcp remote 输入透传 transport/url（command 空串占位）', async () => {
    const item = {
      id: 'custom-mcp-weather',
      type: 'mcp',
      source: 'custom',
      slug: 'weather',
      name: 'weather',
      description: '自定义 MCP（）',
      installed: true,
      installable: false,
      removable: true,
    };
    (listResources as ReturnType<typeof vi.fn>).mockResolvedValueOnce([item]);
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const registerCall = calls.find((c: unknown[]) => c[0] === 'resource:registerMcp');
    const handler = registerCall![1] as (
      evt: unknown,
      config: {
        name: string;
        command: string;
        transport?: 'stdio' | 'streamable_http';
        url?: string;
      },
    ) => Promise<unknown>;
    const result = await handler({}, {
      name: 'weather',
      command: '',
      transport: 'streamable_http',
      url: 'https://mcp.example.com/sse',
    });
    expect(registerMcpDefinition).toHaveBeenCalledTimes(1);
    const config = (registerMcpDefinition as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(config).toMatchObject({
      name: 'weather',
      command: '',
      transport: 'streamable_http',
      url: 'https://mcp.example.com/sse',
      source: 'custom',
    });
    expect(result).toBe(item);
  });

  it('resource:registerMcp 用 filter={type:mcp, source:custom} 从 custom 映射取回条目', async () => {
    (listResources as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const registerCall = calls.find((c: unknown[]) => c[0] === 'resource:registerMcp');
    const handler = registerCall![1] as (
      evt: unknown,
      config: { name: string; command: string },
    ) => Promise<unknown>;
    await expect(handler({}, { name: 'gone', command: 'c' })).rejects.toThrow(/gone/);
    expect(listResources).toHaveBeenCalledWith({ type: 'mcp', source: 'custom' });
  });

  it('resource:uploadSkill 转调 uploadSkillZip（Uint8Array 转 Buffer）并返回 UploadedSkill[]', async () => {
    const uploaded = [{ slug: 'demo', name: 'Demo', description: '示例 skill' }];
    (uploadSkillZip as ReturnType<typeof vi.fn>).mockReturnValueOnce(uploaded);
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const uploadCall = calls.find((c: unknown[]) => c[0] === 'resource:uploadSkill');
    const handler = uploadCall![1] as (
      evt: unknown,
      data: Uint8Array,
      filename: string,
    ) => Promise<unknown>;
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const result = await handler({}, bytes, 'demo.zip');
    expect(uploadSkillZip).toHaveBeenCalledTimes(1);
    const [buf, filename] = (uploadSkillZip as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Buffer,
      string,
    ];
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.equals(Buffer.from(bytes))).toBe(true);
    expect(filename).toBe('demo.zip');
    expect(result).toBe(uploaded);
  });

  it('注册 registryProviders / registryList 通道', () => {
    const channels = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(channels).toEqual(
      expect.arrayContaining(['resource:registryProviders', 'resource:registryList']),
    );
  });

  it('resource:registryProviders 返回 builtin + hub（degraded 取各自封装）', async () => {
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const metaCall = calls.find((c: unknown[]) => c[0] === 'resource:registryProviders');
    const handler = metaCall![1] as () => Promise<unknown>;
    const providers = (await handler()) as Array<{
      key: string; label: string; region: string; types: string[]; degraded: boolean;
    }>;
    expect(providers.map((p) => p.key)).toEqual(['builtin', 'smithery']);
    expect(providers[0]).toMatchObject({ region: 'local', degraded: false });
    expect(providers[0]!.types).toEqual(['agent', 'mcp', 'skill']);
    expect(providers[1]).toMatchObject({ label: 'Smithery', region: 'intl', degraded: false });
  });

  it('resource:registryList builtin 分支：marketplace 源 + 前端同款过滤排序映射（hasMore 恒 false）', async () => {
    const items = [
      {
        id: 'marketplace-mcp-installed', type: 'mcp', source: 'marketplace', slug: 'installed',
        name: '已装服务', description: 'd1', installed: true, installable: false,
        marketplace: { author: 'a', readme: 'r', downloadUrl: '', checksum: '', verificationStatus: 'community', tags: ['t'], category: 'c1' },
      },
      {
        id: 'marketplace-mcp-fs', type: 'mcp', source: 'marketplace', slug: 'fs-tool',
        name: 'File System', description: '文件系统', installed: false, installable: true,
        marketplace: { author: 'a', readme: 'r', downloadUrl: '', checksum: '', verificationStatus: 'community', tags: [], category: 'c2' },
      },
      {
        id: 'marketplace-mcp-other', type: 'mcp', source: 'marketplace', slug: 'other',
        name: 'Other', description: '无关条目', installed: false, installable: true,
        marketplace: { author: 'a', readme: 'r', downloadUrl: '', checksum: '', verificationStatus: 'community', tags: [], category: 'c3' },
      },
    ];
    (listResources as ReturnType<typeof vi.fn>).mockResolvedValueOnce(items);
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const listCall = calls.find((c: unknown[]) => c[0] === 'resource:registryList');
    const handler = listCall![1] as (
      evt: unknown,
      providerKey: string,
      type: string,
      query?: string,
      page?: number,
    ) => Promise<{ entries: Array<{ id: string; tags: string[]; category?: string }>; degraded: boolean; hasMore: boolean }>;
    const result = await handler({}, 'builtin', 'mcp', 'file', 1);
    expect(listResources).toHaveBeenCalledWith({ type: 'mcp', source: 'marketplace' });
    expect(result.degraded).toBe(false);
    // builtin 是本地全量目录，无服务端分页——page 参数被忽略且 hasMore 恒 false
    expect(result.hasMore).toBe(false);
    // 「file」只命中 File System（name 模糊）；installed 排序垫底语义由下方无 query 用例覆盖
    expect(result.entries.map((e) => e.id)).toEqual(['marketplace-mcp-fs']);
    expect(result.entries[0]!.tags).toEqual([]);
    expect(result.entries[0]!.category).toBe('c2');

    // 无 query：全量返回且未安装在前、已安装垫底（与 renderer catalog provider 同语义）
    (listResources as ReturnType<typeof vi.fn>).mockResolvedValueOnce(items);
    const all = await handler({}, 'builtin', 'mcp');
    expect(all.entries.map((e) => e.id)).toEqual([
      'marketplace-mcp-fs', 'marketplace-mcp-other', 'marketplace-mcp-installed',
    ]);
    expect(all.hasMore).toBe(false);
  });

  it('resource:registryList hub 分支委托对应 provider.list（query / page 透传 + hasMore 透出）', async () => {
    smitheryList.mockResolvedValueOnce({ entries: [], degraded: false, hasMore: true });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const listCall = calls.find((c: unknown[]) => c[0] === 'resource:registryList');
    const handler = listCall![1] as (
      evt: unknown,
      providerKey: string,
      type: string,
      query?: string,
      page?: number,
    ) => Promise<unknown>;
    const result = await handler({}, 'smithery', 'mcp', 'weather', 2);
    expect(smitheryList).toHaveBeenCalledWith('mcp', 'weather', 2);
    expect(result).toEqual({ entries: [], degraded: false, hasMore: true });
  });

  it('resource:registryList 未知 provider 抛错', async () => {
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const listCall = calls.find((c: unknown[]) => c[0] === 'resource:registryList');
    const handler = listCall![1] as (
      evt: unknown,
      providerKey: string,
      type: string,
    ) => Promise<unknown>;
    await expect(handler({}, 'mcphub', 'mcp')).rejects.toThrow(/未知 registry provider/);
  });

  it('resource:install hub 分支（P2.1 Task 3 两态）：未装 smithery 条目 → 拉详情直装 + needsConfig:false', async () => {
    // 未安装的 registry 条目不在 library（library 只映射已装行）→ resolve 返回 null
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const schema = { properties: { token: { type: 'string' } } };
    hubInstallMocks.fetchSmitheryDetail.mockResolvedValueOnce({
      connections: [{ type: 'http', deploymentUrl: 'https://brave.run.tools', configSchema: schema }],
    });
    hubInstallMocks.installSmitheryRemote.mockResolvedValueOnce(undefined);
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const installCall = calls.find((c: unknown[]) => c[0] === 'resource:install');
    const handler = installCall![1] as (evt: unknown, id: string) => Promise<unknown>;
    const result = await handler({}, 'smithery-mcp-@owner/weather');
    // slug 是完整 qualifiedName（含 @ 与 /），id 贪婪反解整体透传
    expect(hubInstallMocks.fetchSmitheryDetail).toHaveBeenCalledWith('@owner/weather');
    expect(hubInstallMocks.installSmitheryRemote).toHaveBeenCalledWith(
      '@owner/weather', 'https://brave.run.tools', {}, schema,
    );
    expect(result).toEqual({ needsConfig: false });
  });

  it('resource:install smithery：configSchema.required 非空 → needsConfig:true 带 schema，不注册', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const schema = {
      required: ['braveApiKey'],
      properties: { braveApiKey: { type: 'string', title: 'Brave API Key', 'x-from': 'header' } },
    };
    hubInstallMocks.fetchSmitheryDetail.mockResolvedValueOnce({
      connections: [{ type: 'http', deploymentUrl: 'https://brave.run.tools', configSchema: schema }],
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const installCall = calls.find((c: unknown[]) => c[0] === 'resource:install');
    const handler = installCall![1] as (evt: unknown, id: string) => Promise<unknown>;
    const result = await handler({}, 'smithery-mcp-brave');
    // 两态分支：需要用户补配置——绝不触发安装（Task 6 弹窗收集后走二段通道）
    expect(hubInstallMocks.installSmitheryRemote).not.toHaveBeenCalled();
    expect(result).toEqual({ needsConfig: true, schema });
  });

  it('resource:install smithery：deploymentUrl 缺失 → 抛「暂不可直连」且不安装', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    hubInstallMocks.fetchSmitheryDetail.mockResolvedValueOnce({ connections: [{}] });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const installCall = calls.find((c: unknown[]) => c[0] === 'resource:install');
    const handler = installCall![1] as (evt: unknown, id: string) => Promise<unknown>;
    await expect(handler({}, 'smithery-mcp-oauth-only')).rejects.toThrow(
      /该服务器暂不可直连（可能需要 Smithery 托管 OAuth）/,
    );
    expect(hubInstallMocks.installSmitheryRemote).not.toHaveBeenCalled();
  });

  // 终审 Minor-2：API 响应缺 connections 字段时 detail.connections[0] 抛英文 TypeError
  // （pino/console.error 链路会把 TypeError 原文抛给 renderer，可读性 0）。
  // 该测试为回归锁：任何重写 installSmitheryEntry / installSmitheryRemote 取连接的代码
  // 若未做形状防御必失败。配合 ipc.handlers.ts 的 Array.isArray 守卫阅读。
  it('resource:install smithery：响应缺 connections → 抛「暂不可直连」中文错误而非 TypeError', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    // {}——无 connections 键，最小退化响应
    hubInstallMocks.fetchSmitheryDetail.mockResolvedValueOnce({});
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const installCall = calls.find((c: unknown[]) => c[0] === 'resource:install');
    const handler = installCall![1] as (evt: unknown, id: string) => Promise<unknown>;
    await expect(handler({}, 'smithery-mcp-empty')).rejects.toThrow(
      /该服务器暂不可直连（可能需要 Smithery 托管 OAuth）/,
    );
    expect(hubInstallMocks.installSmitheryRemote).not.toHaveBeenCalled();
  });

  // 复审网眼补：installSmitheryRemote 通道（site #2）的镜像退化用例——
  // 既有 { connections: [] } 用例对「无守卫也绿」（空数组索引不抛 TypeError），本例用 {}
  // 才能锁死 ipc.handlers.ts 中 resource:installSmitheryRemote handler 的 Array.isArray 防御。
  it('resource:installSmitheryRemote：响应缺 connections → 同样抛中文错误而非 TypeError', async () => {
    hubInstallMocks.fetchSmitheryDetail.mockResolvedValueOnce({});
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const remoteCall = calls.find(
      (c: unknown[]) => c[0] === 'resource:installSmitheryRemote',
    );
    const handler = remoteCall![1] as (
      evt: unknown,
      id: string,
      config: Record<string, string>,
    ) => Promise<void>;
    await expect(handler({}, 'smithery-mcp-empty2', {})).rejects.toThrow(
      /该服务器暂不可直连（可能需要 Smithery 托管 OAuth）/,
    );
    expect(hubInstallMocks.installSmitheryRemote).not.toHaveBeenCalled();
  });

  it('resource:install smithery：deploymentUrl 非 https → 抛「暂不可直连」且不安装', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    hubInstallMocks.fetchSmitheryDetail.mockResolvedValueOnce({
      connections: [{ deploymentUrl: 'http://plain.run.tools' }],
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const installCall = calls.find((c: unknown[]) => c[0] === 'resource:install');
    const handler = installCall![1] as (evt: unknown, id: string) => Promise<unknown>;
    await expect(handler({}, 'smithery-mcp-insecure')).rejects.toThrow(/暂不可直连/);
    expect(hubInstallMocks.installSmitheryRemote).not.toHaveBeenCalled();
  });

  it('resource:installSmitheryRemote：反解 id → 重拉详情（schema 真源）→ 带用户配置直装', async () => {
    const schema = {
      required: ['braveApiKey'],
      properties: { braveApiKey: { type: 'string', 'x-from': 'header' } },
    };
    hubInstallMocks.fetchSmitheryDetail.mockResolvedValueOnce({
      connections: [{ deploymentUrl: 'https://brave.run.tools', configSchema: schema }],
    });
    hubInstallMocks.installSmitheryRemote.mockResolvedValueOnce(undefined);
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const remoteCall = calls.find((c: unknown[]) => c[0] === 'resource:installSmitheryRemote');
    const handler = remoteCall![1] as (
      evt: unknown,
      id: string,
      config: Record<string, string>,
    ) => Promise<void>;
    await handler({}, 'smithery-mcp-@owner/weather', { braveApiKey: 'k9' });
    // 重拉详情保持 schema 真源（不信任 renderer 回传），配置原样透传
    expect(hubInstallMocks.fetchSmitheryDetail).toHaveBeenCalledWith('@owner/weather');
    expect(hubInstallMocks.installSmitheryRemote).toHaveBeenCalledWith(
      '@owner/weather', 'https://brave.run.tools', { braveApiKey: 'k9' }, schema,
    );
  });

  it('resource:installSmitheryRemote：非 smithery MCP id 抛错', async () => {
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const remoteCall = calls.find((c: unknown[]) => c[0] === 'resource:installSmitheryRemote');
    const handler = remoteCall![1] as (
      evt: unknown,
      id: string,
      config: Record<string, string>,
    ) => Promise<void>;
    await expect(handler({}, 'custom-mcp-github', {})).rejects.toThrow(/非 smithery/);
    expect(hubInstallMocks.fetchSmitheryDetail).not.toHaveBeenCalled();
  });

  it('resource:installSmitheryRemote：详情缺 deploymentUrl → 抛「暂不可直连」', async () => {
    hubInstallMocks.fetchSmitheryDetail.mockResolvedValueOnce({ connections: [] });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const remoteCall = calls.find((c: unknown[]) => c[0] === 'resource:installSmitheryRemote');
    const handler = remoteCall![1] as (
      evt: unknown,
      id: string,
      config: Record<string, string>,
    ) => Promise<void>;
    await expect(handler({}, 'smithery-mcp-gone', {})).rejects.toThrow(/暂不可直连/);
    expect(hubInstallMocks.installSmitheryRemote).not.toHaveBeenCalled();
  });

  it('resource:delete smithery 条目路由到 uninstallHubMcp（switch 前提前 return）', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'smithery-mcp-@owner/weather',
      type: 'mcp',
      source: 'smithery',
      slug: '@owner/weather',
      removable: true,
      name: 'weather',
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const deleteCall = calls.find((c: unknown[]) => c[0] === 'resource:delete');
    const handler = deleteCall![1] as (evt: unknown, id: string) => Promise<void>;
    await handler({}, 'smithery-mcp-@owner/weather');
    expect(hubInstallMocks.uninstallHubMcp).toHaveBeenCalledWith('smithery', '@owner/weather');
  });

  // P2.1 Task 5：DXT/MCPB 本地包两阶段导入 handler 契约 + delete custom+mcp 分支路由
  describe('P2.1 Task 5 DXT/MCPB 本地包', () => {
    it('resource:parseMcpBundle 转调 parseMcpBundle（Uint8Array → Buffer）', async () => {
      const preview = {
        name: 'demo',
        displayName: 'Demo',
        version: '1.0.0',
        description: 'd',
        serverType: 'node' as const,
        commandPreview: 'node x.js',
        userConfigSchema: {},
        tempId: 'tid-1',
      };
      (parseMcpBundle as ReturnType<typeof vi.fn>).mockReturnValueOnce(preview);
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const parseCall = calls.find((c: unknown[]) => c[0] === 'resource:parseMcpBundle');
      const handler = parseCall![1] as (
        evt: unknown,
        data: Uint8Array,
        filename: string,
      ) => Promise<unknown>;
      const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      const result = await handler({}, bytes, 'demo.mcpb');
      expect(parseMcpBundle).toHaveBeenCalledTimes(1);
      const [buf, filename] = (parseMcpBundle as ReturnType<typeof vi.fn>).mock.calls[0] as [
        Buffer,
        string,
      ];
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.equals(Buffer.from(bytes))).toBe(true);
      expect(filename).toBe('demo.mcpb');
      expect(result).toBe(preview);
    });

    it('resource:importMcpBundle 转调 importMcpBundle（Uint8Array → Buffer + userConfig 透传）', async () => {
      const item = {
        id: 'custom-mcp-demo',
        type: 'mcp',
        source: 'custom',
        slug: 'demo',
        name: 'Demo',
        description: 'd',
        installed: true,
        installable: false,
        removable: true,
      };
      (importMcpBundle as ReturnType<typeof vi.fn>).mockReturnValueOnce(item);
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const importCall = calls.find((c: unknown[]) => c[0] === 'resource:importMcpBundle');
      const handler = importCall![1] as (
        evt: unknown,
        data: Uint8Array,
        filename: string,
        userConfig: Record<string, string>,
      ) => Promise<unknown>;
      const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      const userConfig = { apiKey: 'k1' };
      const result = await handler({}, bytes, 'demo.mcpb', userConfig);
      expect(importMcpBundle).toHaveBeenCalledTimes(1);
      const [buf, filename, cfg] = (importMcpBundle as ReturnType<typeof vi.fn>).mock.calls[0] as [
        Buffer,
        string,
        Record<string, string>,
      ];
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.equals(Buffer.from(bytes))).toBe(true);
      expect(filename).toBe('demo.mcpb');
      expect(cfg).toBe(userConfig);
      expect(result).toBe(item);
    });

    it('resource:delete custom-mcp bundle 条目路由到 uninstallMcpBundle（不调 deleteRegistered）', async () => {
      (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'custom-mcp-demo-bundle',
        type: 'mcp',
        source: 'custom',
        slug: 'demo-bundle',
        removable: true,
        name: 'Demo Bundle',
      });
      (isBundleInstalled as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const deleteCall = calls.find((c: unknown[]) => c[0] === 'resource:delete');
      const handler = deleteCall![1] as (evt: unknown, id: string) => Promise<void>;
      await handler({}, 'custom-mcp-demo-bundle');
      expect(isBundleInstalled).toHaveBeenCalledWith('demo-bundle');
      expect(uninstallMcpBundle).toHaveBeenCalledWith('demo-bundle');
      expect(deleteRegistered).not.toHaveBeenCalled();
      // 级联在 uninstallMcpBundle 内部（真实链路），IPC 层不重复挂——防双重级联
      expect(removeMcpRefsFromAgents).not.toHaveBeenCalled();
    });

    it('resource:delete custom-mcp 非 bundle 条目维持原 deleteRegistered（路由判据 isBundleInstalled=false）', async () => {
      (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'custom-mcp-plain',
        type: 'mcp',
        source: 'custom',
        slug: 'plain',
        removable: true,
        name: 'plain',
      });
      // isBundleInstalled 默认返回 false（mock 工厂）→ deleteRegistered 路径
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const deleteCall = calls.find((c: unknown[]) => c[0] === 'resource:delete');
      const handler = deleteCall![1] as (evt: unknown, id: string) => Promise<void>;
      await handler({}, 'custom-mcp-plain');
      expect(isBundleInstalled).toHaveBeenCalledWith('plain');
      expect(uninstallMcpBundle).not.toHaveBeenCalled();
      expect(deleteRegistered).toHaveBeenCalledWith('plain');
      // P2.2 Task 5：非 bundle 直删断面同样级联清理 agent 引用
      expect(removeMcpRefsFromAgents).toHaveBeenCalledWith('plain');
    });
  });

  // P2.2 Task 6：MCP 配置编辑 / 悬空引用三通道（spec §4.1/§4.2/§4.3）。
  // McpConfigView 契约关键字段在透传用例中深锁（bare=true 时 schema 缺省、
  // schema 模式 values/url 形状）——renderer types.d.ts 镜像消费同一形状。
  describe('P2.2 Task 6 MCP 配置编辑 / 悬空引用', () => {
    it('注册 getMcpConfig / updateMcpConfig / danglingMcpRefs 三通道', () => {
      const channels = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0],
      );
      expect(channels).toEqual(
        expect.arrayContaining([
          'resource:getMcpConfig',
          'resource:updateMcpConfig',
          'resource:danglingMcpRefs',
        ]),
      );
    });

    it('resource:getMcpConfig 透传 name 并保真返回 view（bare 模式 schema 键缺省）', async () => {
      const view = {
        name: '@owner/context7',
        transport: 'streamable_http' as const,
        bare: true,
        values: {},
        url: 'https://ctx.example.com/mcp?key=k1',
        headers: { Authorization: 'Bearer k1' },
      };
      mcpConfigMocks.getMcpConfigView.mockResolvedValueOnce(view);
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const configCall = calls.find((c: unknown[]) => c[0] === 'resource:getMcpConfig');
      const handler = configCall![1] as (evt: unknown, name: string) => Promise<unknown>;
      const result = await handler({}, '@owner/context7');
      expect(mcpConfigMocks.getMcpConfigView).toHaveBeenCalledWith('@owner/context7');
      expect(result).toEqual(view);
      // 契约锁（spec §4.1）：bare=true 时 schema 缺省——renderer 镜像 schema?:
      // 与 electron 端同形，编辑弹窗按 bare 分支渲染
      expect('schema' in (result as Record<string, unknown>)).toBe(false);
    });

    it('resource:getMcpConfig schema 模式 view 保真透传（schema/values/url 关键字段）', async () => {
      const view = {
        name: 'brave',
        transport: 'streamable_http' as const,
        bare: false,
        schema: {
          required: ['apiKey'],
          properties: { apiKey: { title: 'API Key', 'x-from': 'header' as const } },
        },
        values: { apiKey: 'k9' },
        url: 'https://brave.run.tools?projectId=p1',
        headers: {},
      };
      mcpConfigMocks.getMcpConfigView.mockResolvedValueOnce(view);
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const configCall = calls.find((c: unknown[]) => c[0] === 'resource:getMcpConfig');
      const handler = configCall![1] as (evt: unknown, name: string) => Promise<unknown>;
      const result = await handler({}, 'brave');
      expect(mcpConfigMocks.getMcpConfigView).toHaveBeenCalledWith('brave');
      expect(result).toEqual(view);
    });

    it('resource:getMcpConfig name 空串 / 缺省 → 中文错误且不调服务', async () => {
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const configCall = calls.find((c: unknown[]) => c[0] === 'resource:getMcpConfig');
      const handler = configCall![1] as (evt: unknown, name: string) => Promise<unknown>;
      await expect(handler({}, '')).rejects.toThrow(/MCP 名不能为空/);
      await expect(handler({}, undefined as unknown as string)).rejects.toThrow(/MCP 名不能为空/);
      expect(mcpConfigMocks.getMcpConfigView).not.toHaveBeenCalled();
    });

    it('resource:getMcpConfig 服务层中文错误原样上抛（不吞不改）', async () => {
      mcpConfigMocks.getMcpConfigView.mockRejectedValueOnce(
        new Error('MCP gone 未注册'),
      );
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const configCall = calls.find((c: unknown[]) => c[0] === 'resource:getMcpConfig');
      const handler = configCall![1] as (evt: unknown, name: string) => Promise<unknown>;
      await expect(handler({}, 'gone')).rejects.toThrow(/MCP gone 未注册/);
    });

    it('resource:updateMcpConfig 透传 name + input（headers 仅裸模式、schema 可选——IPC 层不判模式）', async () => {
      mcpConfigMocks.updateRemoteMcpConfig.mockResolvedValueOnce(undefined);
      const input = {
        url: 'https://brave.run.tools',
        config: { apiKey: 'k2' },
        headers: { 'X-Custom': 'y' },
        schema: { properties: { apiKey: { 'x-from': 'header' as const } } },
      };
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const updateCall = calls.find((c: unknown[]) => c[0] === 'resource:updateMcpConfig');
      const handler = updateCall![1] as (
        evt: unknown,
        name: string,
        input: unknown,
      ) => Promise<unknown>;
      const result = await handler({}, 'brave', input);
      expect(mcpConfigMocks.updateRemoteMcpConfig).toHaveBeenCalledWith('brave', input);
      expect(result).toBeUndefined();
    });

    it('resource:updateMcpConfig name 空串 / 缺省 → 中文错误且不调服务', async () => {
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const updateCall = calls.find((c: unknown[]) => c[0] === 'resource:updateMcpConfig');
      const handler = updateCall![1] as (
        evt: unknown,
        name: string,
        input: unknown,
      ) => Promise<unknown>;
      await expect(handler({}, '', { url: 'https://x', config: {} })).rejects.toThrow(
        /MCP 名不能为空/,
      );
      await expect(
        handler({}, undefined as unknown as string, { url: 'https://x', config: {} }),
      ).rejects.toThrow(/MCP 名不能为空/);
      expect(mcpConfigMocks.updateRemoteMcpConfig).not.toHaveBeenCalled();
    });

    it('resource:updateMcpConfig 服务层中文错误原样上抛（https 防线文案）', async () => {
      mcpConfigMocks.updateRemoteMcpConfig.mockRejectedValueOnce(
        new Error('远程 MCP brave 配置更新失败：url 必须以 https:// 开头'),
      );
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const updateCall = calls.find((c: unknown[]) => c[0] === 'resource:updateMcpConfig');
      const handler = updateCall![1] as (
        evt: unknown,
        name: string,
        input: unknown,
      ) => Promise<unknown>;
      await expect(handler({}, 'brave', { url: 'http://insecure', config: {} })).rejects.toThrow(
        /必须以 https:\/\/ 开头/,
      );
    });

    it('resource:danglingMcpRefs 透传返回扫描结果（refName + agents 聚合形状）', async () => {
      const refs = [
        {
          refName: 'filesystem',
          agents: [
            { definitionId: 'uuid-1', name: 'coder' },
            { definitionId: 'uuid-2', name: 'requirement-analyst' },
          ],
        },
      ];
      mcpConfigMocks.listDanglingMcpRefs.mockReturnValueOnce(refs);
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const danglingCall = calls.find((c: unknown[]) => c[0] === 'resource:danglingMcpRefs');
      const handler = danglingCall![1] as () => Promise<unknown>;
      const result = await handler();
      expect(result).toEqual(refs);
    });

    it('resource:danglingMcpRefs 空结果透传（卡片静默不显示）', async () => {
      mcpConfigMocks.listDanglingMcpRefs.mockReturnValueOnce([]);
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const danglingCall = calls.find((c: unknown[]) => c[0] === 'resource:danglingMcpRefs');
      const handler = danglingCall![1] as () => Promise<unknown>;
      const result = await handler();
      expect(result).toEqual([]);
    });
  });

  // P2.3 Task 2（spec 2026-09-23 §5/§6/§7）：预置清单只读 + 外链打开两通道。
  // listBuiltinPresets 不 mock 解析链——默认目录解析 electron/resources/agents 下
  // 4 个真 YAML，锁「真产物」契约（slug/name/emoji 均为生产消费字段）；openExternal
  // 用 shell spy 锁校验门（放行才触达 shell，拒绝路径 shell 必须零调用）。
  describe('P2.3 Task 2 预置清单 + 外链打开', () => {
    it('注册 resource:listBuiltinPresets / misc:openExternal 通道', () => {
      const channels = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0],
      );
      expect(channels).toEqual(
        expect.arrayContaining(['resource:listBuiltinPresets', 'misc:openExternal']),
      );
    });

    it("resource:listBuiltinPresets('agent') 返回 4 个真 YAML 预置（含 office-assistant）", async () => {
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const presetCall = calls.find((c: unknown[]) => c[0] === 'resource:listBuiltinPresets');
      const handler = presetCall![1] as (evt: unknown, type: string) => Promise<unknown>;
      const presets = (await handler({}, 'agent')) as Array<{
        slug: string;
        name: string;
        description: string;
        iconEmoji: string;
      }>;
      expect(presets.map((p) => p.slug)).toEqual([
        'coder',
        'office-assistant',
        'pm-agent',
        'requirement-analyst',
      ]);
      // 每条都是生产消费字段：四字段全为非空字符串（清单卡片直接渲染）
      for (const p of presets) {
        expect(typeof p.slug).toBe('string');
        expect(p.slug.length).toBeGreaterThan(0);
        expect(typeof p.name).toBe('string');
        expect(p.name.length).toBeGreaterThan(0);
        expect(typeof p.description).toBe('string');
        expect(p.description.length).toBeGreaterThan(0);
        expect(typeof p.iconEmoji).toBe('string');
        expect(p.iconEmoji.length).toBeGreaterThan(0);
      }
      const office = presets.find((p) => p.slug === 'office-assistant');
      expect(office).toMatchObject({ name: '办公助理', iconEmoji: '💼' });
      const coder = presets.find((p) => p.slug === 'coder');
      expect(coder).toMatchObject({ name: '程序员', iconEmoji: '💻' });
    });

    it("resource:listBuiltinPresets('mcp') / ('skill') 返回空数组（当前预置仅 agent）", async () => {
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const presetCall = calls.find((c: unknown[]) => c[0] === 'resource:listBuiltinPresets');
      const handler = presetCall![1] as (evt: unknown, type: string) => Promise<unknown>;
      expect(await handler({}, 'mcp')).toEqual([]);
      expect(await handler({}, 'skill')).toEqual([]);
    });

    it('resource:listBuiltinPresets 非法 type → 中文错误', async () => {
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const presetCall = calls.find((c: unknown[]) => c[0] === 'resource:listBuiltinPresets');
      const handler = presetCall![1] as (evt: unknown, type: unknown) => Promise<unknown>;
      await expect(handler({}, 'plugin')).rejects.toThrow(/资源类型非法/);
      await expect(handler({}, undefined)).rejects.toThrow(/资源类型非法/);
    });

    it('misc:openExternal https 链接放行 → shell.openExternal 原样透传', async () => {
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const openCall = calls.find((c: unknown[]) => c[0] === 'misc:openExternal');
      const handler = openCall![1] as (evt: unknown, url: string) => Promise<void>;
      await handler({}, 'https://smithery.io/');
      expect(shellOpenExternal).toHaveBeenCalledWith('https://smithery.io/');
      expect(shellOpenExternal).toHaveBeenCalledTimes(1);
    });

    it('misc:openExternal http:// 前缀 → 中文拒绝且 shell 不被调', async () => {
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const openCall = calls.find((c: unknown[]) => c[0] === 'misc:openExternal');
      const handler = openCall![1] as (evt: unknown, url: string) => Promise<void>;
      await expect(handler({}, 'http://insecure.example.com/')).rejects.toThrow(/https/);
      expect(shellOpenExternal).not.toHaveBeenCalled();
    });

    it('misc:openExternal 空串 → 中文拒绝且 shell 不被调', async () => {
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const openCall = calls.find((c: unknown[]) => c[0] === 'misc:openExternal');
      const handler = openCall![1] as (evt: unknown, url: string) => Promise<void>;
      await expect(handler({}, '')).rejects.toThrow(/链接不能为空/);
      expect(shellOpenExternal).not.toHaveBeenCalled();
    });

    it('misc:openExternal 非字符串入参 → 中文拒绝且 shell 不被调', async () => {
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const openCall = calls.find((c: unknown[]) => c[0] === 'misc:openExternal');
      const handler = openCall![1] as (evt: unknown, url: unknown) => Promise<void>;
      await expect(handler({}, undefined)).rejects.toThrow(/链接不能为空/);
      await expect(handler({}, 12345)).rejects.toThrow(/链接不能为空/);
      expect(shellOpenExternal).not.toHaveBeenCalled();
    });
  });

  // P2.3 Task 3 顺手补 Task 2 审查 Minor-1：listBuiltinPresets 两条错误路径。
  // agent/builtin 在本文件未 mock——真解析链经 setBuiltinAgentsDir 钩子切到
  // 临时目录（momo-test-rules：不硬造 mock，钩子可达就走真实实现）。
  describe('P2.3 Task 2 审查 Minor-1：listBuiltinPresets 错误路径', () => {
    const tmpRoot = path.join(os.tmpdir(), `ap-preset-err-${Date.now()}-${process.pid}`);

    afterEach(() => {
      // 恢复默认目录（electron/resources/agents），避免污染同文件真 YAML 用例
      setBuiltinAgentsDir(null);
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    const getPresetHandler = (): ((evt: unknown, type: string) => Promise<unknown>) => {
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const presetCall = calls.find((c: unknown[]) => c[0] === 'resource:listBuiltinPresets');
      return presetCall![1] as (evt: unknown, type: string) => Promise<unknown>;
    };

    it('目录缺失 → reject 中文错误含「不存在」', async () => {
      setBuiltinAgentsDir(path.join(tmpRoot, 'does-not-exist'));
      await expect(getPresetHandler()({}, 'agent')).rejects.toThrow(/不存在/);
    });

    it('坏 YAML 文件 → 该条跳过、其余正常返回，整体不抛', async () => {
      const agentDir = path.join(tmpRoot, 'agents');
      fs.mkdirSync(agentDir, { recursive: true });
      // 一个合法 manifest（slug 决定清单条目）+ 一个必然解析失败的坏文件
      fs.writeFileSync(
        path.join(agentDir, 'good-one.yaml'),
        [
          'apiVersion: v1',
          'kind: AgentDefinition',
          'metadata:',
          '  name: 预置甲',
          '  slug: good-one',
          '  version: 1.0.0',
          'spec:',
          '  type: standalone',
          '  runtime: declarative',
          '  declarative:',
          '    systemPrompt: "你是预置甲"',
          '    model:',
          '      provider: openai',
          '      model: gpt-4o',
        ].join('\n'),
        'utf-8',
      );
      fs.writeFileSync(path.join(agentDir, 'zz-broken.yaml'), 'metadata: [unclosed\n', 'utf-8');
      setBuiltinAgentsDir(agentDir);

      const presets = (await getPresetHandler()({}, 'agent')) as Array<{ slug: string }>;
      expect(presets.map((p) => p.slug)).toEqual(['good-one']);
    });
  });
});
