// electron/tests/agent/sub-agent-install.test.ts
//
// assignMainAgent（主子 agent 安装跟随）单元测试。
// 通过 vi.mock 替换 ipc.handlers.ts 的全部外部依赖（crud / bot-registrar /
// matrix / workspace / keychain / runtime-manager），并 stub 掉 electron 的
// ipcMain，从而可以直接调用导出的 assignMainAgent 函数，验证：
//   1. 给定 1 main + 2 subs，返回 3 个 assignment（首条为 main），且每个 agent
//      都走完「注册 bot → 分配 → 邀请 → 存 key → 启动 runtime」全套编排；
//   2. parentAgentId 指向其它 main 或为空的定义不会被安装；
//   3. main 定义不存在 / workspace 不存在 / 团队群未创建时抛错；
//   4. 无 sub 时仅安装 main。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import type { AgentDefinition, AgentAssignment } from '../../src/main/agent/types';
import type { RegisterAgentBotOpts, RegisteredBot } from '../../src/main/agent/bot-registrar';
import type { Workspace } from '../../src/main/workspace/types';

// vi.hoisted 保证桩函数在 vi.mock 工厂（会被提升到文件顶部）执行时就绪。
const stubs = vi.hoisted(() => ({
  getAgentDefinition: vi.fn(),
  listAgentDefinitions: vi.fn(),
  assignAgentToWorkspace: vi.fn(),
  registerAgentBot: vi.fn(),
  inviteBotToRoom: vi.fn(),
  getOwnerMatrixClient: vi.fn(),
  getWorkspace: vi.fn(),
  getAllocation: vi.fn(),
  setSecret: vi.fn(),
  spawnAgent: vi.fn(),
}));

// stub 掉 electron 的 ipcMain —— 本测试不经过 ipcMain.handle，仅保证模块可加载。
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

vi.mock('../../src/main/agent/crud', () => ({
  saveAgentDefinition: vi.fn(),
  getAgentDefinition: stubs.getAgentDefinition,
  listAgentDefinitions: stubs.listAgentDefinitions,
  assignAgentToWorkspace: stubs.assignAgentToWorkspace,
  listAssignments: vi.fn(),
}));

vi.mock('../../src/main/agent/bot-registrar', () => ({
  registerAgentBot: stubs.registerAgentBot,
}));

vi.mock('../../src/main/matrix/rooms', () => ({
  inviteBotToRoom: stubs.inviteBotToRoom,
}));

vi.mock('../../src/main/matrix/session', () => ({
  getOwnerMatrixClient: stubs.getOwnerMatrixClient,
}));

vi.mock('../../src/main/workspace/crud', () => ({
  getWorkspace: stubs.getWorkspace,
}));

// T13：ipc.handlers 现在调用 getAllocation 合并 workspace 级能力。mock 返回空分配，
// 使 mergeCapabilities(def, empty) === def 默认能力，保持测试原有断言语义。
vi.mock('../../src/main/workspace/allocation', () => ({
  getAllocation: stubs.getAllocation,
}));

vi.mock('../../src/main/storage/keychain', () => ({
  setSecret: stubs.setSecret,
  getSecret: vi.fn(),
}));

vi.mock('../../src/main/agent/runtime-manager', () => ({
  spawnAgent: stubs.spawnAgent,
  stopAgent: vi.fn(),
  isAgentRunning: vi.fn(),
}));

import { assignMainAgent } from '../../src/main/agent/ipc.handlers';

const WORKSPACE_ID = 'ws-1';
const TEAM_ROOM_ID = '!team:localhost';
const API_KEY = 'sk-test-key';

// owner client 哨兵对象（inviteBotToRoom 被 mock，实际不使用其方法）
const OWNER_CLIENT = {} as MatrixClient;

const WORKSPACE: Workspace = {
  id: WORKSPACE_ID,
  name: 'proj-x',
  description: '',
  directoryPath: '/tmp/proj-x',
  matrixSpaceId: '!space:localhost',
  teamRoomId: TEAM_ROOM_ID,
  gitInitialized: true,
  createdAt: '2026-07-28',
  ownerId: '@alice:localhost',
  iconEmoji: '📁',
};

function makeDef(overrides: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: 'def',
    name: 'n',
    slug: 'slug',
    version: '1.0.0',
    type: 'standalone',
    runtime: 'declarative',
    systemPrompt: 'prompt',
    model: { provider: 'openai', model: 'gpt-4o' },
    defaultTools: [],
    source: 'builtin',
    description: '',
    iconEmoji: '🤖',
    parentAgentId: undefined,
    defaultMcps: [],
    defaultSkills: [],
    ...overrides,
  };
}

