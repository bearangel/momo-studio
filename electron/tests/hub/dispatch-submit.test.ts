// 路由提交链契约锁（M2.1 T8）——submitRoutedTask / routingPrecheck。
// 纯注入：ports 即进程/网络边界（hub RPC / 本地 DB），全部 vi.fn() fake；
// 核心编排（校验→组装 DispatchInput→pickWorker→落库→委派→回写）为被测真函数。
// 口径锁：
//   - runningCount = 该节点活跃委派数（pending|running|interrupted 计入；终态与 cancelled 不计）
//   - mirroredBy  = 登记表按工作空间名过滤（跨组——镜像真相在节点级，RM-M21-7）
//   - 无候选 / 委派发送失败 → 行照落 pending、routing 保留、delegationId 空（RM-M21-5 手动重试）
//   - permissionTier 缺省 'confirm' 随委派载荷（T10 消费，协议 1.2.0 向后兼容多字段）
import { describe, expect, it, vi } from 'vitest';
import {
  routingPrecheck,
  submitRoutedTask,
  type DelegationTaskBrief,
  type SubmitRoutedTaskInput,
} from '../../src/main/hub/dispatch-submit';
import type { TaskRouting } from '../../src/main/hub/task-routing';
import type { TaskRow } from '../../src/main/storage/tasks/repo';

// ── fake ports 工厂（每个用例可覆盖任意端口） ─────────────────────────────

function makeRow(partial: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'T-001',
    workspaceId: 'ws1',
    title: '任务',
    description: '',
    status: 'pending',
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'owner',
    executionSessionId: null,
    assigneeAgentId: null,
    targetTeamId: null,
    targetSessionId: null,
    recurrenceParentId: null,
    priority: 0,
    scheduledAt: null,
    recurrenceRule: null,
    deadlineAt: null,
    queuePosition: null,
    runtimeInstanceId: null,
    estimatedTokens: null,
    actualTokens: null,
    toolCallsUsed: 0,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: null,
    completedAt: null,
    groupId: null,
    pinnedAt: null,
    archivedAt: null,
    routing: { mode: 'group', groupId: 'g1' },
    delegationId: null,
    ...partial,
  };
}

interface PortOverrides {
  groups?: Array<{
    groupId: string;
    groupName: string;
    members: Array<{ nodeId: string; name: string; online: boolean }>;
  }>;
  delegations?: Array<{ taskId: string; targetNodeId: string; status: string }>;
  registry?: Array<{ groupId: string; targetNodeId: string; workspaceName: string }>;
  delegateResult?: Promise<{ taskId: string }>;
  delegateError?: Error;
}

// 返回类型刻意不注解：保留 vi.fn() 的 Mock 推断（.mock/.mockRejectedValue 可达），
// 实参处直接传给 submitRoutedTask（Mock 可赋值性覆盖端口函数形状）
function makePorts(overrides: PortOverrides = {}) {
  return {
    listGroups: vi.fn().mockResolvedValue(overrides.groups ?? []),
    listDelegations: vi.fn().mockResolvedValue(overrides.delegations ?? []),
    listMirrorRegistry: vi
      .fn()
      .mockReturnValue((overrides.registry ?? []).filter((r) => r.workspaceName === 'ws-main')),
    delegate: overrides.delegateError
      ? vi.fn().mockRejectedValue(overrides.delegateError)
      : vi.fn().mockResolvedValue(
          overrides.delegateResult ?? Promise.resolve({ taskId: 'dl-100' }),
        ),
    createLocalTask: vi.fn().mockImplementation((input: SubmitRoutedTaskInput) =>
      makeRow({ id: 'T-loc', status: 'draft', routing: input.routing as TaskRouting }),
    ),
    createRemoteTask: vi.fn().mockImplementation((input: { routing: TaskRouting }) =>
      makeRow({ id: 'T-rem', status: 'pending', routing: input.routing }),
    ),
    updateDelegationLink: vi.fn(),
  };
}

/** 标准组：g1（node-a / node-b 在线，node-off 离线）；空间 ws-main 已镜像 node-a/node-b。 */
function standardGroup(): PortOverrides['groups'] {
  return [
    {
      groupId: 'g1',
      groupName: 'dev-team',
      members: [
        { nodeId: 'node-a', name: 'office-mac', online: true },
        { nodeId: 'node-b', name: 'lab-node', online: true },
        { nodeId: 'node-off', name: 'sleepy', online: false },
      ],
    },
  ];
}

