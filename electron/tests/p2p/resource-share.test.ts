// electron/tests/p2p/resource-share.test.ts
//
// 资源目录出站构建 + 入站缓存测试（P4 Task 4）。
//
// 覆盖：
//   ① 目录构建——listCustomResources 过滤 type ∈ {agent, mcp}（skill 排除，2.1 遗留），
//      字段映射 type/slug/name/description/version + 身份/takenAt 由参数注入
//   ② 入站缓存往返——writeResourceCatalog 按 fromNodeId（验签来源）键控（自报 nodeId
//      不采信）；getSharedResources 返回 { nodeId, nodeName, items, takenAt }
//   ③ 同节点二次写入整条覆写；不同节点互不影响
//   ④ pruneStaleResources——超 5 分钟条目移除；5 分钟内保留；读口（getSharedResources）
//      顺带清理（prune-on-read——fix round 1 生产触发点）
//   ⑤ P2P 未启用（deps 未装配）→ 出站静默 no-op；广播失败吞错不抛
//   ⑥ initP2p 接线——入站 resource-catalog（Router onIncoming 捕获注入）→ 缓存 →
//      getSharedResources() 可读；读口顺带 prune（终审移除死 handler，renderer 走
//      resource:list → listResources 调 getSharedResources 间接消费）
//   ⑦ initP2p/stopP2p 装配——init 后 deps 可用（身份来自 identity 模块），
//      stop 后回 no-op；facade（p2p/index.ts）再导出同一函数
//   ⑧ 5min 周期重播兜底——事件触发外的目录重播；stopP2p 后 clearInterval
//   ⑨ 写路径触发——resource:registerMcp/uploadSkill/delete(custom) +
//      agent:createCustom/updateDefinition/deleteDefinition 成功后 fire-and-forget 触发
//
// 模式：与 task-broadcast.test.ts / remote-cache.test.ts 一致——vi.hoisted + vi.mock
// 捕获 ipcMain.handle 注册表；Router mock 捕获 onIncoming handler 模拟入站消息；
// 依赖全 mock，不依赖真实 DB / 网络 / 文件 IO。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  ipcHandlers,
  resourceCustomMocks,
  incomingHandler,
  taskRepoMocks,
  marketplaceMocks,
  hostManagerMocks,
  zipUploaderMocks,
  agentCrudMocks,
} = vi.hoisted(() => ({
  // ipcMain.handle 注册表——capture 真实注册的 handler 后按通道调用
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  // resource/custom 桩（目录构建的数据源）
  resourceCustomMocks: {
    listCustomResources: vi.fn(),
  },
  // Router mock 捕获的 onIncoming handler——模拟传输层入站消息
  incomingHandler: {
    current: undefined as ((msg: unknown) => void) | undefined,
  },
  // storage/tasks/repo 桩（p2p/index → task-broadcast 传递依赖）
  taskRepoMocks: {
    listTasks: vi.fn(),
  },
  // marketplace/client + installer 桩（resource ipc.handlers 传递依赖）
  marketplaceMocks: {
    fetchCatalog: vi.fn(),
    installPackage: vi.fn(),
    uninstallPackage: vi.fn(),
    listInstalled: vi.fn(),
  },
  // mcp/host-manager 桩
  hostManagerMocks: {
    registerMcpDefinition: vi.fn(),
    deleteRegistered: vi.fn(),
  },
  // skill/zip-uploader 桩
  zipUploaderMocks: {
    uploadSkillZip: vi.fn(),
    deleteCustomSkill: vi.fn(),
  },
  // agent/crud 桩（agent ipc.handlers 全 surface + resource delete 分支共用）
  agentCrudMocks: {
    saveAgentDefinition: vi.fn(),
    listAgentDefinitions: vi.fn(),
    getAgentDefinition: vi.fn(),
    assignAgentToWorkspace: vi.fn(),
    generateAgentUserId: vi.fn(),
    listAssignments: vi.fn(),
    updateAssignmentRole: vi.fn(),
    updateAssignmentApiKey: vi.fn(),
    listSubAssignments: vi.fn(),
    deleteDefinition: vi.fn(),
    updateAgentDefinition: vi.fn(),
    createCustomDef: vi.fn(),
    stopRunningInstancesByDefinition: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---- resource-share 直接依赖 ----
vi.mock('../../src/main/resource/custom', () => resourceCustomMocks);

// ---- p2p/index 传递依赖（initP2p 装配测试用） ----
vi.mock('../../src/main/storage/tasks/repo', () => taskRepoMocks);
vi.mock('../../src/main/p2p/router', () => ({
  Router: class {
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    onIncoming = vi.fn((h: (msg: unknown) => void) => {
      incomingHandler.current = h;
      return () => {};
    });
    send = vi.fn(async () => {});
  },
}));
vi.mock('../../src/main/p2p/local-transport', () => ({
  LocalTransport: class {},
}));
vi.mock('../../src/main/p2p/lan-transport', () => ({
  LanTransport: class {},
}));
vi.mock('../../src/main/p2p/identity', () => ({
  loadIdentity: vi.fn(() => ({ nodeId: 'node-me', displayName: '本机节点' })),
  generateIdentity: vi.fn(),
  saveIdentity: vi.fn(),
}));
vi.mock('../../src/main/p2p/trust-store', () => ({
  listTrustedNodes: vi.fn(() => []),
  addTrustedNode: vi.fn(),
  removeTrustedNode: vi.fn(),
  isTrusted: vi.fn(() => false),
  getTrustedPublicKey: vi.fn(() => null),
}));
vi.mock('../../src/main/storage/messages/repo', () => ({
  insertMessage: vi.fn(),
}));

// ---- resource ipc.handlers 传递依赖（触发测试用；library 用真实实现走短路分支） ----
vi.mock('../../src/main/marketplace/client', () => ({
  fetchCatalog: marketplaceMocks.fetchCatalog,
}));
vi.mock('../../src/main/marketplace/installer', () => ({
  installPackage: marketplaceMocks.installPackage,
  uninstallPackage: marketplaceMocks.uninstallPackage,
  listInstalled: marketplaceMocks.listInstalled,
}));
vi.mock('../../src/main/mcp/host-manager', () => hostManagerMocks);
vi.mock('../../src/main/skill/zip-uploader', () => zipUploaderMocks);

// ---- agent ipc.handlers 传递依赖（触发测试用） ----
vi.mock('../../src/main/agent/crud', () => agentCrudMocks);
vi.mock('../../src/main/agent/manifest-parser', () => ({
  parseAgentManifest: vi.fn(),
}));
vi.mock('../../src/main/workspace/crud', () => ({
  getWorkspace: vi.fn(),
  setWorkspaceCoordinator: vi.fn(),
}));
vi.mock('../../src/main/storage/keychain', () => ({
  deleteSecret: vi.fn(),
}));
vi.mock('../../src/main/storage/db', () => ({
  getDb: vi.fn(),
}));
vi.mock('../../src/main/storage/sessions/repo', () => ({
  addSessionMember: vi.fn(),
}));
vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(),
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  startAgentRuntime: vi.fn(),
  stopAgentRuntime: vi.fn(),
}));
vi.mock('../../src/main/agent/spawn-helpers', () => ({
  buildSpawnOpts: vi.fn(),
  resolveApiKey: vi.fn(),
}));
vi.mock('../../src/main/agent/builtin', () => ({
  getBuiltinSuggestionsMap: vi.fn(),
}));
vi.mock('../../src/main/agent/assignment-capabilities', () => ({
  getAssignmentDeltas: vi.fn(),
  setAssignmentDeltas: vi.fn(),
}));

import {
  buildLocalResourceCatalog,
  writeResourceCatalog,
  getSharedResources,
  pruneStaleResources,
  clearSharedResourceCache,
  broadcastLocalResourceCatalog,
  setResourceShareDeps,
  clearResourceShareDeps,
  type SharedNodeResources,
} from '../../src/main/p2p/resource-share';
import {
  initP2p,
  stopP2p,
  broadcastLocalResourceCatalog as facadeBroadcast,
} from '../../src/main/p2p/index';
import { P2pSync } from '../../src/main/p2p/sync';
import { registerResourceHandlers } from '../../src/main/resource/ipc.handlers';
import { registerAgentHandlers } from '../../src/main/agent/ipc.handlers';
import type { ResourceItem } from '../../src/main/resource/types';
import type { ResourceCatalogEntry } from '../../src/main/p2p/protocols';

/** 自定义资源 fixture：agent + mcp + skill 三类（skill 应被目录构建排除） */
function makeCustomItems(): ResourceItem[] {
  return [
    {
      id: 'custom-agent-uuid-1',
      type: 'agent',
      source: 'custom',
      slug: 'uuid-1',
      name: '研究助手',
      description: '远端共享的自定义 agent',
      version: '1.0.0',
      installed: true,
      installable: false,
      removable: true,
      custom: { installedAt: '2026-08-24' },
    },
    {
      id: 'custom-mcp-weather',
      type: 'mcp',
      source: 'custom',
      slug: 'weather',
      name: 'weather',
      description: '自定义 MCP（npx）',
      version: '2.0.0',
      installed: true,
      installable: false,
      removable: true,
      custom: { installedAt: '2026-08-24' },
    },
    {
      id: 'custom-skill-demo',
      type: 'skill',
      source: 'custom',
      slug: 'demo',
      name: 'demo',
      description: 'zip 上传的 skill',
      installed: true,
      installable: false,
      removable: true,
      custom: { installedAt: '2026-08-24' },
    },
  ];
}

/** 构造合法 ResourceCatalogEntry fixture */
function mkCatalog(partial: Partial<ResourceCatalogEntry> = {}): ResourceCatalogEntry {
  return {
    nodeId: 'node-self-claimed',
    nodeName: '对端节点',
    items: [
      { type: 'agent', slug: 'helper', name: '助手', description: '远端 agent' },
      { type: 'mcp', slug: 'github', name: 'github', description: '远端 mcp', version: '1.1.0' },
    ],
    takenAt: Date.now(),
    ...partial,
  };
}

/** 统一装配 deps（固定身份便于断言）；返回 sync 桩供断言 */
function useFakeSync() {
  const sync = { broadcastResourceCatalog: vi.fn().mockResolvedValue(undefined) };
  setResourceShareDeps({ sync, nodeId: 'node-a', nodeName: '节点A' });
  return sync;
}

beforeEach(() => {
  ipcHandlers.clear();
  Object.values(resourceCustomMocks).forEach((m) => m.mockReset());
  resourceCustomMocks.listCustomResources.mockReturnValue([]);
  incomingHandler.current = undefined;
  Object.values(taskRepoMocks).forEach((m) => m.mockReset());
  taskRepoMocks.listTasks.mockReturnValue([]);
  Object.values(marketplaceMocks).forEach((m) => m.mockReset());
  Object.values(hostManagerMocks).forEach((m) => m.mockReset());
  Object.values(zipUploaderMocks).forEach((m) => m.mockReset());
  Object.values(agentCrudMocks).forEach((m) => m.mockReset());
  clearSharedResourceCache();
  clearResourceShareDeps();
});

describe('resource-share 出站目录构建', () => {
  it('① 只收 agent/mcp（skill 排除，2.1 遗留），字段映射 + 身份注入', () => {
    resourceCustomMocks.listCustomResources.mockReturnValue(makeCustomItems());

    const cat = buildLocalResourceCatalog('node-a', '节点A');

    // skill 排除：三类 custom 只映射出 agent + mcp 两条
    expect(cat.items).toHaveLength(2);
    expect(cat.items.map((i) => i.type)).toEqual(['agent', 'mcp']);
    // 字段映射：type/slug/name/description/version 一一对应
    expect(cat.items[0]).toEqual({
      type: 'agent',
      slug: 'uuid-1',
      name: '研究助手',
      description: '远端共享的自定义 agent',
      version: '1.0.0',
    });
    expect(cat.items[1]).toEqual({
      type: 'mcp',
      slug: 'weather',
      name: 'weather',
      description: '自定义 MCP（npx）',
      version: '2.0.0',
    });
    // 身份字段由调用方注入（生产调用点用 deps 身份）
    expect(cat.nodeId).toBe('node-a');
    expect(cat.nodeName).toBe('节点A');
    expect(typeof cat.takenAt).toBe('number');
  });

  it('① 无自定义资源时构建空目录（items: []）', () => {
    resourceCustomMocks.listCustomResources.mockReturnValue([]);

    const cat = buildLocalResourceCatalog('node-a', '节点A');

    expect(cat.items).toEqual([]);
  });
});

describe('resource-share 入站缓存', () => {
  it('② 写读往返：按 fromNodeId 键控（自报 nodeId 不采信）+ nodeName 取自目录', () => {
    const cat = mkCatalog({ nodeName: '对端A' });
    writeResourceCatalog(cat, 'node-peer');

    const list = getSharedResources();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      nodeId: 'node-peer',
      nodeName: '对端A',
      items: cat.items,
      takenAt: cat.takenAt,
    });
  });

  it('③ 同节点二次写入整条覆写（旧条目不残留），不同节点互不影响', () => {
    writeResourceCatalog(mkCatalog({ items: [mkCatalog().items[0]] }), 'node-a');
    writeResourceCatalog(
      mkCatalog({ items: [{ type: 'mcp', slug: 'new-mcp', name: '新', description: 'd' }] }),
      'node-a',
    );
    writeResourceCatalog(mkCatalog(), 'node-b');

    const byId = new Map(getSharedResources().map((r) => [r.nodeId, r]));
    expect(byId.get('node-a')?.items).toHaveLength(1);
    expect(byId.get('node-a')?.items[0]).toMatchObject({ slug: 'new-mcp' });
    expect(byId.get('node-b')?.items).toHaveLength(2);
  });

  it('④ pruneStaleResources：超 5 分钟移除；5 分钟内保留', () => {
    writeResourceCatalog(mkCatalog({ takenAt: Date.now() - 6 * 60_000 }), 'node-gone');
    writeResourceCatalog(mkCatalog({ takenAt: Date.now() }), 'node-fresh');

    pruneStaleResources();

    const list = getSharedResources();
    expect(list.map((r) => r.nodeId)).toEqual(['node-fresh']);
  });

  it('④b prune-on-read：getSharedResources 读口顺带清理——6 分钟 stale 条目不返回', () => {
    writeResourceCatalog(mkCatalog({ takenAt: Date.now() - 6 * 60_000 }), 'node-stale');
    writeResourceCatalog(mkCatalog({ takenAt: Date.now() }), 'node-fresh');

    // 不显式调 pruneStaleResources——读口自清理（fix round 1 生产触发点）
    const list = getSharedResources();

    expect(list.map((r) => r.nodeId)).toEqual(['node-fresh']);
  });
});

