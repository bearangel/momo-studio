// hub IPC 面接线锁：通道注册与 payload 透传（manager 逻辑在 client.test 已锁，这里只锁接线）。
// 工作组六通道（M2b T4）：真实 groups 客户端 + mock hubRequest——断言方法名与载荷映射。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../src/main/hub/index', () => ({
  initHub: vi.fn(),
  stopHub: vi.fn(),
  hubGetStatus: vi.fn(() => ({ configured: false, state: 'disconnected', hubUrl: null, nodeName: null, nodeId: null, lastError: null, lastErrorCode: null, hubProtoVer: null })),
  hubConfigure: vi.fn(async (input: { hubUrl: string }) => ({ configured: true, state: 'connecting', hubUrl: input.hubUrl, nodeName: 'a', nodeId: null, lastError: null, lastErrorCode: null, hubProtoVer: null })),
  hubEnroll: vi.fn(async () => ({ configured: true, state: 'connecting', hubUrl: 'http://h', nodeName: 'a', nodeId: 'n1', lastError: null, lastErrorCode: null, hubProtoVer: null })),
  hubForget: vi.fn(async () => undefined),
  replayPresenceSeed: vi.fn(),
  hubGetPresenceNodes: vi.fn(() => [{ nodeId: 'node-1', nodeName: '本机' }]),
  hubRequest: vi.fn(async () => ({})),
  hubGetDelegationSettings: vi.fn(() => ({ acceptTasks: true, maxConcurrent: 2, hitlTimeoutMinutes: 15 })),
  hubSetDelegationSettings: vi.fn(async (input: { acceptTasks: boolean; maxConcurrent: number; hitlTimeoutMinutes: number }) => input),
  hubGetWorkspaceDirSettings: vi.fn(() => ({ rootDir: null, defaultRootDir: '/d/workspaces', effectiveRootDir: '/d/workspaces' })),
  hubSetWorkspaceDirSettings: vi.fn(async (input: { rootDir: string | null }) => ({ rootDir: input.rootDir, defaultRootDir: '/d/workspaces', effectiveRootDir: input.rootDir ?? '/d/workspaces' })),
  hubGetViewSettings: vi.fn(() => ({ allowGroupView: true })),
  hubSetViewSettings: vi.fn(async (input: { allowGroupView: boolean }) => input),
  hubDelegationBoard: vi.fn(() => ({ progress: {}, received: [] })),
  hubMarkDelegationCancelled: vi.fn(),
  hubListMirrorRegistry: vi.fn(() => []),
}));

// 本地 DB 边界（momo-test-rules #5：DB 属进程边界可 mock）：retryDispatch /
// submitRoutedTask 通道链路触达 getTask / listWorkspaces——真实实现会开库建表
// （electron app 被_mock_ 后无 userData 路径），hub RPC 仍统一走 hubRequest mock
vi.mock('../../src/main/storage/tasks/repo', () => ({
  insertTask: vi.fn(),
  updateTask: vi.fn(),
  getTask: vi.fn(() => null),
}));
// M4.3 taskDelegate 派发闸数据源（同为 DB 边界）：缺省空 Map = 不阻塞（真源形状）
vi.mock('../../src/main/storage/tasks/dependencies-repo', () => ({
  deriveBlockedBy: vi.fn(() => new Map<string, string[]>()),
}));
vi.mock('../../src/main/workspace/crud', () => ({
  listWorkspaces: vi.fn(() => []),
}));

// publishToHub 只锁接线（透传入参）——打包/上传矩阵在 publish.test.ts
vi.mock('../../src/main/hub/publish', () => ({
  publishToHub: vi.fn(async (input: { type: string; ref: string }) => ({ slug: input.ref, version: '1.0.0', checksum: 'c', sizeBytes: 1 })),
}));

// 发布回填记账只锁接线（四类统一调 Safe 壳）——DB 行为矩阵在 publish-accounting.test.ts
vi.mock('../../src/main/resource/hub-install', () => ({
  recordPublishAccountingSafe: vi.fn(),
}));

