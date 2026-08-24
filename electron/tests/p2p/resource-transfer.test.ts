// electron/tests/p2p/resource-transfer.test.ts
//
// P4 Task 5：资源导入请求/供给协议 + install 落地 custom 测试。
//
// 覆盖：
//   ① 需求方 happy path（agent）——request/provide 配对 resolve 'ok'，定义按原始 slug 落地
//   ② not-found——供给方回 definition: null → resolve 'not-found'，不落地
//   ③ timeout——30s 无回执 → resolve 'timeout'；29.999s 仍挂起
//   ④ mcp 落地幂等——同名两次导入均 'ok'，registerMcpDefinition 两次同形配置
//     （DB 层 UNIQUE(name) + INSERT OR REPLACE 保证单条——既有语义）
//   ⑤ agent slug 冲突——本地已有同 slug def → 后缀 -from-{nodeId前4}
//   ⑤b 畸形定义（缺 systemPrompt）——上抛描述性错误
//   ⑥ resource:install p2p 分支端到端（handler 捕获 + 真实 library 解析 + mock p2p 层）
//   ⑦ node-not-found——目录缓存无条目（节点离线/prune）→ 友好错误
//   ⑧ 供给方 handleResourceRequest——custom 匹配（agent 按 def.id 反查全量定义 / mcp 直取
//      mcpConfig）；未找到回 definition: null；发送失败吞错仅 warn
//   ⑨ resolveResourceById p2p 往返（T4 deferred）——缓存条目 → id 反解 → 全字段还原
//   ⑩ initP2p 接线——onResourceRequest/onResourceProvide 挂到真实 P2pSync；stopP2p 清 deps
//   ⑪ deps 生命周期——未装配时 request 抛错、handleResourceRequest 静默 no-op
//
// 模式：与 resource-share.test.ts 一致——vi.hoisted + vi.mock 捕获 ipcMain.handle 注册表；
// Router mock 捕获 onIncoming handler + send 调用；依赖全 mock，不依赖真实 DB / 网络 / 文件 IO。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  ipcHandlers,
  resourceCustomMocks,
  incomingHandler,
  routerSendCalls,
  taskRepoMocks,
  marketplaceMocks,
  hostManagerMocks,
  zipUploaderMocks,
  agentCrudMocks,
} = vi.hoisted(() => ({
  // ipcMain.handle 注册表——capture 真实注册的 handler 后按通道调用
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  // resource/custom 桩（供给方匹配范围 = 目录构建范围）
  resourceCustomMocks: {
    listCustomResources: vi.fn(),
  },
  // Router mock 捕获的 onIncoming handler——模拟传输层入站消息
  incomingHandler: {
    current: undefined as ((msg: unknown) => void) | undefined,
  },
  // Router mock 捕获的 send 调用（initP2p 集成用——真实 P2pSync 出站经此断言）
  routerSendCalls: [] as Array<{ target: string; payload: { type: string; body: Record<string, unknown> } }>,
  // storage/tasks/repo 桩（p2p/index → task-broadcast 传递依赖）
  taskRepoMocks: {
    listTasks: vi.fn(),
  },
  // marketplace 桩（library / ipc.handlers 传递依赖）
  marketplaceMocks: {
    fetchCatalog: vi.fn(),
    installPackage: vi.fn(),
    uninstallPackage: vi.fn(),
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
  // agent/crud 桩（resource-transfer 落地 + ipc.handlers delete 分支共用）
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

// ---- resource-transfer 直接依赖 ----
vi.mock('../../src/main/resource/custom', () => resourceCustomMocks);
vi.mock('../../src/main/mcp/host-manager', () => hostManagerMocks);
vi.mock('../../src/main/agent/crud', () => agentCrudMocks);

// ---- library / ipc.handlers 传递依赖（library 本体走真实实现） ----
vi.mock('../../src/main/marketplace/client', () => ({
  fetchCatalog: marketplaceMocks.fetchCatalog,
}));
vi.mock('../../src/main/marketplace/installer', () => ({
  installPackage: marketplaceMocks.installPackage,
  uninstallPackage: marketplaceMocks.uninstallPackage,
}));
vi.mock('../../src/main/skill/zip-uploader', () => zipUploaderMocks);

// ---- p2p/index 传递依赖（initP2p 装配 / 接线测试用） ----
vi.mock('../../src/main/storage/tasks/repo', () => taskRepoMocks);
vi.mock('../../src/main/p2p/router', () => ({
  Router: class {
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    onIncoming = vi.fn((h: (msg: unknown) => void) => {
      incomingHandler.current = h;
      return () => {};
    });
    send = vi.fn(async (target: string, payload: { type: string; body: Record<string, unknown> }) => {
      routerSendCalls.push({ target, payload });
    });
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

import {
  requestResourceImport,
  handleResourceRequest,
  handleResourceProvide,
  setResourceTransferDeps,
  clearResourceTransferDeps,
} from '../../src/main/p2p/resource-transfer';
import {
  setResourceShareDeps,
  clearResourceShareDeps,
  clearSharedResourceCache,
  writeResourceCatalog,
} from '../../src/main/p2p/resource-share';
import { resolveResourceById } from '../../src/main/resource/library';
import { registerResourceHandlers } from '../../src/main/resource/ipc.handlers';
import { initP2p, stopP2p } from '../../src/main/p2p/index';
import type { ResourceItem } from '../../src/main/resource/types';
import type { ResourceRequest } from '../../src/main/p2p/protocols';

/** 对端节点 ID：前 8 字符 'a1b2c3d4'（目录 id 前缀），前 4 字符 'a1b2'（冲突后缀） */
const PEER = 'a1b2c3d4e5f6g7h8i9j0k1l2';

/** 线上格式 agent 定义（provide.definition 的 requester 视角） */
const WIRE_AGENT_DEF: Record<string, unknown> = {
  name: '研究助手',
  slug: 'research-helper',
  systemPrompt: '你是研究助手，负责资料检索与归纳。',
  iconEmoji: '🔬',
  description: '远端共享的研究 agent',
  defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
  version: '1.2.0',
};

/** 线上格式 mcp 定义 */
const WIRE_MCP_DEF: Record<string, unknown> = {
  name: 'weather',
  command: 'npx',
  args: ['-y', 'weather-server'],
  env: { API_KEY: 'secret' },
  version: '2.0.0',
};

/** 供给方本地完整 AgentDefinition（getAgentDefinition 桩返回值） */
const LOCAL_AGENT_DEF = {
  id: 'uuid-1',
  name: '研究助手',
  slug: 'research-helper',
  version: '1.2.0',
  runtime: 'declarative' as const,
  systemPrompt: '你是研究助手，负责资料检索与归纳。',
  defaultTools: [{ kind: 'builtin' as const, ref: 'read_file' }],
  source: 'custom' as const,
  description: '远端共享的研究 agent',
  iconEmoji: '🔬',
  defaultMcps: [],
  defaultSkills: [],
  workspaceId: null,
  modelProviderId: 'pv-1',
  modelName: 'gpt-4o',
};

/** custom agent 条目（listCustomResources 桩；slug = def.id，与目录构建口径一致） */
function mkAgentCustomItem(): ResourceItem {
  return {
    id: 'custom-agent-uuid-1',
    type: 'agent',
    source: 'custom',
    slug: 'uuid-1',
    name: '研究助手',
    description: '远端共享的研究 agent',
    version: '1.2.0',
    iconEmoji: '🔬',
    installed: true,
    installable: false,
    removable: true,
    custom: { installedAt: '2026-08-24' },
  };
}

/** custom mcp 条目（listCustomResources 桩；slug = name，含完整 mcpConfig） */
function mkMcpCustomItem(): ResourceItem {
  return {
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
    custom: {
      installedAt: '2026-08-24',
      mcpConfig: { command: 'npx', args: ['-y', 'weather-server'], env: { API_KEY: 'secret' } },
    },
  };
}

/**
 * 回环 transfer deps：sendResourceRequest 一经调用立即以指定 definition 模拟对端回执
 * （pending 注册先于 send——回环在 send 内同步触发无竞态）。
 */
function useLoopbackDeps(definition: Record<string, unknown> | null) {
  const sendResourceRequest = vi.fn(async (_target: string, req: ResourceRequest) => {
    handleResourceProvide({ requestId: req.requestId, definition }, _target);
  });
  const sendResourceProvide = vi.fn(async () => {});
  setResourceTransferDeps({ sync: { sendResourceRequest, sendResourceProvide } });
  return { sendResourceRequest, sendResourceProvide };
}

/** 微任务 flush（真实定时器场景下等待 fire-and-forget promise 落定） */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** 向 resource-share 缓存 seed 一个远端目录条目（install/round-trip 测试的 p2p 源数据） */
function seedRemoteCatalog(): void {
  writeResourceCatalog(
    {
      nodeId: PEER,
      nodeName: '节点A',
      items: [
        { type: 'agent', slug: 'uuid-1', name: '研究助手', description: '远端共享的研究 agent', version: '1.2.0' },
        { type: 'mcp', slug: 'weather', name: 'weather', description: '自定义 MCP（npx）', version: '2.0.0' },
      ],
      takenAt: Date.now(),
    },
    PEER,
  );
}

beforeEach(() => {
  ipcHandlers.clear();
  Object.values(resourceCustomMocks).forEach((m) => m.mockReset());
  resourceCustomMocks.listCustomResources.mockReturnValue([]);
  incomingHandler.current = undefined;
  routerSendCalls.length = 0;
  Object.values(taskRepoMocks).forEach((m) => m.mockReset());
  taskRepoMocks.listTasks.mockReturnValue([]);
  Object.values(marketplaceMocks).forEach((m) => m.mockReset());
  Object.values(hostManagerMocks).forEach((m) => m.mockReset());
  Object.values(zipUploaderMocks).forEach((m) => m.mockReset());
  Object.values(agentCrudMocks).forEach((m) => m.mockReset());
  agentCrudMocks.listAgentDefinitions.mockReturnValue([]);
  agentCrudMocks.getAgentDefinition.mockReturnValue(null);
  clearSharedResourceCache();
  clearResourceShareDeps();
  clearResourceTransferDeps();
});

describe('requestResourceImport 需求方', () => {
  it('① agent happy path：配对 resolve ok + 定义按原始 slug 落地（不落 assignment）', async () => {
    const { sendResourceRequest } = useLoopbackDeps(WIRE_AGENT_DEF);

    const result = await requestResourceImport(PEER, 'agent', 'uuid-1');

    expect(result).toBe('ok');
    // 请求携带原始 slug（非目录 id 的节点前缀形式）+ 新 requestId
    expect(sendResourceRequest).toHaveBeenCalledTimes(1);
    const [target, req] = sendResourceRequest.mock.calls[0] as [string, ResourceRequest];
    expect(target).toBe(PEER);
    expect(req).toMatchObject({ resourceType: 'agent', slug: 'uuid-1' });
    expect(typeof req.requestId).toBe('string');
    // 落地走 createCustomDef 等价路径：global（workspaceId=null）+ 远端字段透传 +
    // 模型配置空串（走本机 defaultChatModel 兜底）+ defaultTools 透传
    expect(agentCrudMocks.createCustomDef).toHaveBeenCalledTimes(1);
    const [wsId, input] = agentCrudMocks.createCustomDef.mock.calls[0] as [
      string | null,
      Record<string, unknown>,
    ];
    expect(wsId).toBeNull();
    expect(input).toMatchObject({
      name: '研究助手',
      slug: 'research-helper',
      systemPrompt: WIRE_AGENT_DEF.systemPrompt,
      iconEmoji: '🔬',
      description: '远端共享的研究 agent',
      modelProviderId: '',
      modelName: '',
      defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
    });
    // 不落 assignment（createCustomDef 本身不建 assignment——导入后用户手动加入 workspace）
    expect(agentCrudMocks.assignAgentToWorkspace).not.toHaveBeenCalled();
  });

  it('② definition: null → not-found，不触发落地', async () => {
    useLoopbackDeps(null);

    const result = await requestResourceImport(PEER, 'agent', 'uuid-1');

    expect(result).toBe('not-found');
    expect(agentCrudMocks.createCustomDef).not.toHaveBeenCalled();
    expect(hostManagerMocks.registerMcpDefinition).not.toHaveBeenCalled();
  });

  it('③ 30s 无回执 → timeout（29.999s 仍挂起）', async () => {
    vi.useFakeTimers();
    try {
      setResourceTransferDeps({
        sync: { sendResourceRequest: vi.fn(async () => {}), sendResourceProvide: vi.fn(async () => {}) },
      });

      let settled = false;
      const p = requestResourceImport(PEER, 'mcp', 'weather').then((r) => {
        settled = true;
        return r;
      });

      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toBe('timeout');
      expect(hostManagerMocks.registerMcpDefinition).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('④ mcp 落地幂等：同名两次导入均 ok，两次同形配置（DB UNIQUE(name) 保证单条）', async () => {
    useLoopbackDeps(WIRE_MCP_DEF);

    const first = await requestResourceImport(PEER, 'mcp', 'weather');
    const second = await requestResourceImport(PEER, 'mcp', 'weather');

    expect(first).toBe('ok');
    expect(second).toBe('ok');
    expect(hostManagerMocks.registerMcpDefinition).toHaveBeenCalledTimes(2);
    for (const call of hostManagerMocks.registerMcpDefinition.mock.calls) {
      const config = call[0] as Record<string, unknown>;
      expect(config).toMatchObject({
        name: 'weather',
        command: 'npx',
        args: ['-y', 'weather-server'],
        env: { API_KEY: 'secret' },
        version: '2.0.0',
        source: 'custom',
      });
      expect(typeof config.id).toBe('string');
    }
  });

  it('⑤ agent slug 冲突 → 后缀 -from-{nodeId前4}', async () => {
    useLoopbackDeps(WIRE_AGENT_DEF);
    // 本地已存在同 slug def（无论 source）→ 冲突
    agentCrudMocks.listAgentDefinitions.mockReturnValue([LOCAL_AGENT_DEF]);

    const result = await requestResourceImport(PEER, 'agent', 'uuid-1');

    expect(result).toBe('ok');
    expect(agentCrudMocks.createCustomDef).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ slug: 'research-helper-from-a1b2' }),
    );
  });

  it('⑤b 畸形 agent 定义（缺 systemPrompt）→ 上抛描述性错误', async () => {
    useLoopbackDeps({ name: 'x', slug: 'y' });

    await expect(requestResourceImport(PEER, 'agent', 'uuid-1')).rejects.toThrow(/systemPrompt/);
    expect(agentCrudMocks.createCustomDef).not.toHaveBeenCalled();
  });

  it('③b 发送失败（节点不可达）→ 清理 pending 并上抛', async () => {
    const sendResourceRequest = vi.fn(async () => {
      throw new Error('connection refused');
    });
    setResourceTransferDeps({ sync: { sendResourceRequest, sendResourceProvide: vi.fn(async () => {}) } });

    await expect(requestResourceImport(PEER, 'agent', 'uuid-1')).rejects.toThrow(/connection refused/);
  });

  it('⑪ deps 未装配（P2P 未启用）→ 抛错', async () => {
    await expect(requestResourceImport(PEER, 'agent', 'uuid-1')).rejects.toThrow(/P2P 未启用/);
  });
});

describe('handleResourceRequest 供给方', () => {
  it('⑧a agent 命中：按 def.id 反查全量定义（清单元数据只有 prompt 指纹）', async () => {
    resourceCustomMocks.listCustomResources.mockReturnValue([mkAgentCustomItem()]);
    agentCrudMocks.getAgentDefinition.mockReturnValue(LOCAL_AGENT_DEF);
    const { sendResourceProvide } = useLoopbackDeps(null);

    handleResourceRequest({ requestId: 'req-9', resourceType: 'agent', slug: 'uuid-1' }, 'node-peer');
    await flush();

    expect(sendResourceProvide).toHaveBeenCalledTimes(1);
    const [target, prov] = sendResourceProvide.mock.calls[0] as [
      string,
      { requestId: string; definition: Record<string, unknown> | null },
    ];
    expect(target).toBe('node-peer');
    expect(prov.requestId).toBe('req-9');
    expect(prov.definition).toEqual({
      name: '研究助手',
      slug: 'research-helper',
      systemPrompt: LOCAL_AGENT_DEF.systemPrompt,
      iconEmoji: '🔬',
      description: '远端共享的研究 agent',
      defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
      version: '1.2.0',
    });
  });

  it('⑧b mcp 命中：custom.mcpConfig 直取 command/args/env', async () => {
    resourceCustomMocks.listCustomResources.mockReturnValue([mkMcpCustomItem()]);
    const { sendResourceProvide } = useLoopbackDeps(null);

    handleResourceRequest({ requestId: 'req-10', resourceType: 'mcp', slug: 'weather' }, 'node-peer');
    await flush();

    expect(sendResourceProvide).toHaveBeenCalledTimes(1);
    const [, prov] = sendResourceProvide.mock.calls[0] as [
      string,
      { requestId: string; definition: Record<string, unknown> | null },
    ];
    expect(prov).toMatchObject({
      requestId: 'req-10',
      definition: {
        name: 'weather',
        command: 'npx',
        args: ['-y', 'weather-server'],
        env: { API_KEY: 'secret' },
        version: '2.0.0',
      },
    });
  });

  it('⑧c 目录范围未命中（slug 不在 custom 资源中）→ definition: null', async () => {
    resourceCustomMocks.listCustomResources.mockReturnValue([mkMcpCustomItem()]);
    const { sendResourceProvide } = useLoopbackDeps(null);

    handleResourceRequest({ requestId: 'req-11', resourceType: 'agent', slug: 'gone' }, 'node-peer');
    await flush();

    expect(sendResourceProvide).toHaveBeenCalledWith('node-peer', {
      requestId: 'req-11',
      definition: null,
    });
  });

  it('⑧d agent 全量定义反查失败（def 已删但目录未刷新）→ definition: null', async () => {
    resourceCustomMocks.listCustomResources.mockReturnValue([mkAgentCustomItem()]);
    agentCrudMocks.getAgentDefinition.mockReturnValue(null);
    const { sendResourceProvide } = useLoopbackDeps(null);

    handleResourceRequest({ requestId: 'req-12', resourceType: 'agent', slug: 'uuid-1' }, 'node-peer');
    await flush();

    expect(sendResourceProvide).toHaveBeenCalledWith('node-peer', {
      requestId: 'req-12',
      definition: null,
    });
  });

  it('⑧e 供给发送失败 → 吞错仅 warn（请求方将按 30s 超时自然收敛）', async () => {
    resourceCustomMocks.listCustomResources.mockReturnValue([mkMcpCustomItem()]);
    const sendResourceProvide = vi.fn(async () => {
      throw new Error('net down');
    });
    setResourceTransferDeps({
      sync: { sendResourceRequest: vi.fn(async () => {}), sendResourceProvide },
    });

    expect(() =>
      handleResourceRequest({ requestId: 'req-13', resourceType: 'mcp', slug: 'weather' }, 'node-peer'),
    ).not.toThrow();
    await flush();
  });

  it('⑪ deps 未装配 → 静默 no-op（不查 custom、不发送）', () => {
    handleResourceRequest({ requestId: 'req-14', resourceType: 'mcp', slug: 'weather' }, 'node-peer');

    expect(resourceCustomMocks.listCustomResources).not.toHaveBeenCalled();
  });
});

describe('resource:install p2p 分支端到端', () => {
  beforeEach(() => {
    registerResourceHandlers();
  });

  it('⑥ agent：p2p id → 真实 library 解析 → requestResourceImport → 落地 + 目录广播', async () => {
    seedRemoteCatalog();
    const { sendResourceRequest } = useLoopbackDeps(WIRE_AGENT_DEF);
    const broadcastSpy = vi.fn(async () => {});
    setResourceShareDeps({ sync: { broadcastResourceCatalog: broadcastSpy }, nodeId: 'node-me', nodeName: '本机节点' });

    const result = await ipcHandlers.get('resource:install')!({} as never, 'p2p-agent-a1b2c3d4-uuid-1');

    // preload install 返回 void——成功信号是列表刷新后条目出现在「我的上传」
    expect(result).toBeUndefined();
    // 请求携带完整 nodeId + 原始 slug（library p2p 映射的 slug 字段不掺节点前缀）
    expect(sendResourceRequest).toHaveBeenCalledWith(
      PEER,
      expect.objectContaining({ resourceType: 'agent', slug: 'uuid-1' }),
    );
    expect(agentCrudMocks.createCustomDef).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ slug: 'research-helper' }),
    );
    // 导入即 custom 写通道 → fire-and-forget 广播目录（与 registerMcp/uploadSkill 同语义）
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    // p2p 短路：不触发 marketplace catalog 拉取
    expect(marketplaceMocks.fetchCatalog).not.toHaveBeenCalled();
    expect(marketplaceMocks.installPackage).not.toHaveBeenCalled();
  });

  it('⑥b mcp：注册到 mcp_definitions（source=custom）', async () => {
    seedRemoteCatalog();
    useLoopbackDeps(WIRE_MCP_DEF);

    await ipcHandlers.get('resource:install')!({} as never, 'p2p-mcp-a1b2c3d4-weather');

    expect(hostManagerMocks.registerMcpDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'weather',
        command: 'npx',
        args: ['-y', 'weather-server'],
        source: 'custom',
      }),
    );
  });

  it('⑥c 对端回 not-found → handler 抛友好错误', async () => {
    seedRemoteCatalog();
    useLoopbackDeps(null);

    await expect(
      ipcHandlers.get('resource:install')!({} as never, 'p2p-agent-a1b2c3d4-uuid-1'),
    ).rejects.toThrow(/对端节点未找到资源/);
    expect(agentCrudMocks.createCustomDef).not.toHaveBeenCalled();
  });

  it('⑥d 对端无响应 → 30s 超时 → handler 抛友好错误', async () => {
    vi.useFakeTimers();
    try {
      seedRemoteCatalog();
      setResourceTransferDeps({
        sync: { sendResourceRequest: vi.fn(async () => {}), sendResourceProvide: vi.fn(async () => {}) },
      });

      // 先挂 rejection 断言再推进时钟——reject 发生在无 handler 状态下会被判 unhandled rejection
      const p = ipcHandlers.get('resource:install')!({} as never, 'p2p-mcp-a1b2c3d4-weather');
      const assertion = expect(p).rejects.toThrow(/超时/);
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('⑦ 节点不在缓存（离线 / 目录已 prune）→ 友好错误（区别于通用 id 不存在）', async () => {
    // 不 seed 缓存——getSharedResources 返回空 → resolveResourceById null
    const err = await ipcHandlers
      .get('resource:install')!({} as never, 'p2p-agent-a1b2c3d4-gone')
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/来源节点可能已离线/);
  });

  it('⑦b 非 p2p 源的既有守卫不变（custom 不可安装）', async () => {
    resourceCustomMocks.listCustomResources.mockReturnValue([mkMcpCustomItem()]);

    await expect(
      ipcHandlers.get('resource:install')!({} as never, 'custom-mcp-weather'),
    ).rejects.toThrow(/不可安装/);
  });
});

describe('resolveResourceById p2p 往返（T4 deferred）', () => {
  it('⑨ p2p id → listResources 反解 → 全字段还原（原始 slug + peerId 是 install 分支的消费契约）', async () => {
    seedRemoteCatalog();

    const item = await resolveResourceById('p2p-agent-a1b2c3d4-uuid-1');

    expect(item).toMatchObject({
      id: 'p2p-agent-a1b2c3d4-uuid-1',
      type: 'agent',
      source: 'p2p',
      slug: 'uuid-1',
      name: '研究助手',
      installed: false,
      installable: true,
      removable: false,
      p2p: { peerId: PEER, peerName: '节点A' },
    });
  });

  it('⑨b 条目过期（>5min prune）→ 同一 id 返回 null（install 分支转友好错误）', async () => {
    writeResourceCatalog(
      { nodeId: PEER, nodeName: '节点A', items: [{ type: 'agent', slug: 'uuid-1', name: '研究助手', description: 'd' }], takenAt: Date.now() - 6 * 60_000 },
      PEER,
    );

    const item = await resolveResourceById('p2p-agent-a1b2c3d4-uuid-1');

    expect(item).toBeNull();
  });
});

describe('initP2p 接线（index.ts）', () => {
  it('⑩a 入站 resource-request → 供给方查本地 → 真实 P2pSync 单发 provide 到来源节点', async () => {
    resourceCustomMocks.listCustomResources.mockReturnValue([mkMcpCustomItem()]);
    try {
      await initP2p();
      expect(incomingHandler.current).toBeTruthy();

      incomingHandler.current!({
        fromNodeId: PEER,
        payload: {
          targetNodeId: 'node-me',
          type: 'resource-request',
          body: { requestId: 'req-5', resourceType: 'mcp', slug: 'weather' },
        },
        receivedAt: Date.now(),
      });

      await vi.waitFor(() =>
        expect(routerSendCalls.some((c) => c.payload.type === 'resource-provide')).toBe(true),
      );
      const provide = routerSendCalls.find((c) => c.payload.type === 'resource-provide')!;
      expect(provide.target).toBe(PEER);
      expect(provide.payload.body).toMatchObject({
        requestId: 'req-5',
        definition: { name: 'weather', command: 'npx', args: ['-y', 'weather-server'] },
      });
    } finally {
      await stopP2p();
    }
  });

  it('⑩b 入站 resource-provide → pending resolve：requestResourceImport 全链路 ok + 落地', async () => {
    try {
      await initP2p();

      const p = requestResourceImport(PEER, 'agent', 'uuid-1');
      await vi.waitFor(() =>
        expect(routerSendCalls.some((c) => c.payload.type === 'resource-request')).toBe(true),
      );
      const reqCall = routerSendCalls.find((c) => c.payload.type === 'resource-request')!;
      const requestId = (reqCall.payload.body as { requestId: string }).requestId;

      incomingHandler.current!({
        fromNodeId: PEER,
        payload: {
          targetNodeId: 'node-me',
          type: 'resource-provide',
          body: { requestId, definition: WIRE_AGENT_DEF },
        },
        receivedAt: Date.now(),
      });

      expect(await p).toBe('ok');
      expect(agentCrudMocks.createCustomDef).toHaveBeenCalledTimes(1);
    } finally {
      await stopP2p();
    }
  });

  it('⑩c stopP2p 清空 transfer deps（后续导入请求抛错）', async () => {
    await initP2p();
    await stopP2p();

    await expect(requestResourceImport(PEER, 'agent', 'uuid-1')).rejects.toThrow(/P2P 未启用/);
  });
});