function standardRegistry(): PortOverrides['registry'] {
  return [
    { groupId: 'g1', targetNodeId: 'node-a', workspaceName: 'ws-main' },
    { groupId: 'g1', targetNodeId: 'node-b', workspaceName: 'ws-main' },
    { groupId: 'g1', targetNodeId: 'node-off', workspaceName: 'ws-main' },
    { groupId: 'g1', targetNodeId: 'node-x', workspaceName: 'other-ws' }, // 异空间：不入选
  ];
}

function baseInput(routing: TaskRouting): SubmitRoutedTaskInput {
  return {
    workspaceId: 'ws1',
    workspaceName: 'ws-main',
    title: '排查 WebSocket 断连',
    description: '分析 gateway 日志定位 1006 根因',
    groupId: 'G-001',
    routing,
  };
}

// ── submitRoutedTask ───────────────────────────────────────────────────────

describe('submitRoutedTask — local 模式', () => {
  it('1. 委托既有本地创建（draft 语义原样透传）；零 hub RPC、零落库扩展', async () => {
    const ports = makePorts({ groups: standardGroup(), registry: standardRegistry() });
    const result = await submitRoutedTask(baseInput({ mode: 'local' }), ports);

    expect(ports.createLocalTask).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws1',
        title: '排查 WebSocket 断连',
        description: '分析 gateway 日志定位 1006 根因',
        groupId: 'G-001',
        routing: { mode: 'local' },
      }),
    );
    expect(ports.createRemoteTask).not.toHaveBeenCalled();
    expect(ports.listGroups).not.toHaveBeenCalled();
    expect(ports.listDelegations).not.toHaveBeenCalled();
    expect(ports.listMirrorRegistry).not.toHaveBeenCalled();
    expect(ports.delegate).not.toHaveBeenCalled();
    expect(ports.updateDelegationLink).not.toHaveBeenCalled();
    expect(result.dispatched).toBe(false);
    expect(result.nodeId).toBeNull();
    expect(result.task.id).toBe('T-loc');
  });
});