const MAIN_DEF = makeDef({ id: 'main-1', slug: 'main-agent', type: 'main' });
const SUB_A = makeDef({ id: 'sub-a', slug: 'sub-a', type: 'sub', parentAgentId: 'main-1' });
const SUB_B = makeDef({ id: 'sub-b', slug: 'sub-b', type: 'sub', parentAgentId: 'main-1' });
// 这两个不应被安装：parent 指向别的 main / 无 parent
const OTHER_SUB = makeDef({ id: 'sub-other', slug: 'sub-other', type: 'sub', parentAgentId: 'main-other' });
const STANDALONE = makeDef({ id: 'standalone-1', slug: 'solo', type: 'standalone' });

/** bot user id 由 slug 确定性派生，便于断言而无需计数器 */
const botUserId = (slug: string): string => `@${slug}.bot:localhost`;
/** assignment instanceId 由 def id 确定性派生 */
const instanceId = (defId: string): string => `inst-${defId}`;

/**
 * 安装全部桩的默认实现。registerAgentBot / assignAgentToWorkspace 的返回值
 * 均由入参确定性派生，使各 agent 的 bot user id / instanceId 可在断言中直接写出。
 */
function installDeterministicStubs(): void {
  stubs.registerAgentBot.mockImplementation(async (opts: RegisterAgentBotOpts): Promise<RegisteredBot> => {
    return {
      botUserId: botUserId(opts.slug),
      botAccessToken: `tok-${opts.slug}`,
      botDeviceId: 'DEV',
    };
  });
  stubs.assignAgentToWorkspace.mockImplementation(
    (workspaceId: string, agentDefinitionId: string, botMatrixUserId: string): AgentAssignment => {
      return {
        instanceId: instanceId(agentDefinitionId),
        workspaceId,
        agentDefinitionId,
        botMatrixUserId,
        enabled: true,
        createdAt: '2026-07-28',
      };
    },
  );
  stubs.getWorkspace.mockReturnValue(WORKSPACE);
  stubs.getAllocation.mockReturnValue({ workspaceId: WORKSPACE_ID, tools: [], mcps: [], skills: [] });
  stubs.setSecret.mockResolvedValue(undefined);
}