// 撤回客户端只锁接线（slug 透传）——HTTP 矩阵在 tests/resource/hub-unpublish.test.ts。
// importOriginal 保留其余导出（momo-hub 被安装链等传递依赖消费，整体 mock 会破面）
vi.mock('../../src/main/resource/hub/momo-hub', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/resource/hub/momo-hub')>();
  return { ...actual, unpublishHubResource: vi.fn(async (slug: string) => `${slug} 已下架`) };
});

import { registerHubIpc } from '../../src/main/hub/ipc.handlers';
import * as manager from '../../src/main/hub/index';
import { publishToHub } from '../../src/main/hub/publish';
import { RpcRemoteError } from '../../src/main/hub/client';
import { recordPublishAccountingSafe } from '../../src/main/resource/hub-install';
import { unpublishHubResource } from '../../src/main/resource/hub/momo-hub';
import { getTask } from '../../src/main/storage/tasks/repo';
import { deriveBlockedBy } from '../../src/main/storage/tasks/dependencies-repo';
import { listWorkspaces } from '../../src/main/workspace/crud';
import type { TaskRow } from '../../src/main/storage/tasks/repo';
import type { Workspace } from '../../src/main/workspace/types';
// 双侧 fixture 单源（hub-capability-contract.test.ts 同款跨仓 import 模式）：
// renderer 侧 rpc-error.ts 的 fixture 在此消费——coded 编码 → parseRpcErrorCode
// 解码的等值关系改动必须两侧同 commit 红
import { parseRpcErrorCode, RPC_ERROR_ROUNDTRIP_FIXTURES } from '../../../renderer/src/lib/rpc-error';

const GROUP_CHANNELS = ['hub:groupCreate', 'hub:groupInvite', 'hub:groupJoin', 'hub:groupLeave', 'hub:groupList', 'hub:groupTransfer'];
const MIRROR_CHANNELS = ['hub:snapshotBuildUpload', 'hub:mirrorWorkspace', 'hub:mirrorRegistry'];
const DELEGATION_CHANNELS = ['hub:getDelegationSettings', 'hub:setDelegationSettings'];
const WS_DIR_CHANNELS = ['hub:getWorkspaceDirSettings', 'hub:setWorkspaceDirSettings'];
const TASK_CHANNELS = ['hub:taskList', 'hub:taskDelegate', 'hub:taskCancel', 'hub:taskAnswer'];
const ROUTING_CHANNELS = ['hub:submitRoutedTask', 'hub:routingPrecheck'];
const BOARD_CHANNELS = ['hub:delegationBoard', 'hub:retryDispatch', 'hub:localWaiting'];
const VIEW_CHANNELS = [
  'hub:getViewSettings', 'hub:setViewSettings',
  'hub:viewWorkspace', 'hub:viewSessions', 'hub:viewMessages', 'hub:viewTasks',
  'hub:viewSubscribe', 'hub:viewUnsubscribe',
  'hub:viewWorkspaces', 'hub:viewFiles',
];

beforeEach(() => { handlers.clear(); vi.clearAllMocks(); });