describe('submitRoutedTask — group 模式', () => {
  it('2. 有候选：行先落 pending → 委派载荷（title/prompt/permissionTier 默认 confirm）→ 回写 delegation_id', async () => {
    // node-a 活跃 1（running）；node-b 活跃 2（pending+running）→ least-busy 选 node-a
    const ports = makePorts({
      groups: standardGroup(),
      registry: standardRegistry(),
      delegations: [
        { taskId: 'd1', targetNodeId: 'node-a', status: 'running' },
        { taskId: 'd2', targetNodeId: 'node-a', status: 'done' }, // 终态不计
        { taskId: 'd3', targetNodeId: 'node-b', status: 'pending' },
        { taskId: 'd4', targetNodeId: 'node-b', status: 'running' },
        { taskId: 'd5', targetNodeId: 'node-b', status: 'cancelled' }, // 取消不计
      ],
    });
    const result = await submitRoutedTask(baseInput({ mode: 'group', groupId: 'g1' }), ports);

    // 落库：pending + routing 保留 + delegationId 先空
    expect(ports.createRemoteTask).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', routing: { mode: 'group', groupId: 'g1' } }),
    );
    // 委派载荷：prompt=任务书、permissionTier 缺省 confirm、目标=least-busy
    expect(ports.delegate).toHaveBeenCalledTimes(1);
    const brief = ports.delegate.mock.calls[0]?.[0] as DelegationTaskBrief;
    expect(brief).toEqual({
      groupId: 'g1',
      targetNodeId: 'node-a',
      workspaceName: 'ws-main',
      task: { title: '排查 WebSocket 断连', prompt: '分析 gateway 日志定位 1006 根因', permissionTier: 'confirm' },
    });
    // 回写
    expect(ports.updateDelegationLink).toHaveBeenCalledWith('T-rem', 'dl-100');
    expect(result.dispatched).toBe(true);
    expect(result.nodeId).toBe('node-a');
  });

  it('3. runningCount 口径：interrupted 计入活跃；全离线成员的组无候选 → 行落 pending、routing 保留、不派发', async () => {
    const ports = makePorts({
      groups: [
        {
          groupId: 'g1',
          groupName: 'dev-team',
          members: [
            { nodeId: 'node-a', name: 'office-mac', online: false },
            { nodeId: 'node-b', name: 'lab-node', online: false },
          ],
        },
      ],
      registry: standardRegistry(),
      // node-a 唯一 interrupted（活跃）——但离线，永不入选（Review Focus #2 精神）
      delegations: [{ taskId: 'd1', targetNodeId: 'node-a', status: 'interrupted' }],
    });
    const result = await submitRoutedTask(baseInput({ mode: 'group', groupId: 'g1' }), ports);

    expect(ports.delegate).not.toHaveBeenCalled();
    expect(ports.updateDelegationLink).not.toHaveBeenCalled();
    expect(ports.createRemoteTask).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', routing: { mode: 'group', groupId: 'g1' } }),
    );
    expect(result.dispatched).toBe(false);
    expect(result.nodeId).toBeNull();
  });

  it('4. 未镜像本空间的在线节点不入候选：全员未镜像 → 留待处理', async () => {
    const ports = makePorts({
      groups: standardGroup(),
      registry: [
        // ws-main 零登记（登记行全在异空间）
        { groupId: 'g1', targetNodeId: 'node-a', workspaceName: 'other-ws' },
      ],
    });
    const result = await submitRoutedTask(baseInput({ mode: 'group', groupId: 'g1' }), ports);
    expect(ports.delegate).not.toHaveBeenCalled();
    expect(result.dispatched).toBe(false);
    expect(result.task.status).toBe('pending');
  });

  it('5. 委派发送失败（如瞬断 node_offline）→ 不抛：行保留 pending 待手动重试（RM-M21-5）', async () => {
    const ports = makePorts({
      groups: standardGroup(),
      registry: standardRegistry(),
      delegateError: new Error('node_offline: 目标节点刚下线'),
    });
    const result = await submitRoutedTask(baseInput({ mode: 'group', groupId: 'g1' }), ports);
    expect(ports.createRemoteTask).toHaveBeenCalled();
    expect(ports.updateDelegationLink).not.toHaveBeenCalled();
    expect(result.dispatched).toBe(false);
    expect(result.task.delegationId).toBeNull();
  });

  it('6. 组不存在/已退 → 人话拒绝，零落库零派发', async () => {
    const ports = makePorts({ groups: [], registry: standardRegistry() });
    await expect(submitRoutedTask(baseInput({ mode: 'group', groupId: 'gX' }), ports)).rejects.toThrow(
      /工作组 gX 不存在/,
    );
    expect(ports.createRemoteTask).not.toHaveBeenCalled();
    expect(ports.delegate).not.toHaveBeenCalled();
  });

  it('7. permissionTier 显式 readonly → 随载荷透传（T10 消费面）', async () => {
    const ports = makePorts({ groups: standardGroup(), registry: standardRegistry() });
    await submitRoutedTask(
      { ...baseInput({ mode: 'group', groupId: 'g1' }), permissionTier: 'readonly' },
      ports,
    );
    const brief = ports.delegate.mock.calls[0]?.[0] as DelegationTaskBrief;
    expect(brief.task.permissionTier).toBe('readonly');
  });

  // T10b（pin v0.1.3）：studio 测试不引 hub 运行时，本用例锁载荷构造侧——task 恰为
  // 协议 DelegationTask 白名单三键（title/prompt/permissionTier），零杂散字段；hub 侧
  // parse 透传与非法值剥除由 momo-hub delegations.test.ts「permissionTier 合法三值
  // （readonly/sandbox/confirm）均透传」与「permissionTier 非法值丢弃不抛」两用例锁死
  it('7b. 委派载荷 task 形状锁：恰为协议白名单三键（readonly 档在场，无杂散字段）', async () => {
    const ports = makePorts({ groups: standardGroup(), registry: standardRegistry() });
    await submitRoutedTask(
      { ...baseInput({ mode: 'group', groupId: 'g1' }), permissionTier: 'readonly' },
      ports,
    );
    const brief = ports.delegate.mock.calls[0]?.[0] as DelegationTaskBrief;
    expect(Object.keys(brief.task).sort()).toEqual(['permissionTier', 'prompt', 'title']);
    expect(brief.task.permissionTier).toBe('readonly');
  });
});