describe('resource-share 出站广播', () => {
  it('⑤ P2P 未启用（deps 未装配）→ 静默 no-op：不抛错、不扫 custom、不广播', async () => {
    await expect(broadcastLocalResourceCatalog()).resolves.toBeUndefined();
    expect(resourceCustomMocks.listCustomResources).not.toHaveBeenCalled();
  });

  it('⑤b 广播失败（sync 抛错）→ 吞错不抛（容错同 broadcastLocalTaskSnapshot）', async () => {
    setResourceShareDeps({
      sync: { broadcastResourceCatalog: vi.fn().mockRejectedValue(new Error('net down')) },
      nodeId: 'node-a',
      nodeName: '节点A',
    });
    resourceCustomMocks.listCustomResources.mockReturnValue([]);

    await expect(broadcastLocalResourceCatalog()).resolves.toBeUndefined();
  });

  it('⑤c 装配后广播：目录来自 listCustomResources + deps 身份', async () => {
    const sync = useFakeSync();
    resourceCustomMocks.listCustomResources.mockReturnValue(makeCustomItems());

    await broadcastLocalResourceCatalog();

    expect(sync.broadcastResourceCatalog).toHaveBeenCalledTimes(1);
    const cat = sync.broadcastResourceCatalog.mock.calls[0][0];
    expect(cat).toMatchObject({
      nodeId: 'node-a',
      nodeName: '节点A',
    });
    // skill 排除在出站路径同样生效
    expect(cat.items.map((i: { type: string }) => i.type)).toEqual(['agent', 'mcp']);
  });
});