describe('hub IPC 接线', () => {
  it('注册三十九通道（M2.5 T3 增 hub:getNodes；M3.1 增 hub:taskAnswer；M3.2 增 viewWorkspaces/viewFiles；M3.4 增 hub:unpublishResource）；getStatus 透传 manager', async () => {
    registerHubIpc();
    expect([...handlers.keys()].sort()).toEqual([
      ...GROUP_CHANNELS,
      ...MIRROR_CHANNELS,
      ...DELEGATION_CHANNELS,
      ...WS_DIR_CHANNELS,
      ...TASK_CHANNELS,
      ...ROUTING_CHANNELS,
      ...BOARD_CHANNELS,
      ...VIEW_CHANNELS,
      'hub:configure', 'hub:enroll', 'hub:forget', 'hub:getStatus', 'hub:publishResource', 'hub:unpublishResource', 'hub:getNodes',
    ].sort());
    expect(await handlers.get('hub:getStatus')!()).toEqual(await manager.hubGetStatus());
  });

  it('getNodes → 透传 manager.hubGetPresenceNodes（本机行 + 在线对端权威集合）', async () => {
    registerHubIpc();
    expect(await handlers.get('hub:getNodes')!()).toEqual([{ nodeId: 'node-1', nodeName: '本机' }]);
    expect(manager.hubGetPresenceNodes).toHaveBeenCalledTimes(1);
  });

  it('configure/enroll 透传参数', async () => {
    registerHubIpc();
    await handlers.get('hub:configure')!(null, { hubUrl: 'http://h', nodeName: 'a' });
    expect(manager.hubConfigure).toHaveBeenCalledWith({ hubUrl: 'http://h', nodeName: 'a' });
    await handlers.get('hub:enroll')!(null, { hubUrl: 'http://h', enrollmentToken: 't', nodeName: 'a' });
    expect(manager.hubEnroll).toHaveBeenCalledWith({ hubUrl: 'http://h', enrollmentToken: 't', nodeName: 'a' });
  });

  it('forget 透传', async () => {
    registerHubIpc();
    await handlers.get('hub:forget')!();
    expect(manager.hubForget).toHaveBeenCalledTimes(1);
  });

  it('getStatus → 顺带重播在线节点种子（面板挂载晚于 hello 的补齐面）', async () => {
    registerHubIpc();
    await handlers.get('hub:getStatus')!();
    expect(manager.replayPresenceSeed).toHaveBeenCalledTimes(1);
  });

  it('publishResource 透传 publishToHub（入参原样 + 回执透传）', async () => {
    registerHubIpc();
    const out = await handlers.get('hub:publishResource')!(null, { type: 'skill', ref: 's1', meta: { name: 'N' } });
    expect(publishToHub).toHaveBeenCalledWith({ type: 'skill', ref: 's1', meta: { name: 'N' } });
    expect(out).toEqual({ slug: 's1', version: '1.0.0', checksum: 'c', sizeBytes: 1 });
  });

  it('publishResource 四类型发布各触发记账回填（Safe 壳透传 type/slug/version/checksum）', async () => {
    registerHubIpc();
    for (const type of ['agent', 'skill', 'mcp', 'plugin'] as const) {
      await handlers.get('hub:publishResource')!(null, { type, ref: `${type}-1` });
      expect(recordPublishAccountingSafe).toHaveBeenLastCalledWith(type, `${type}-1`, '1.0.0', 'c');
    }
    expect(recordPublishAccountingSafe).toHaveBeenCalledTimes(4);
  });

  it('unpublishResource 透传 unpublishHubResource（slug 入参原样；M3.4 §2.3.4）', async () => {
    registerHubIpc();
    await handlers.get('hub:unpublishResource')!(null, { slug: 'gone-skill' });
    expect(unpublishHubResource).toHaveBeenCalledWith('gone-skill');
  });

  it('委派设置两通道：get 透传 hubGetDelegationSettings；set 透传入参并回传归一化值', async () => {
    registerHubIpc();
    const got = await handlers.get('hub:getDelegationSettings')!();
    expect(got).toEqual({ acceptTasks: true, maxConcurrent: 2, hitlTimeoutMinutes: 15 });
    expect(manager.hubGetDelegationSettings).toHaveBeenCalledTimes(1);
    const set = await handlers.get('hub:setDelegationSettings')!(
      null, { acceptTasks: false, maxConcurrent: 4, hitlTimeoutMinutes: 20 });
    expect(set).toEqual({ acceptTasks: false, maxConcurrent: 4, hitlTimeoutMinutes: 20 });
    expect(manager.hubSetDelegationSettings).toHaveBeenCalledWith({ acceptTasks: false, maxConcurrent: 4, hitlTimeoutMinutes: 20 });
  });

  it('工作目录两通道：get 透传 hubGetWorkspaceDirSettings；set 透传入参（含 null 恢复默认）并回传 view', async () => {
    registerHubIpc();
    const got = await handlers.get('hub:getWorkspaceDirSettings')!();
    expect(got).toEqual({ rootDir: null, defaultRootDir: '/d/workspaces', effectiveRootDir: '/d/workspaces' });
    expect(manager.hubGetWorkspaceDirSettings).toHaveBeenCalledTimes(1);
    const set = await handlers.get('hub:setWorkspaceDirSettings')!(null, { rootDir: '/custom' });
    expect(set).toEqual({ rootDir: '/custom', defaultRootDir: '/d/workspaces', effectiveRootDir: '/custom' });
    expect(manager.hubSetWorkspaceDirSettings).toHaveBeenCalledWith({ rootDir: '/custom' });
    const reset = await handlers.get('hub:setWorkspaceDirSettings')!(null, { rootDir: null }) as { effectiveRootDir: string };
    expect(manager.hubSetWorkspaceDirSettings).toHaveBeenLastCalledWith({ rootDir: null });
    expect(reset.effectiveRootDir).toBe('/d/workspaces');
  });
});

