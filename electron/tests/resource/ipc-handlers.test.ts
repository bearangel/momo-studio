// electron/tests/resource/ipc-handlers.test.ts
//
// Task 5 测试：resource IPC handlers 注册 + 4 通道路由。
// 重点验证 resource:delete 按 source+type 分流到对应底层删除函数。
//
// P3 Task 7 追加：resource:registerMcp（注册 custom mcp + 返回 ResourceItem）与
// resource:uploadSkill（转调 zip-uploader 返回 UploadedSkill[]）——注册面收敛到
// resource:* 命名空间（mcp:register / skill:uploadZip 退役）。
//
// P2 Task 4 追加：resource:registryList（hub provider 框架 IPC 面）。
// hub 模块整体 mock——provider 行为由 tests/resource/hub/* 单测覆盖。
// 2026-11-02 网络获取下线：registryProviders 通道删除（renderer 零消费死通道）、
// registryList 收敛 momo-hub 单源、marketplace/smithery 安装链用例随通道退役
//（smithery 存量卸载路由用例保留）。
//
// P2 Task 7 追加：resource:registerMcp 二态透传（remote 输入 transport/url 传给
// registerMcpDefinition）。真实 DB 全链往返由 register-mcp-remote-contract.test.ts
// 覆盖，本文件只锁 handler 的调用形状。
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
  // T12：resource:install hub 分支经 hubInstallContext 读 app.getVersion()
  // （plugin 链 minAppVersion 闸）——边界 mock 仿真真实返回
  app: { getVersion: () => '2.1.0-test' },
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
  // library-store-split：registryList builtin 分支直连 listMarketplaceResources →
  // fromCatalogItem 消费 listAgentDefinitions（builtin agent 启用态）——
  // mock 须提供该导出（空表仿真）
  listAgentDefinitions: vi.fn(() => []),
}));
// listInstalled 同因 fromCatalogItem 被消费（已装判定）——按用例覆写
const { installerListInstalled } = vi.hoisted(() => ({ installerListInstalled: vi.fn() }));
vi.mock('../../src/main/marketplace/installer', () => ({
  installPackage: vi.fn(),
  uninstallPackage: vi.fn(),
  listInstalled: installerListInstalled,
}));

// P2 Task 4：hub provider 注册表 mock（真实行为由 tests/resource/hub/* 覆盖）。
// 2026-11-02 网络获取下线后 HUB_PROVIDERS 仅 momo-hub——mock 单 provider 锁
// registryList 的透传委托面（smithery provider 已退役）。
// vi.mock 工厂会被提升到文件顶部——共享 spy 须经 vi.hoisted 声明，避免 TDZ。
const { hubProviderList } = vi.hoisted(() => ({
  hubProviderList: vi.fn(),
}));
vi.mock('../../src/main/resource/hub', () => ({
  HUB_PROVIDERS: [
    {
      key: 'hub', label: 'momo-hub', region: 'cn',
      types: ['agent', 'mcp', 'skill', 'plugin'],
      list: hubProviderList,
    },
  ],
}));