describe('agent:assignMain（主子 agent 安装跟随）', () => {
  beforeEach(() => {
    Object.values(stubs).forEach((fn) => fn.mockReset());
    stubs.getOwnerMatrixClient.mockResolvedValue(OWNER_CLIENT);
    installDeterministicStubs();
  });

  it('1 main + 2 subs → 安装 3 个 agent（main 在前），每个走完整套编排', async () => {
    stubs.getAgentDefinition.mockReturnValue(MAIN_DEF);
    // 列表混入不应被安装的 OTHER_SUB / STANDALONE，验证过滤
    stubs.listAgentDefinitions.mockReturnValue([STANDALONE, MAIN_DEF, SUB_A, OTHER_SUB, SUB_B]);

    const results = await assignMainAgent({
      workspaceId: WORKSPACE_ID,
      mainDefId: 'main-1',
      llmApiKey: API_KEY,
    });

    // 返回顺序：main → sub-a → sub-b
    expect(results.map((r) => r.agentDefinitionId)).toEqual(['main-1', 'sub-a', 'sub-b']);
    expect(results).toHaveLength(3);

    // 每个依赖均被调用 3 次
    expect(stubs.registerAgentBot).toHaveBeenCalledTimes(3);
    expect(stubs.assignAgentToWorkspace).toHaveBeenCalledTimes(3);
    expect(stubs.inviteBotToRoom).toHaveBeenCalledTimes(3);
    expect(stubs.setSecret).toHaveBeenCalledTimes(3);
    expect(stubs.spawnAgent).toHaveBeenCalledTimes(3);

    // bot 注册按 main → sub-a → sub-b 顺序，使用各 def 的 slug
    expect(stubs.registerAgentBot).toHaveBeenNthCalledWith(1, expect.objectContaining({ slug: 'main-agent' }));
    expect(stubs.registerAgentBot).toHaveBeenNthCalledWith(2, expect.objectContaining({ slug: 'sub-a' }));
    expect(stubs.registerAgentBot).toHaveBeenNthCalledWith(3, expect.objectContaining({ slug: 'sub-b' }));

    // 分配使用各自 def id 与确定性派生的 bot user id
    expect(stubs.assignAgentToWorkspace).toHaveBeenNthCalledWith(
      1,
      WORKSPACE_ID,
      'main-1',
      botUserId('main-agent'),
    );
    expect(stubs.assignAgentToWorkspace).toHaveBeenNthCalledWith(
      3,
      WORKSPACE_ID,
      'sub-b',
      botUserId('sub-b'),
    );

    // 邀请使用 owner client + 团队群 + 对应 bot
    expect(stubs.inviteBotToRoom).toHaveBeenNthCalledWith(1, OWNER_CLIENT, TEAM_ROOM_ID, botUserId('main-agent'));
    expect(stubs.inviteBotToRoom).toHaveBeenNthCalledWith(3, OWNER_CLIENT, TEAM_ROOM_ID, botUserId('sub-b'));

    // API key 按各 instance 存入 keychain（instanceId 由 def id 派生）
    expect(stubs.setSecret).toHaveBeenNthCalledWith(1, `agent.${instanceId('main-1')}.llm_api_key`, API_KEY);
    expect(stubs.setSecret).toHaveBeenNthCalledWith(3, `agent.${instanceId('sub-b')}.llm_api_key`, API_KEY);

    // runtime 启动配置携带正确 bot + def 信息
    expect(stubs.spawnAgent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        instanceId: instanceId('main-1'),
        botUserId: botUserId('main-agent'),
        systemPrompt: MAIN_DEF.systemPrompt,
        modelProvider: 'openai',
        teamRoomId: TEAM_ROOM_ID,
      }),
    );
    expect(stubs.spawnAgent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ instanceId: instanceId('sub-a'), botUserId: botUserId('sub-a') }),
    );
  });

  it('parentAgentId 指向其它 main 或为空的定义不会被安装', async () => {
    stubs.getAgentDefinition.mockReturnValue(MAIN_DEF);
    // 列表里只有 MAIN + SUB_A 指向 main-1；OTHER_SUB / STANDALONE 应被过滤
    stubs.listAgentDefinitions.mockReturnValue([STANDALONE, OTHER_SUB, MAIN_DEF, SUB_A]);

    const results = await assignMainAgent({
      workspaceId: WORKSPACE_ID,
      mainDefId: 'main-1',
      llmApiKey: API_KEY,
    });

    // 仅 main + sub-a 被安装
    expect(results.map((r) => r.agentDefinitionId)).toEqual(['main-1', 'sub-a']);
    expect(stubs.registerAgentBot).toHaveBeenCalledTimes(2);
    expect(stubs.spawnAgent).toHaveBeenCalledTimes(2);
  });

  it('无 sub 时仅安装 main，返回单条 assignment', async () => {
    stubs.getAgentDefinition.mockReturnValue(MAIN_DEF);
    stubs.listAgentDefinitions.mockReturnValue([STANDALONE, OTHER_SUB, MAIN_DEF]);

    const results = await assignMainAgent({
      workspaceId: WORKSPACE_ID,
      mainDefId: 'main-1',
      llmApiKey: API_KEY,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.agentDefinitionId).toBe('main-1');
    expect(stubs.registerAgentBot).toHaveBeenCalledTimes(1);
    expect(stubs.spawnAgent).toHaveBeenCalledTimes(1);
  });

  it('main 定义不存在时抛错且无副作用', async () => {
    stubs.getAgentDefinition.mockReturnValue(null);

    await expect(
      assignMainAgent({ workspaceId: WORKSPACE_ID, mainDefId: 'missing', llmApiKey: API_KEY }),
    ).rejects.toThrow('未找到 agent 定义');

    expect(stubs.registerAgentBot).not.toHaveBeenCalled();
    expect(stubs.spawnAgent).not.toHaveBeenCalled();
  });

  it('workspace 不存在时抛错且无副作用', async () => {
    stubs.getAgentDefinition.mockReturnValue(MAIN_DEF);
    stubs.getWorkspace.mockReturnValue(null);

    await expect(
      assignMainAgent({ workspaceId: 'nope', mainDefId: 'main-1', llmApiKey: API_KEY }),
    ).rejects.toThrow('未找到 workspace');

    expect(stubs.registerAgentBot).not.toHaveBeenCalled();
  });

  it('workspace 未创建团队群时抛错', async () => {
    stubs.getAgentDefinition.mockReturnValue(MAIN_DEF);
    stubs.getWorkspace.mockReturnValue({ ...WORKSPACE, teamRoomId: '' });

    await expect(
      assignMainAgent({ workspaceId: WORKSPACE_ID, mainDefId: 'main-1', llmApiKey: API_KEY }),
    ).rejects.toThrow('团队群');

    expect(stubs.registerAgentBot).not.toHaveBeenCalled();
  });
});