describe('hub IPC 工作组六通道（M2b T4）', () => {
  it('groupList → hubRequest("group.list", {})；回执透传', async () => {
    registerHubIpc();
    vi.mocked(manager.hubRequest).mockResolvedValueOnce({ groups: [{ groupId: 'g1', groupName: 'T', leaderNodeId: 'n1', members: [] }] });
    const out = await handlers.get('hub:groupList')!();
    expect(manager.hubRequest).toHaveBeenCalledWith('group.list', {}, undefined);
    expect(out).toEqual({ groups: [{ groupId: 'g1', groupName: 'T', leaderNodeId: 'n1', members: [] }] });
  });

  it('groupCreate → group.create {groupName}（trim 归 renderer 表单，主进程原样透传）', async () => {
    registerHubIpc();
    vi.mocked(manager.hubRequest).mockResolvedValueOnce({ groupId: 'g1', nodeId: 'n1' });
    const out = await handlers.get('hub:groupCreate')!(null, { groupName: 'TeamA' });
    expect(manager.hubRequest).toHaveBeenCalledWith('group.create', { groupName: 'TeamA' }, undefined);
    expect(out).toEqual({ groupId: 'g1', nodeId: 'n1' });
  });

  it('groupInvite/groupJoin/groupLeave/groupTransfer → 方法名与载荷逐项映射', async () => {
    registerHubIpc();
    await handlers.get('hub:groupInvite')!(null, { groupId: 'g1' });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('group.invite', { groupId: 'g1' }, undefined);
    await handlers.get('hub:groupJoin')!(null, { inviteCode: 'c1' });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('group.join', { inviteCode: 'c1' }, undefined);
    await handlers.get('hub:groupLeave')!(null, { groupId: 'g1' });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('group.leave', { groupId: 'g1' }, undefined);
    await handlers.get('hub:groupTransfer')!(null, { groupId: 'g1', toNodeId: 'n2' });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('group.transfer', { groupId: 'g1', toNodeId: 'n2' }, undefined);
    expect(manager.hubRequest).toHaveBeenCalledTimes(4);
  });

  it('hubRequest rejection 原样抛出（IPC 通道不吞错）', async () => {
    registerHubIpc();
    vi.mocked(manager.hubRequest).mockRejectedValueOnce(new Error('仅组长（leader）可执行该操作'));
    await expect(handlers.get('hub:groupTransfer')!(null, { groupId: 'g1', toNodeId: 'n2' }))
      .rejects.toThrow('仅组长（leader）可执行该操作');
  });
});