describe('initP2p 接线（index.ts）', () => {
  it('⑥ 入站 resource-catalog → writeResourceCatalog → getSharedResources() 可读', async () => {
    try {
      await initP2p();

      expect(incomingHandler.current).toBeTruthy();
      incomingHandler.current!({
        fromNodeId: 'node-peer',
        payload: {
          targetNodeId: 'node-me',
          type: 'resource-catalog',
          body: mkCatalog({ nodeName: '对端A' }),
        },
        receivedAt: Date.now(),
      });

      const list = getSharedResources() as SharedNodeResources[];
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        nodeId: 'node-peer',
        nodeName: '对端A',
      });
      expect(list[0]!.items).toHaveLength(2);
    } finally {
      await stopP2p();
    }
  });

  it('⑥b getSharedResources 顺带 prune——超 5 分钟条目在读口直接消失', async () => {
    writeResourceCatalog(mkCatalog({ takenAt: Date.now() - 6 * 60_000 }), 'node-gone');
    writeResourceCatalog(mkCatalog({ takenAt: Date.now() }), 'node-fresh');

    const list = getSharedResources() as SharedNodeResources[];

    expect(list.map((r) => r.nodeId)).toEqual(['node-fresh']);
  });

  it('⑦ init 后 deps 装配（身份来自 identity 模块）→ stop 后回到 no-op', async () => {
    const spy = vi
      .spyOn(P2pSync.prototype, 'broadcastResourceCatalog')
      .mockResolvedValue(undefined);
    try {
      await initP2p();

      resourceCustomMocks.listCustomResources.mockReturnValue([]);
      await broadcastLocalResourceCatalog();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({
        nodeId: 'node-me',
        nodeName: '本机节点',
        items: [],
      });

      await stopP2p();
      resourceCustomMocks.listCustomResources.mockClear();
      await broadcastLocalResourceCatalog();
      // deps 已清空 → 静默 no-op（不再扫 custom）
      expect(resourceCustomMocks.listCustomResources).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('⑦ facade 再导出同一函数（p2p/index 与 resource-share 模块一致）', () => {
    expect(facadeBroadcast).toBe(broadcastLocalResourceCatalog);
  });

  it('⑧ 5min 周期重播兜底——4:59 不触发，5:00 触发；stopP2p 后 clearInterval', async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(P2pSync.prototype, 'broadcastResourceCatalog')
      .mockResolvedValue(undefined);
    try {
      await initP2p();
      resourceCustomMocks.listCustomResources.mockReturnValue([]);

      // 5min 边界：299.999s 不触发，第 300s 触发第一次重播
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
      expect(spy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(spy).toHaveBeenCalledTimes(1);
      // 下一周期继续重播
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(spy).toHaveBeenCalledTimes(2);

      // stopP2p 清理 interval——后续不再重播
      await stopP2p();
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('custom 资源写路径触发接线', () => {
  beforeEach(() => {
    registerResourceHandlers();
    registerAgentHandlers();
  });

  it('⑨ resource:registerMcp 成功后触发目录广播', async () => {
    const sync = useFakeSync();
    // handler 内部先 listResources({type:'mcp',source:'custom'}) 取回条目（短路不走 catalog）
    resourceCustomMocks.listCustomResources.mockReturnValue([
      makeCustomItems()[1]!, // custom mcp weather
    ]);

    const item = await ipcHandlers.get('resource:registerMcp')!({} as never, {
      name: 'weather',
      command: 'npx',
    });

    expect(item).toMatchObject({ slug: 'weather' });
    expect(sync.broadcastResourceCatalog).toHaveBeenCalledTimes(1);
  });

  it('⑨ resource:uploadSkill 成功后触发目录广播（skill 虽不入目录，触发保持一致）', async () => {
    const sync = useFakeSync();
    zipUploaderMocks.uploadSkillZip.mockReturnValueOnce([
      { slug: 'demo', name: 'demo', description: '' },
    ]);

    await ipcHandlers.get('resource:uploadSkill')!({} as never, new Uint8Array([1]), 'demo.zip');

    expect(zipUploaderMocks.uploadSkillZip).toHaveBeenCalledTimes(1);
    expect(sync.broadcastResourceCatalog).toHaveBeenCalledTimes(1);
  });

  it('⑨ resource:delete custom-mcp 成功后触发目录广播', async () => {
    const sync = useFakeSync();
    resourceCustomMocks.listCustomResources.mockReturnValue([
      makeCustomItems()[1]!, // custom mcp weather
    ]);

    await ipcHandlers.get('resource:delete')!({} as never, 'custom-mcp-weather');

    expect(hostManagerMocks.deleteRegistered).toHaveBeenCalledWith('weather');
    expect(sync.broadcastResourceCatalog).toHaveBeenCalledTimes(1);
  });

  it('⑨ agent:createCustom 成功后触发目录广播', async () => {
    const sync = useFakeSync();
    agentCrudMocks.createCustomDef.mockReturnValueOnce({
      id: 'uuid-1',
      slug: 'helper',
      name: '助手',
      source: 'custom',
    });

    await ipcHandlers.get('agent:createCustom')!({} as never, {
      name: '助手',
      slug: 'helper',
      systemPrompt: 'p',
      scope: 'global',
      modelProviderId: 'pv-1',
      modelName: 'm-1',
    });

    expect(agentCrudMocks.createCustomDef).toHaveBeenCalledTimes(1);
    expect(sync.broadcastResourceCatalog).toHaveBeenCalledTimes(1);
  });

  it('⑨ agent:updateDefinition 成功后触发目录广播（全量重扫，builtin 更新无害）', async () => {
    const sync = useFakeSync();
    agentCrudMocks.updateAgentDefinition.mockReturnValueOnce({
      id: 'uuid-1',
      slug: 'helper',
      name: '助手',
      source: 'custom',
    });
    agentCrudMocks.stopRunningInstancesByDefinition.mockResolvedValueOnce([]);

    await ipcHandlers.get('agent:updateDefinition')!({} as never, { id: 'uuid-1' });

    expect(agentCrudMocks.updateAgentDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'uuid-1' }),
    );
    expect(sync.broadcastResourceCatalog).toHaveBeenCalledTimes(1);
  });

  it('⑨ agent:deleteDefinition 成功后触发目录广播', async () => {
    const sync = useFakeSync();
    agentCrudMocks.deleteDefinition.mockResolvedValueOnce({ stoppedInstanceIds: [] });

    await ipcHandlers.get('agent:deleteDefinition')!({} as never, 'uuid-1');

    expect(agentCrudMocks.deleteDefinition).toHaveBeenCalledWith('uuid-1');
    expect(sync.broadcastResourceCatalog).toHaveBeenCalledTimes(1);
  });

  it('⑨b 删除失败（底层抛错）不触发广播', async () => {
    const sync = useFakeSync();
    resourceCustomMocks.listCustomResources.mockReturnValue([
      makeCustomItems()[1]!, // custom mcp weather
    ]);
    hostManagerMocks.deleteRegistered.mockImplementationOnce(() => {
      throw new Error('db locked');
    });

    await expect(
      ipcHandlers.get('resource:delete')!({} as never, 'custom-mcp-weather'),
    ).rejects.toThrow(/db locked/);
    expect(sync.broadcastResourceCatalog).not.toHaveBeenCalled();
  });
});
