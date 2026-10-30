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
    parentTaskId: null,
    ...partial,
  };
}

interface PortOverrides {
  groups?: Array<{
    groupId: string;
    groupName: string;
    members: Array<{ nodeId: string; name: string; online: boolean; protoVer?: string }>;
  }>;
  delegations?: Array<{ taskId: string; targetNodeId: string; status: string }>;
  registry?: Array<{ groupId: string; targetNodeId: string; workspaceName: string }>;
  delegateResult?: Promise<{ taskId: string }>;
  delegateError?: Error;
  /** M4.3 派发闸数据源 fake：taskId → 未完成依赖 id 列表（缺省恒空 = 不阻塞） */
  blockedBy?: Record<string, string[]>;
  /** M5.3 团队快照 fake：teamId → 快照；缺省 null（团队不存在） */
  teamSnapshot?: { name: string; members: Array<{ agentName: string; isLeader: boolean }> };
}

// 返回类型刻意不注解：保留 vi.fn() 的 Mock 推断（.mock/.mockRejectedValue 可达），
// 实参处直接传给 submitRoutedTask（Mock 可赋值性覆盖端口函数形状）
function makePorts(overrides: PortOverrides = {}) {
  return {
    listGroups: vi.fn().mockResolvedValue(overrides.groups ?? []),
    getTeamSnapshot: vi
      .fn()
      .mockImplementation((_workspaceId: string, teamId: string) =>
        teamId === 'team-1' ? (overrides.teamSnapshot ?? null) : null,
      ),
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
    deriveBlockedBy: vi.fn().mockImplementation((taskId: string) => overrides.blockedBy?.[taskId] ?? []),
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
    // 回写：delegation_id + 已解析目标 routing（D5——group 变体补 targetNodeId）
    expect(ports.updateDelegationLink).toHaveBeenCalledWith('T-rem', 'dl-100', {
      mode: 'group',
      groupId: 'g1',
      targetNodeId: 'node-a',
    });
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
    expect(ports.updateDelegationLink).toHaveBeenCalledWith('T-rem', 'dl-100', {
      mode: 'node',
      groupId: 'g1',
      targetNodeId: 'node-a',
    });
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

// ── M4.3：外派行 `::` 建链 + 派发闸（spec 2026-10-29 §2.3）──────────────────
describe('submitRoutedTask — M4.3 依赖建链与派发闸', () => {
  it('14. dependsOn 随行建链：createRemoteTask 携带 dependsOn（存在/环检测在 relations 单源）', async () => {
    const ports = makePorts({ groups: standardGroup(), registry: standardRegistry() });
    await submitRoutedTask(
      { ...baseInput({ mode: 'group', groupId: 'g1' }), dependsOn: ['T-001', 'T-002'] },
      ports,
    );
    expect(ports.createRemoteTask).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', dependsOn: ['T-001', 'T-002'] }),
    );
  });

  it('15. 派发闸 blocked：建链后存在未完成依赖 → 人话拒绝（与 retryDispatch 闸逐字同源），零委派零回写', async () => {
    const ports = makePorts({
      groups: standardGroup(),
      registry: standardRegistry(),
      blockedBy: { 'T-rem': ['T-001', 'T-009'] },
    });
    await expect(
      submitRoutedTask(
        { ...baseInput({ mode: 'group', groupId: 'g1' }), dependsOn: ['T-001', 'T-009'] },
        ports,
      ),
    ).rejects.toThrow('任务存在未完成依赖（T-001、T-009），依赖完成前不可派发');
    // 行保留（建链账不回滚——重试入口在待派发卡），但不委派
    expect(ports.createRemoteTask).toHaveBeenCalledTimes(1);
    expect(ports.delegate).not.toHaveBeenCalled();
    expect(ports.updateDelegationLink).not.toHaveBeenCalled();
  });

  it('16. 派发闸放行：依赖全部完成（派生空）→ 正常派发，brief.task 透传 dependsOn（协议 1.7.0）', async () => {
    const ports = makePorts({ groups: standardGroup(), registry: standardRegistry() });
    const result = await submitRoutedTask(
      { ...baseInput({ mode: 'group', groupId: 'g1' }), dependsOn: ['T-001'] },
      ports,
    );
    expect(ports.delegate).toHaveBeenCalledTimes(1);
    const brief = ports.delegate.mock.calls[0]?.[0] as DelegationTaskBrief;
    expect(brief.task.dependsOn).toEqual(['T-001']);
    expect(result.dispatched).toBe(true);
  });

  it('17. dependsOn 空数组（行内 `::` 解析容错）→ createRemoteTask / brief 均不带键（1.6 载荷零变化）', async () => {
    const ports = makePorts({ groups: standardGroup(), registry: standardRegistry() });
    await submitRoutedTask(
      { ...baseInput({ mode: 'group', groupId: 'g1' }), dependsOn: [] },
      ports,
    );
    const createArg = ports.createRemoteTask.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('dependsOn' in createArg).toBe(false);
    const brief = ports.delegate.mock.calls[0]?.[0] as DelegationTaskBrief;
    expect('dependsOn' in brief.task).toBe(false);
  });

  it('18. 闸序：blocked 检查在落库之后（行保留待处理）、无候选返回之前——拒绝对外零委派', async () => {
    // 无候选 + blocked 并存：闸先拒（人话优先于「留待处理」静默语义）
    const ports = makePorts({
      groups: [
        {
          groupId: 'g1',
          groupName: 'dev-team',
          members: [{ nodeId: 'node-off', name: 'sleepy', online: false }],
        },
      ],
      registry: standardRegistry(),
      blockedBy: { 'T-rem': ['T-001'] },
    });
    await expect(
      submitRoutedTask(
        { ...baseInput({ mode: 'group', groupId: 'g1' }), dependsOn: ['T-001'] },
        ports,
      ),
    ).rejects.toThrow('任务存在未完成依赖（T-001），依赖完成前不可派发');
  });
});

// ── submitRoutedTask — M5.3 团队派发（teamId 展开 + 版本门） ─────────────────

/** 新协议组：node-a/node-b 在线且 1.9.0+；node-old 在线但 1.8.0；node-silent 在线不带 protoVer（视为旧） */
function protoGroup() {
  return [
    {
      groupId: 'g1',
      groupName: 'dev-team',
      members: [
        { nodeId: 'node-a', name: 'office-mac', online: true, protoVer: '1.9.0' },
        { nodeId: 'node-b', name: 'lab-node', online: true, protoVer: '1.10.2' },
        { nodeId: 'node-old', name: 'legacy-box', online: true, protoVer: '1.8.0' },
        { nodeId: 'node-silent', name: 'quiet-box', online: true },
        { nodeId: 'node-off', name: 'sleepy', online: false },
      ],
    },
  ];
}

function protoRegistry() {
  return ['node-a', 'node-b', 'node-old', 'node-silent', 'node-off'].map((nodeId) => ({
    groupId: 'g1',
    targetNodeId: nodeId,
    workspaceName: 'ws-main',
  }));
}

const teamSnap = {
  name: '攻坚组',
  members: [
    { agentName: 'PM', isLeader: true },
    { agentName: 'Coder', isLeader: false },
  ],
};

describe('submitRoutedTask — M5.3 团队派发', () => {
  it('teamId 展开：payload 带 team 段（name=agentName + leader 标记）且不带 agentSlug 键；落库/回写照常', async () => {
    const ports = makePorts({
      groups: protoGroup(),
      registry: protoRegistry(),
      teamSnapshot: teamSnap,
    });
    const result = await submitRoutedTask(
      { ...baseInput({ mode: 'group', groupId: 'g1' }), teamId: 'team-1' },
      ports,
    );

    expect(result.dispatched).toBe(true);
    const brief = (ports.delegate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as DelegationTaskBrief;
    expect(brief.task.team).toEqual({
      members: [
        { name: 'PM', isLeader: true },
        { name: 'Coder', isLeader: false },
      ],
    });
    // agentSlug 互斥：team 在场时载荷不得带 agentSlug 键
    expect('agentSlug' in brief.task).toBe(false);
    expect(ports.getTeamSnapshot).toHaveBeenCalledWith('ws1', 'team-1');
  });

  it('无 teamId：载荷零变化（不带 team 键——1.8 载荷回归锁）', async () => {
    const ports = makePorts({ groups: protoGroup(), registry: protoRegistry() });
    await submitRoutedTask(baseInput({ mode: 'group', groupId: 'g1' }), ports);
    const brief = (ports.delegate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as DelegationTaskBrief;
    expect('team' in brief.task).toBe(false);
    expect(ports.getTeamSnapshot).not.toHaveBeenCalled();
  });

  it('团队不存在 / 形态非法（单成员、双 leader）→ 提交时人话拒，零落库零派发', async () => {
    const ports = makePorts({ groups: protoGroup(), registry: protoRegistry() });
    await expect(
      submitRoutedTask({ ...baseInput({ mode: 'group', groupId: 'g1' }), teamId: 'team-x' }, ports),
    ).rejects.toThrow('团队不存在或已解散');
    expect(ports.createRemoteTask).not.toHaveBeenCalled();
    expect(ports.delegate).not.toHaveBeenCalled();

    const oneMember = makePorts({
      groups: protoGroup(),
      registry: protoRegistry(),
      teamSnapshot: { name: '独行侠', members: [{ agentName: 'PM', isLeader: true }] },
    });
    await expect(
      submitRoutedTask({ ...baseInput({ mode: 'group', groupId: 'g1' }), teamId: 'team-1' }, oneMember),
    ).rejects.toThrow('形态不满足团队派发');

    const twoLeaders = makePorts({
      groups: protoGroup(),
      registry: protoRegistry(),
      teamSnapshot: {
        name: '双头组',
        members: [
          { agentName: 'PM', isLeader: true },
          { agentName: 'Coder', isLeader: true },
        ],
      },
    });
    await expect(
      submitRoutedTask({ ...baseInput({ mode: 'group', groupId: 'g1' }), teamId: 'team-1' }, twoLeaders),
    ).rejects.toThrow('恰一名 leader');
  });

  it('指定节点协议过旧（1.8.0 / 在线但不带 protoVer）→ 人话拒（含节点名与对方版本），零落库零派发', async () => {
    const ports = makePorts({ groups: protoGroup(), registry: protoRegistry(), teamSnapshot: teamSnap });
    await expect(
      submitRoutedTask(
        { ...baseInput({ mode: 'node', groupId: 'g1', targetNodeId: 'node-old' }), teamId: 'team-1' },
        ports,
      ),
    ).rejects.toThrow('目标节点 legacy-box 版本过旧（协议 1.8.0），不支持团队派发——需对方升级到 v0.5.0+');
    expect(ports.createRemoteTask).not.toHaveBeenCalled();
    expect(ports.delegate).not.toHaveBeenCalled();

    const silent = makePorts({ groups: protoGroup(), registry: protoRegistry(), teamSnapshot: teamSnap });
    await expect(
      submitRoutedTask(
        { ...baseInput({ mode: 'node', groupId: 'g1', targetNodeId: 'node-silent' }), teamId: 'team-1' },
        silent,
      ),
    ).rejects.toThrow('协议 未知');
  });

  it('指定节点离线 → 不走版本闸（无 protoVer 可查，hub 兜底）——直发照常', async () => {
    const ports = makePorts({ groups: protoGroup(), registry: protoRegistry(), teamSnapshot: teamSnap });
    const result = await submitRoutedTask(
      { ...baseInput({ mode: 'node', groupId: 'g1', targetNodeId: 'node-off' }), teamId: 'team-1' },
      ports,
    );
    expect(result.dispatched).toBe(true);
    expect(result.nodeId).toBe('node-off');
  });

  it('指定节点新协议（1.9.0+）→ 放行直发', async () => {
    const ports = makePorts({ groups: protoGroup(), registry: protoRegistry(), teamSnapshot: teamSnap });
    const result = await submitRoutedTask(
      { ...baseInput({ mode: 'node', groupId: 'g1', targetNodeId: 'node-b' }), teamId: 'team-1' },
      ports,
    );
    expect(result.dispatched).toBe(true);
    expect(result.nodeId).toBe('node-b');
  });

  it('组内调度：候选池排除旧协议节点（least-busy 在新节点中选）', async () => {
    // node-a(1.9.0) 活跃 2、node-b(1.10.2) 活跃 0、node-old/node-silent 旧——只可在 a/b 中选 b
    const ports = makePorts({
      groups: protoGroup(),
      registry: protoRegistry(),
      teamSnapshot: teamSnap,
      delegations: [
        { taskId: 'd1', targetNodeId: 'node-a', status: 'running' },
        { taskId: 'd2', targetNodeId: 'node-a', status: 'pending' },
      ],
    });
    const result = await submitRoutedTask(
      { ...baseInput({ mode: 'group', groupId: 'g1' }), teamId: 'team-1' },
      ports,
    );
    expect(result.dispatched).toBe(true);
    expect(result.nodeId).toBe('node-b');
  });

  it('组内调度：候选（在线∧已镜像）全被版本排除 → 拒并列全部落后节点名', async () => {
    const groups = [
      {
        groupId: 'g1',
        groupName: 'dev-team',
        members: [
          { nodeId: 'node-old', name: 'legacy-box', online: true, protoVer: '1.8.0' },
          { nodeId: 'node-silent', name: 'quiet-box', online: true },
        ],
      },
    ];
    const ports = makePorts({
      groups,
      registry: protoRegistry(),
      teamSnapshot: teamSnap,
    });
    await expect(
      submitRoutedTask({ ...baseInput({ mode: 'group', groupId: 'g1' }), teamId: 'team-1' }, ports),
    ).rejects.toThrow('组内候选节点协议均过旧（legacy-box、quiet-box），不支持团队派发——需对方升级到 v0.5.0+');
    expect(ports.createRemoteTask).not.toHaveBeenCalled();
    expect(ports.delegate).not.toHaveBeenCalled();
  });

  it('组内调度：本就无候选（无镜像登记）→ 维持留待处理（不误报版本过旧）', async () => {
    const ports = makePorts({ groups: protoGroup(), registry: [], teamSnapshot: teamSnap });
    const result = await submitRoutedTask(
      { ...baseInput({ mode: 'group', groupId: 'g1' }), teamId: 'team-1' },
      ports,
    );
    expect(result.dispatched).toBe(false);
    expect(result.task.delegationId).toBeNull();
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

  it('14. M5.3 nodeCaps：在线成员 protoVer 派生、离线/未上报不带、跨组同 nodeId 去重', async () => {
    const groups = [
      ...protoGroup(),
      {
        groupId: 'g2',
        groupName: 'ops-team',
        members: [
          { nodeId: 'node-a', name: 'office-mac-别名', online: true, protoVer: '1.9.1' },
          { nodeId: 'node-off', name: 'sleepy', online: false, protoVer: '1.9.0' },
        ],
      },
    ];
    const ports = makePorts({ groups, registry: protoRegistry() });
    const result = await routingPrecheck('ws-main', ports);

    // 在线且带 protoVer 的成员进 nodeCaps；离线（node-off）不带；node-silent 在线
    // 但无 protoVer 不进；node-a 跨组去重（首见保留 g1 的 1.9.0）
    expect(result.nodeCaps).toEqual([
      { nodeId: 'node-a', name: 'office-mac', protoVer: '1.9.0' },
      { nodeId: 'node-b', name: 'lab-node', protoVer: '1.10.2' },
      { nodeId: 'node-old', name: 'legacy-box', protoVer: '1.8.0' },
    ]);
  });
});