describe('hub IPC 委派 leader 侧三通道（M2e T12）', () => {
  it('taskList → task.list；groupId 缺省发空载荷、指定原样透传', async () => {
    registerHubIpc();
    vi.mocked(manager.hubRequest).mockResolvedValueOnce({ tasks: [] });
    await handlers.get('hub:taskList')!();
    expect(manager.hubRequest).toHaveBeenLastCalledWith('task.list', {}, undefined);

    vi.mocked(manager.hubRequest).mockResolvedValueOnce({ tasks: [] });
    await handlers.get('hub:taskList')!(null, { groupId: 'g1' });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('task.list', { groupId: 'g1' }, undefined);
  });

  it('taskDelegate → task.delegate；任务书嵌套成形 + agentSlug 空串剥除', async () => {
    registerHubIpc();
    vi.mocked(manager.hubRequest).mockResolvedValueOnce({ taskId: 'tk-1' });
    const out = await handlers.get('hub:taskDelegate')!(null, {
      groupId: 'g1', targetNodeId: 'n2', workspaceName: 'product-dev',
      title: '重构登录', prompt: '请重构登录模块。', agentSlug: '',
    });
    expect(manager.hubRequest).toHaveBeenCalledWith('task.delegate', {
      groupId: 'g1',
      targetNodeId: 'n2',
      workspaceName: 'product-dev',
      task: { title: '重构登录', prompt: '请重构登录模块。' },
    }, undefined);
    expect(out).toEqual({ taskId: 'tk-1' });

    await handlers.get('hub:taskDelegate')!(null, {
      groupId: 'g1', targetNodeId: 'n2', workspaceName: 'product-dev',
      title: '重构登录', prompt: '请重构登录模块。', agentSlug: 'coder',
    });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('task.delegate', {
      groupId: 'g1',
      targetNodeId: 'n2',
      workspaceName: 'product-dev',
      task: { title: '重构登录', prompt: '请重构登录模块。', agentSlug: 'coder' },
    }, undefined);
  });

  it('taskDelegate M4.3 派发闸：taskId 在场且 blocked → 人话拒绝（与 retryDispatch 逐字同源），零 RPC；taskId 缺省 / 依赖完成 → 放行透传', async () => {
    registerHubIpc();
    // blocked：拒绝文案单源（blockedDispatchError——delegation-sync E-1 锁同串）
    vi.mocked(deriveBlockedBy).mockReturnValueOnce(new Map([['T-100', ['T-007']]]));
    await expect(handlers.get('hub:taskDelegate')!(null, {
      groupId: 'g1', targetNodeId: 'n2', workspaceName: 'product-dev',
      title: '外派被阻塞', prompt: 'x', taskId: 'T-100',
    })).rejects.toThrow('任务存在未完成依赖（T-007），依赖完成前不可派发');
    expect(manager.hubRequest).not.toHaveBeenCalled();

    // 依赖完成（派生空）→ 放行：taskId 仅闸用，不渗入 RPC 载荷
    vi.mocked(manager.hubRequest).mockResolvedValueOnce({ taskId: 'tk-9' });
    const out = await handlers.get('hub:taskDelegate')!(null, {
      groupId: 'g1', targetNodeId: 'n2', workspaceName: 'product-dev',
      title: '外派已解锁', prompt: 'x', taskId: 'T-100',
    });
    expect(out).toEqual({ taskId: 'tk-9' });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('task.delegate', {
      groupId: 'g1',
      targetNodeId: 'n2',
      workspaceName: 'product-dev',
      task: { title: '外派已解锁', prompt: 'x' },
    }, undefined);
  });

  it('taskCancel → task.cancel 原样透传 + 取消回执触发外派行同步（T9）；rejection 人话不吞', async () => {
    registerHubIpc();
    vi.mocked(manager.hubRequest).mockResolvedValueOnce({ ok: true });
    const out = await handlers.get('hub:taskCancel')!(null, { taskId: 'tk-1' });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('task.cancel', { taskId: 'tk-1' }, undefined);
    expect(out).toEqual({ ok: true });
    // 取消链收口（T9）：hub 账本权威 → delegation-sync 行状态同步
    expect(manager.hubMarkDelegationCancelled).toHaveBeenCalledWith('tk-1');

    vi.mocked(manager.hubRequest).mockRejectedValueOnce(new Error('任务已处于终态 done，不可取消'));
    await expect(handlers.get('hub:taskCancel')!(null, { taskId: 'tk-2' }))
      .rejects.toThrow('任务已处于终态 done，不可取消');
    // rejection 路径不触发行同步（hub 账本未迁移）
    expect(manager.hubMarkDelegationCancelled).toHaveBeenCalledTimes(1);
  });

  it('taskAnswer → task.answer 原样透传；RpcRemoteError 编码 `[code] 原文` 前缀再抛（M3.1——Electron IPC 只保 message，renderer 据前缀判版本过低类降级）；非 RPC 错误原文抛', async () => {
    registerHubIpc();
    vi.mocked(manager.hubRequest).mockResolvedValueOnce({ disposition: 'granted' });
    const out = await handlers.get('hub:taskAnswer')!(null, { taskId: 'tk-1', decision: 'approve' });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('task.answer', { taskId: 'tk-1', decision: 'approve' }, undefined);
    expect(out).toEqual({ disposition: 'granted' });
    // message 可选字段透传（≤512 校验在 hub 侧）
    vi.mocked(manager.hubRequest).mockResolvedValueOnce({ disposition: 'stale' });
    await handlers.get('hub:taskAnswer')!(null, { taskId: 'tk-2', decision: 'deny', message: '稍后处理' });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('task.answer', { taskId: 'tk-2', decision: 'deny', message: '稍后处理' }, undefined);

    // RpcRemoteError：code 入前缀（renderer 端 ANSWER_VERSION_LOW_CODES 消费同格式）
    vi.mocked(manager.hubRequest).mockRejectedValueOnce(new RpcRemoteError('node_unsupported', '目标节点协议版本 1.2.0 过低'));
    await expect(handlers.get('hub:taskAnswer')!(null, { taskId: 'tk-3', decision: 'approve' }))
      .rejects.toThrow('[node_unsupported] 目标节点协议版本 1.2.0 过低');
    // 普通 Error：不加前缀原样抛（人话链路不变）
    vi.mocked(manager.hubRequest).mockRejectedValueOnce(new Error('hub 未连接，请稍后重试'));
    await expect(handlers.get('hub:taskAnswer')!(null, { taskId: 'tk-4', decision: 'deny' }))
      .rejects.toThrow('hub 未连接，请稍后重试');
  });
});