// P2 Task 5：hub 安装/卸载模块 mock（真实链路由 tests/resource/hub-install.test.ts
// 以真实 DB + fetch 桩覆盖；本文件只测 IPC 路由分支）。
// P2.1 Task 5：bundle-import（DXT/MCPB 本地包导入）——真实行为由
// tests/mcp/bundle-import.test.ts 以真实 DB + AdmZip 全量覆盖；本文件仅测
// IPC handler 的转调与 delete 分支路由。
const { hubInstallMocks } = vi.hoisted(() => ({
  hubInstallMocks: {
    uninstallHubMcp: vi.fn(),
    listHubInstalledResources: vi.fn(() => []),
    // M1 Task 10：momo-hub 第五源安装/卸载（真实链路由 tests/resource/
    // hub-install.e2e.test.ts 以真 mock hub + 真归档覆盖；本文件只锁 IPC 路由）
    installHubPackage: vi.fn(async () => ({ cachePath: '/tmp/hub-cache' })),
    uninstallHubPackage: vi.fn(),
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

// mock fetchCatalog：library 模块被整体 mock 后主链不消费——但 resource/custom
// 等真实传递模块可能间接触达，保持本地化直读语义的最小桩（零网络）。
vi.mock('../../src/main/marketplace/client', () => ({
  fetchCatalog: vi.fn(async () => ({
    version: '1.0',
    updatedAt: '2026-11-02',
    items: [],
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
        // P2.1 Task 5：DXT/MCPB 本地包两阶段导入通道
        'resource:parseMcpBundle',
        'resource:importMcpBundle',
        // 网络获取下线回归锁：安装/浏览通道面不再回潮
        'resource:registryList',
      ]),
    );
    // 死通道与 smithery 二段通道已删除（2026-11-02 网络获取下线）
    expect(channels).not.toContain('resource:installSmitheryRemote');
    expect(channels).not.toContain('resource:registryProviders');
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

  it('注册 registryList 通道', () => {
    const channels = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(channels).toEqual(
      expect.arrayContaining(['resource:registryList']),
    );
  });

  it('resource:registryList hub 分支委托 provider.list（query / page / opts 透传 + hasMore 透出）', async () => {
    hubProviderList.mockResolvedValueOnce({ entries: [], degraded: false, hasMore: true });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const listCall = calls.find((c: unknown[]) => c[0] === 'resource:registryList');
    const handler = listCall![1] as (
      evt: unknown,
      providerKey: string,
      type: string,
      query?: string,
      page?: number,
      opts?: { fresh?: boolean },
    ) => Promise<unknown>;
    const result = await handler({}, 'hub', 'mcp', 'weather', 2, { fresh: true });
    expect(hubProviderList).toHaveBeenCalledWith('mcp', 'weather', 2, { fresh: true });
    expect(result).toEqual({ entries: [], degraded: false, hasMore: true });
  });

  it('resource:registryList 未知 provider 抛错（builtin/smithery 已随网络获取下线退役）', async () => {
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const listCall = calls.find((c: unknown[]) => c[0] === 'resource:registryList');
    const handler = listCall![1] as (
      evt: unknown,
      providerKey: string,
      type: string,
    ) => Promise<unknown>;
    await expect(handler({}, 'mcphub', 'mcp')).rejects.toThrow(/未知 registry provider/);
  });

  it('resource:install hub 分支（M1 Task 10）：hub 源条目 → installHubPackage(type, slug, ctx)', async () => {
    // hub 目录项已在 library（未装项也在目录面——marketplace 同款口径）
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'hub-agent-hub-e2e-agent',
      type: 'agent',
      source: 'hub',
      slug: 'hub-e2e-agent',
      name: '演示 Agent',
      installable: true,
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const installCall = calls.find((c: unknown[]) => c[0] === 'resource:install');
    const handler = installCall![1] as (evt: unknown, id: string) => Promise<unknown>;
    await handler({}, 'hub-agent-hub-e2e-agent');
    // T12：第三参安装上下文（appVersion 必带；workspaceId 无活动工作区时 undefined）
    expect(hubInstallMocks.installHubPackage).toHaveBeenCalledWith('agent', 'hub-e2e-agent', {
      appVersion: '2.1.0-test',
      workspaceId: undefined,
    });
  });

  it('resource:install 已装 hub 项（installable=false）→ 放行 installHubPackage（D6：更新=同 slug 重装新版本）', async () => {
    // D6「更新」死路回归锁：renderer 更新按钮与安装按钮同走 resource:install，
    // 已装 hub 项 installable 恒 false（fromCatalogItem / 兜底行口径）——守卫
    // 不得拦截 hub 分支（更新语义 = 重装目录新版本，全链 e2e 见
    // hub-update-install.e2e.test.ts）
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'hub-agent-hub-e2e-agent',
      type: 'agent',
      source: 'hub',
      slug: 'hub-e2e-agent',
      name: '演示 Agent',
      installed: true,
      installable: false,
      removable: true,
      version: '1.0.0',
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const installCall = calls.find((c: unknown[]) => c[0] === 'resource:install');
    const handler = installCall![1] as (evt: unknown, id: string) => Promise<unknown>;
    await expect(handler({}, 'hub-agent-hub-e2e-agent')).resolves.toBeDefined();
    expect(hubInstallMocks.installHubPackage).toHaveBeenCalledWith('agent', 'hub-e2e-agent', {
      appVersion: '2.1.0-test',
      workspaceId: undefined,
    });
  });

  it('resource:install marketplace 已装项（installable=false）→ 守卫仍拦「不可安装」（D6 既有保护回归锁）', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'marketplace-agent-installed',
      type: 'agent',
      source: 'marketplace',
      slug: 'installed-agent',
      name: '已装市场 Agent',
      installed: true,
      installable: false,
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const installCall = calls.find((c: unknown[]) => c[0] === 'resource:install');
    const handler = installCall![1] as (evt: unknown, id: string) => Promise<unknown>;
    await expect(handler({}, 'marketplace-agent-installed')).rejects.toThrow(/不可安装/);
    expect(hubInstallMocks.installHubPackage).not.toHaveBeenCalled();
  });

  it('resource:install smithery 已装项（installable=false）→ 守卫仍拦（hub 放行不外溢到 smithery）', async () => {
    // listHubInstalledResources 恒置 installable=false——smithery 已装重装由
    // 守卫拦截的既有契约（ipc.handlers 注释明示），D6 hub 前置不得改变该面
    //（存量 smithery 行仍经 library 映射出现——安装链退役后守卫即终防线）
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'smithery-mcp-weather',
      type: 'mcp',
      source: 'smithery',
      slug: 'weather',
      name: 'weather',
      installed: true,
      installable: false,
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const installCall = calls.find((c: unknown[]) => c[0] === 'resource:install');
    const handler = installCall![1] as (evt: unknown, id: string) => Promise<unknown>;
    await expect(handler({}, 'smithery-mcp-weather')).rejects.toThrow(/不可安装/);
    expect(hubInstallMocks.installHubPackage).not.toHaveBeenCalled();
  });

  it('resource:install hub 分支：hub 离线（library 查不到）→ 仍按 id 反解进安装链（plugin 同链）', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const installCall = calls.find((c: unknown[]) => c[0] === 'resource:install');
    const handler = installCall![1] as (evt: unknown, id: string) => Promise<unknown>;
    await handler({}, 'hub-skill-hub-e2e-skill');
    expect(hubInstallMocks.installHubPackage).toHaveBeenCalledWith('skill', 'hub-e2e-skill', {
      appVersion: '2.1.0-test',
      workspaceId: undefined,
    });
    // T12：plugin 类型不再被 id 反解分支拦截（T9 第三处过滤解开）
    await handler({}, 'hub-plugin-hub-e2e-plugin');
    expect(hubInstallMocks.installHubPackage).toHaveBeenCalledWith('plugin', 'hub-e2e-plugin', {
      appVersion: '2.1.0-test',
      workspaceId: undefined,
    });
  });

  it('resource:install 非 hub 源仍抛「不支持 install 操作」（marketplace/smithery 安装链已退役）', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'custom-agent-uuid1',
      type: 'agent',
      source: 'custom',
      slug: 'uuid1',
      name: 'my agent',
      installable: true,
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const installCall = calls.find((c: unknown[]) => c[0] === 'resource:install');
    const handler = installCall![1] as (evt: unknown, id: string) => Promise<unknown>;
    await expect(handler({}, 'custom-agent-uuid1')).rejects.toThrow(/不支持 install 操作/);
  });

  it('resource:delete hub-* 路由到 uninstallHubPackage（slug → `hub:` 前缀寻址）', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'hub-skill-hub-e2e-skill',
      type: 'skill',
      source: 'hub',
      slug: 'hub-e2e-skill',
      removable: true,
      name: '演示技能',
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const deleteCall = calls.find((c: unknown[]) => c[0] === 'resource:delete');
    const handler = deleteCall![1] as (evt: unknown, id: string) => Promise<void>;
    await handler({}, 'hub-skill-hub-e2e-skill');
    expect(hubInstallMocks.uninstallHubPackage).toHaveBeenCalledWith('skill', 'hub-e2e-skill');
  });

  // ── smithery 安装/needsConfig 两态用例组（P2.1 Task 3，共 9 例）已随
  //    2026-11-02 网络获取下线退役——installSmitheryEntry / installSmitheryRemote
  //    通道与详情拉取链不复存在；下方保留存量行的本地卸载路由用例 ──

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

    it('resource:updateMcpConfig 服务层中文错误原样上抛（url scheme 防线文案）', async () => {
      mcpConfigMocks.updateRemoteMcpConfig.mockRejectedValueOnce(
        new Error('远程 MCP brave 配置更新失败：url 必须以 http:// 或 https:// 开头'),
      );
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const updateCall = calls.find((c: unknown[]) => c[0] === 'resource:updateMcpConfig');
      const handler = updateCall![1] as (
        evt: unknown,
        name: string,
        input: unknown,
      ) => Promise<unknown>;
      await expect(handler({}, 'brave', { url: 'ftp://insecure', config: {} })).rejects.toThrow(
        /必须以 http:\/\/ 或 https:\/\//,
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
  // 真 YAML，锁「真产物」契约（slug/name/emoji 均为生产消费字段）；openExternal
  // 用 shell spy 锁校验门（放行才触达 shell，拒绝路径 shell 必须零调用）。
  // 2026-11-02 内置资源极简化：预置目录仅剩 general-assistant（Momo）一个真 YAML。
  describe('P2.3 Task 2 预置清单 + 外链打开', () => {
    it('注册 resource:listBuiltinPresets / misc:openExternal 通道', () => {
      const channels = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0],
      );
      expect(channels).toEqual(
        expect.arrayContaining(['resource:listBuiltinPresets', 'misc:openExternal']),
      );
    });

    it("resource:listBuiltinPresets('agent') 返回 1 个真 YAML 预置（极简化后仅 Momo）", async () => {
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const presetCall = calls.find((c: unknown[]) => c[0] === 'resource:listBuiltinPresets');
      const handler = presetCall![1] as (evt: unknown, type: string) => Promise<unknown>;
      const presets = (await handler({}, 'agent')) as Array<{
        slug: string;
        name: string;
        description: string;
        iconEmoji: string;
      }>;
      expect(presets.map((p) => p.slug)).toEqual(['general-assistant']);
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
      const momo = presets.find((p) => p.slug === 'general-assistant');
      expect(momo).toMatchObject({ name: 'Momo', iconEmoji: '🐾' });
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