describe('submitRoutedTask — node 模式', () => {
  it('8. 锁定直发指定成员：不 least-busy（更空闲的 node-b 在场仍发 node-a）', async () => {
    const ports = makePorts({
      groups: standardGroup(),
      registry: standardRegistry(),
      delegations: [
        { taskId: 'd1', targetNodeId: 'node-a', status: 'running' }, // node-a 更忙
      ],
    });
    const result = await submitRoutedTask(
      baseInput({ mode: 'node', groupId: 'g1', targetNodeId: 'node-a' }),
      ports,
    );

    expect(ports.listDelegations).not.toHaveBeenCalled(); // 直发不需要负载账本
    const brief = ports.delegate.mock.calls[0]?.[0] as DelegationTaskBrief;
    expect(brief.targetNodeId).toBe('node-a');
    expect(ports.createRemoteTask).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        routing: { mode: 'node', groupId: 'g1', targetNodeId: 'node-a' },
      }),
    );
    expect(ports.updateDelegationLink).toHaveBeenCalledWith('T-rem', 'dl-100');
    expect(result.dispatched).toBe(true);
    expect(result.nodeId).toBe('node-a');
  });

  it('9. 目标不是组成员 → 人话拒绝，零落库', async () => {
    const ports = makePorts({ groups: standardGroup(), registry: standardRegistry() });
    await expect(
      submitRoutedTask(baseInput({ mode: 'node', groupId: 'g1', targetNodeId: 'node-z' }), ports),
    ).rejects.toThrow(/node-z .*g1.*成员/);
    expect(ports.createRemoteTask).not.toHaveBeenCalled();
    expect(ports.delegate).not.toHaveBeenCalled();
  });
});

describe('submitRoutedTask — 入参校验', () => {
  it('10. 异形 routing 人话拒绝（不静默降级本机——与 task.create 同哲学）', async () => {
    const ports = makePorts();
    await expect(
      submitRoutedTask(baseInput({ mode: 'wrong' } as unknown as TaskRouting), ports),
    ).rejects.toThrow(/routing 形状非法/);
    expect(ports.createLocalTask).not.toHaveBeenCalled();
  });
});

// ── routingPrecheck ────────────────────────────────────────────────────────

describe('routingPrecheck — 预检概要', () => {
  it('11. 组概要：onlineCount / mirroredCount（本空间口径）/ 成员 mirrored 徽标', async () => {
    const ports = makePorts({
      groups: standardGroup(),
      registry: standardRegistry(), // ws-main：node-a / node-b / node-off；node-x 属异空间
    });
    const result = await routingPrecheck('ws-main', ports);

    expect(result.mirrored).toBe(true);
    expect(result.groups).toHaveLength(1);
    const g = result.groups[0]!;
    expect(g.groupName).toBe('dev-team');
    expect(g.onlineCount).toBe(2); // node-a + node-b
    expect(g.mirroredCount).toBe(3); // a/b/off（离线也算已镜像——口径独立）
    const byId = new Map(g.members.map((m) => [m.nodeId, m]));
    expect(byId.get('node-a')).toMatchObject({ online: true, mirrored: true });
    expect(byId.get('node-off')).toMatchObject({ online: false, mirrored: true });
    expect(byId.get('node-x')).toBeUndefined(); // 非成员不入概要
  });

  it('12. 本空间零登记 → mirrored=false（守门信号；组照列，mirroredCount 全 0）', async () => {
    const ports = makePorts({
      groups: standardGroup(),
      registry: [{ groupId: 'g1', targetNodeId: 'node-a', workspaceName: 'other-ws' }],
    });
    const result = await routingPrecheck('ws-main', ports);
    expect(result.mirrored).toBe(false);
    expect(result.groups[0]!.mirroredCount).toBe(0);
    expect(result.groups[0]!.members.every((m) => !m.mirrored)).toBe(true);
  });

  it('13. hub 不可达（listGroups 拒绝）→ groups 空数组降级，不抛（弹窗不因预检炸）', async () => {
    const ports = makePorts({ registry: standardRegistry() });
    ports.listGroups.mockRejectedValue(new Error('websocket closed'));
    const result = await routingPrecheck('ws-main', ports);
    expect(result.groups).toEqual([]);
    expect(result.mirrored).toBe(true); // 本地登记表仍可信
  });
});