describe('hub IPC 远程查看通道（M2e T14）', () => {
  it('查看设置两通道：get/set 透传 manager', async () => {
    registerHubIpc();
    const got = await handlers.get('hub:getViewSettings')!();
    expect(got).toEqual({ allowGroupView: true });
    const set = await handlers.get('hub:setViewSettings')!(null, { allowGroupView: false });
    expect(set).toEqual({ allowGroupView: false });
    expect(manager.hubSetViewSettings).toHaveBeenCalledWith({ allowGroupView: false });
  });

  it('view 六通道 → view.* 方法名与载荷逐项映射（载荷原样透传——hub 定向转发）', async () => {
    registerHubIpc();
    await handlers.get('hub:viewWorkspace')!(null, { targetNodeId: 'n2', workspaceName: 'ws' });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('view.workspace', { targetNodeId: 'n2', workspaceName: 'ws' });
    await handlers.get('hub:viewSessions')!(null, { targetNodeId: 'n2', workspaceName: 'ws', limit: 20 });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('view.sessions', { targetNodeId: 'n2', workspaceName: 'ws', limit: 20 });
    await handlers.get('hub:viewMessages')!(null, { targetNodeId: 'n2', sessionId: 's', fromSeq: 0, limit: 50, workspaceName: 'ws' });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('view.messages', { targetNodeId: 'n2', sessionId: 's', fromSeq: 0, limit: 50, workspaceName: 'ws' });
    await handlers.get('hub:viewTasks')!(null, { targetNodeId: 'n2', workspaceName: 'ws' });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('view.tasks', { targetNodeId: 'n2', workspaceName: 'ws' });
    await handlers.get('hub:viewSubscribe')!(null, { targetNodeId: 'n2', sessionId: 's' });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('view.subscribe', { targetNodeId: 'n2', sessionId: 's' });
    await handlers.get('hub:viewUnsubscribe')!(null, { targetNodeId: 'n2', sessionId: 's' });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('view.unsubscribe', { targetNodeId: 'n2', sessionId: 's' });
    expect(manager.hubRequest).toHaveBeenCalledTimes(6);
  });

  it('view M3.2 两通道：viewWorkspaces/viewFiles 方法名与载荷逐项映射（groupId 可选段原样透传——hub 定向转发）', async () => {
    registerHubIpc();
    await handlers.get('hub:viewWorkspaces')!(null, { targetNodeId: 'n2' });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('view.workspaces', { targetNodeId: 'n2' });
    await handlers.get('hub:viewWorkspaces')!(null, { targetNodeId: 'n2', groupId: 'g1' });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('view.workspaces', { targetNodeId: 'n2', groupId: 'g1' });

    await handlers.get('hub:viewFiles')!(null, { targetNodeId: 'n2', workspaceName: 'ws', op: 'list' });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('view.files', { targetNodeId: 'n2', workspaceName: 'ws', op: 'list' });
    await handlers.get('hub:viewFiles')!(null, { targetNodeId: 'n2', workspaceName: 'ws', op: 'read', path: 'docs/a.txt', groupId: 'g1' });
    expect(manager.hubRequest).toHaveBeenLastCalledWith('view.files', { targetNodeId: 'n2', workspaceName: 'ws', op: 'read', path: 'docs/a.txt', groupId: 'g1' });
    expect(manager.hubRequest).toHaveBeenCalledTimes(4);
  });
});

