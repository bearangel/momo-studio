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
  hubGetStatus: vi.fn(() => ({ configured: false, state: 'disconnected', hubUrl: null, nodeName: null, nodeId: null, lastError: null })),
  hubConfigure: vi.fn(async (input: { hubUrl: string }) => ({ configured: true, state: 'connecting', hubUrl: input.hubUrl, nodeName: 'a', nodeId: null, lastError: null })),
  hubEnroll: vi.fn(async () => ({ configured: true, state: 'connecting', hubUrl: 'http://h', nodeName: 'a', nodeId: 'n1', lastError: null })),
  hubForget: vi.fn(async () => undefined),
  replayPresenceSeed: vi.fn(),
  hubRequest: vi.fn(async () => ({})),
  hubGetDelegationSettings: vi.fn(() => ({ acceptTasks: true, maxConcurrent: 2, hitlTimeoutMinutes: 15 })),
  hubSetDelegationSettings: vi.fn(async (input: { acceptTasks: boolean; maxConcurrent: number; hitlTimeoutMinutes: number }) => input),
  hubGetViewSettings: vi.fn(() => ({ allowGroupView: true })),
  hubSetViewSettings: vi.fn(async (input: { allowGroupView: boolean }) => input),
  hubDelegationBoard: vi.fn(() => ({ progress: {}, received: [] })),
  hubMarkDelegationCancelled: vi.fn(),
}));

// publishToHub 只锁接线（透传入参）——打包/上传矩阵在 publish.test.ts
vi.mock('../../src/main/hub/publish', () => ({
  publishToHub: vi.fn(async (input: { type: string; ref: string }) => ({ slug: input.ref, version: '1.0.0', checksum: 'c', sizeBytes: 1 })),
}));

import { registerHubIpc } from '../../src/main/hub/ipc.handlers';
import * as manager from '../../src/main/hub/index';
import { publishToHub } from '../../src/main/hub/publish';

const GROUP_CHANNELS = ['hub:groupCreate', 'hub:groupInvite', 'hub:groupJoin', 'hub:groupLeave', 'hub:groupList', 'hub:groupTransfer'];
const MIRROR_CHANNELS = ['hub:snapshotBuildUpload', 'hub:mirrorWorkspace', 'hub:mirrorRegistry'];
const DELEGATION_CHANNELS = ['hub:getDelegationSettings', 'hub:setDelegationSettings'];
const TASK_CHANNELS = ['hub:taskList', 'hub:taskDelegate', 'hub:taskCancel'];
const ROUTING_CHANNELS = ['hub:submitRoutedTask', 'hub:routingPrecheck'];
const BOARD_CHANNELS = ['hub:delegationBoard', 'hub:retryDispatch'];
const VIEW_CHANNELS = [
  'hub:getViewSettings', 'hub:setViewSettings',
  'hub:viewWorkspace', 'hub:viewSessions', 'hub:viewMessages', 'hub:viewTasks',
  'hub:viewSubscribe', 'hub:viewUnsubscribe',
];

beforeEach(() => { handlers.clear(); vi.clearAllMocks(); });

describe('hub IPC 接线', () => {
  it('注册三十一通道（M2.1 T6 增镜像登记查询、T8 增路由提交两通道、T9 增看板投影两通道）；getStatus 透传 manager', async () => {
    registerHubIpc();
    expect([...handlers.keys()].sort()).toEqual([
      ...GROUP_CHANNELS,
      ...MIRROR_CHANNELS,
      ...DELEGATION_CHANNELS,
      ...TASK_CHANNELS,
      ...ROUTING_CHANNELS,
      ...BOARD_CHANNELS,
      ...VIEW_CHANNELS,
      'hub:configure', 'hub:enroll', 'hub:forget', 'hub:getStatus', 'hub:publishResource',
    ].sort());
    expect(await handlers.get('hub:getStatus')!()).toEqual(await manager.hubGetStatus());
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
});