// ── M4.1 错误契约（coded 包裹）───────────────────────────────────────────────
//
// 通道清单锁机制（spec Review Focus #3 裁定）：注册面断言（上方「注册三十九通道」
// toEqual 锁——新增通道不进清单即红）+ 本处 CODED_RPC_CHANNELS 循环锁（清单内
// 通道逐一断言 RpcRemoteError→前缀 / 普通 Error→原样）配对。新增 RPC 通道须同时
// 改两份清单：只进注册锁不进本清单会被 review 拦下；进本清单但实现未包 coded 则
// 本循环红。选择注册面断言而非 grep 验收：机械可执行、随测试套件常跑。
const CODED_RPC_CHANNELS = [
  ...GROUP_CHANNELS,
  'hub:mirrorWorkspace',
  'hub:taskList', 'hub:taskDelegate', 'hub:taskCancel', 'hub:taskAnswer',
  'hub:viewWorkspace', 'hub:viewSessions', 'hub:viewMessages', 'hub:viewTasks',
  'hub:viewSubscribe', 'hub:viewUnsubscribe', 'hub:viewWorkspaces', 'hub:viewFiles',
  'hub:submitRoutedTask', 'hub:retryDispatch',
] as const;

/** 各通道最小可触发调用（载荷形状与正式接线契约一致） */
function invokeChannel(channel: string): Promise<unknown> {
  const h = handlers.get(channel)!;
  switch (channel) {
    case 'hub:groupList':
      return h(null) as Promise<unknown>;
    case 'hub:groupCreate':
      return h(null, { groupName: 'g' }) as Promise<unknown>;
    case 'hub:groupInvite':
    case 'hub:groupLeave':
      return h(null, { groupId: 'g1' }) as Promise<unknown>;
    case 'hub:groupJoin':
      return h(null, { inviteCode: 'c1' }) as Promise<unknown>;
    case 'hub:groupTransfer':
      return h(null, { groupId: 'g1', toNodeId: 'n2' }) as Promise<unknown>;
    case 'hub:mirrorWorkspace':
      return h(null, { groupId: 'g1', targetNodeId: 'n2', workspaceName: 'ws', snapshotId: 'snap-1' }) as Promise<unknown>;
    case 'hub:taskList':
      return h(null, {}) as Promise<unknown>;
    case 'hub:taskDelegate':
      return h(null, { groupId: 'g1', targetNodeId: 'n2', workspaceName: 'ws', title: 't', prompt: 'p' }) as Promise<unknown>;
    case 'hub:taskCancel':
    case 'hub:taskAnswer':
      return h(null, { taskId: 'tk-1', decision: 'approve' }) as Promise<unknown>;
    case 'hub:viewWorkspace':
    case 'hub:viewTasks':
      return h(null, { targetNodeId: 'n2', workspaceName: 'ws' }) as Promise<unknown>;
    case 'hub:viewSessions':
      return h(null, { targetNodeId: 'n2', workspaceName: 'ws', limit: 20 }) as Promise<unknown>;
    case 'hub:viewMessages':
      return h(null, { targetNodeId: 'n2', sessionId: 's1', fromSeq: 0, limit: 50 }) as Promise<unknown>;
    case 'hub:viewSubscribe':
    case 'hub:viewUnsubscribe':
      return h(null, { targetNodeId: 'n2', sessionId: 's1' }) as Promise<unknown>;
    case 'hub:viewWorkspaces':
      return h(null, { targetNodeId: 'n2' }) as Promise<unknown>;
    case 'hub:viewFiles':
      return h(null, { targetNodeId: 'n2', workspaceName: 'ws', op: 'list' }) as Promise<unknown>;
    case 'hub:submitRoutedTask':
      return h(null, { workspaceId: 'ws-9', workspaceName: 'ws', title: 't', routing: { mode: 'group', groupId: 'g1' } }) as Promise<unknown>;
    case 'hub:retryDispatch': {
      // pending 外派行（group 路由）——resolveTarget 链经 listGroups 上抛 hub 错误
      vi.mocked(getTask).mockReturnValueOnce(
        mkTaskRow({ id: 'T-100', title: 't', workspaceId: 'ws-9', routing: { mode: 'group', groupId: 'g1' } }),
      );
      vi.mocked(listWorkspaces).mockReturnValueOnce([mkWorkspace('ws-9', 'ws')]);
      return h(null, { taskId: 'T-100' }) as Promise<unknown>;
    }
    default:
      throw new Error(`CODED_RPC_CHANNELS 出现未映射通道: ${channel}`);
  }
}

/** workspace/crud.ts Workspace 最小行（retryDispatch 的 workspaceNameOf 分支） */
function mkWorkspace(id: string, name: string): Workspace {
  return {
    id, name, description: '', directoryPath: '/d/ws', gitInitialized: false,
    createdAt: '2026-10-29T00:00:00Z', ownerId: 'owner', iconEmoji: '',
    defaultAgentInstanceId: null,
  };
}

/** delegation-sync.test.ts mkRow 同款（通道锁 retryDispatch 分支所需的最小 TaskRow） */
function mkTaskRow(partial: Partial<TaskRow> & Pick<TaskRow, 'id' | 'title'>): TaskRow {
  return {
    workspaceId: 'ws-1', description: '', status: 'pending',
    sourceSessionId: null, sourceMessageId: null, creatorUserId: 'owner',
    executionSessionId: null, assigneeAgentId: null, targetTeamId: null,
    targetSessionId: null, recurrenceParentId: null, priority: 0,
    scheduledAt: null, recurrenceRule: null, deadlineAt: null,
    queuePosition: null, runtimeInstanceId: null, estimatedTokens: null,
    actualTokens: null, toolCallsUsed: 0, errorMessage: null,
    createdAt: 1000, updatedAt: 1000, startedAt: null, completedAt: null,
    groupId: null, pinnedAt: null, archivedAt: null,
    routing: { mode: 'local' }, delegationId: null, parentTaskId: null,
    ...partial,
  };
}

describe('hub IPC coded 错误契约（M4.1——RpcRemoteError code 编入 `[code] 原文` 前缀）', () => {
  it('通道清单锁：全部 RPC 承载通道 RpcRemoteError → 前缀 rejection（漏迁即红）', async () => {
    registerHubIpc();
    for (const channel of CODED_RPC_CHANNELS) {
      vi.mocked(manager.hubRequest).mockRejectedValueOnce(new RpcRemoteError('node_offline', '目标节点不在线'));
      await expect(invokeChannel(channel), `${channel} 未走 coded`).rejects.toThrow('[node_offline] 目标节点不在线');
    }
  });

  it('coded 双路径：普通 Error 不加前缀原样抛（人话链路零变化）', async () => {
    registerHubIpc();
    for (const channel of CODED_RPC_CHANNELS) {
      vi.mocked(manager.hubRequest).mockRejectedValueOnce(new Error('hub 未连接，请稍后重试'));
      await expect(invokeChannel(channel), `${channel} 意外加了前缀`).rejects.toThrow('hub 未连接，请稍后重试');
    }
  });

  it('routingPrecheck 边界：hub 错误在预检内降级空组清单（不抛——预检不可炸弹窗），不适用前缀断言', async () => {
    registerHubIpc();
    vi.mocked(manager.hubRequest).mockRejectedValueOnce(new RpcRemoteError('unauthorized', '凭证已失效'));
    const out = await handlers.get('hub:routingPrecheck')!(null, { workspaceName: 'ws' });
    expect(out).toEqual({ mirrored: false, groups: [] });
  });

  it('双侧 fixture 等值锁（renderer RPC_ERROR_ROUNDTRIP_FIXTURES 单源）：coded 编码 → parseRpcErrorCode 解码逐字段往返', async () => {
    registerHubIpc();
    for (const { code, message } of RPC_ERROR_ROUNDTRIP_FIXTURES) {
      vi.mocked(manager.hubRequest).mockRejectedValueOnce(new RpcRemoteError(code, message));
      await expect(handlers.get('hub:taskAnswer')!(null, { taskId: 'tk-fx', decision: 'approve' }))
        .rejects.toThrow(`[${code}] ${message}`);
      expect(parseRpcErrorCode(new Error(`[${code}] ${message}`))).toEqual({ code, message });
    }
  });
});
