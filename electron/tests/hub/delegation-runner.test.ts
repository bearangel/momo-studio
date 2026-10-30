// 子节点委派执行器契约锁（M2e T10/T11，spec §5.3/§8 RF#5 + MC1 + T9 wire 约定）——
// 端口注入 + 真_kv（settings/store 走 :memory: db，与 config-store 同款纪律）：
// 前置三拒（declined 附因）/ 委派会话建立与账本标记 / 首拍 running 必发先于执行 /
// 进度 500ms 合并批量转发（lastSeq 单调不丢、断线缓冲重连 flush）/ 完成与失败上报 /
// 开关即时生效 / 重连续传（active 复报 / idle 复用会话续跑 / 本地丢失上报）/ 取消三态。
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskReportPayload } from '../../src/main/hub/delegation-wire';
import {
  createDelegationRunner,
  type AssignedTaskEvent,
  type DelegationRunPorts,
  type DelegationTail,
  type TurnTerminal,
} from '../../src/main/hub/delegation-runner';
import { READONLY_PROMPT_PREFIX } from '../../src/main/hub/run-policy';
import {
  __pushReadonlyDeniedForTest,
  __resetInspectStateForTest,
  isReadonlySession,
  markSessionReadonly,
} from '../../src/main/sandbox/write-blocked-emit';
import { createHubDelegationSettingsStore } from '../../src/main/hub/delegation-settings';
import { createHubDelegationStore } from '../../src/main/hub/delegation-store';

// ── 测试骨架 ────────────────────────────────────────────────────────────────

interface CallLog {
  /** 全局顺序日志（tag 化）——首拍 running 必发先于 startTurn 的次序断言用 */
  order: string[];
  createdSessions: Array<{
    workspaceId: string;
    title: string;
    memberInstanceId?: string;
    members?: Array<{ instanceId: string; isLeader: boolean }>;
  }>;
  startedTurns: Array<{ sessionId: string; body: string; mentionedInstanceIds?: string[] }>;
  stoppedSessions: string[];
  reports: Array<{ taskId: string; payload: TaskReportPayload }>;
  resolvedAgents: Array<{ workspaceId: string; agentSlug: string | undefined }>;
  /** M5.3 团队成员按名解析记录（逐名调用序 + 名单） */
  resolvedAgentsByName: Array<{ workspaceId: string; agentName: string }>;
  /** T10 权限档位预配调用记录（调用序锁：createSession → applyRunPolicy → startTurn） */
  appliedPolicies: Array<{ sessionId: string; tier: string }>;
  /** T11 超时 steer 注入记录（调用序锁：applyRunPolicy(readonly) → injectSteer） */
  injectedSteers: Array<{ sessionId: string; body: string }>;
  continuations: number;
}

/** T11 sessionWaiting 端口返回形状（与生产端口契约一致） */
type WaitingState = { waiting: boolean; summary: string } | null;

function makeHarness(overrides?: Partial<DelegationRunPorts>): {
  runner: ReturnType<typeof createDelegationRunner>;
  log: CallLog;
  settings: ReturnType<typeof createHubDelegationSettingsStore>;
  store: ReturnType<typeof createHubDelegationStore>;
  fireTerminal: (sessionId: string, t: TurnTerminal) => void;
  pushTail: (sessionId: string, tail: DelegationTail) => void;
  setReportOnline: (online: boolean) => void;
  setWaiting: (sessionId: string, state: WaitingState) => void;
  setInterrupted: (tasks: Array<{ taskId: string; title: string; workspaceName: string }>) => void;
  setWorkspace: (name: string, id: string) => void;
  setAgent: (slug: string | undefined, instanceId: string) => void;
  setAgentByName: (name: string, instanceId: string) => void;
  setStartTurnFailures: (attemptsWithin: number) => void;
} {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
  const settings = createHubDelegationSettingsStore(db);
  const store = createHubDelegationStore(db);

  const log: CallLog = {
    order: [], createdSessions: [], startedTurns: [], stoppedSessions: [],
    reports: [], resolvedAgents: [], resolvedAgentsByName: [], appliedPolicies: [], injectedSteers: [], continuations: 0,
  };

  // 可变测试台状态
  const workspaces = new Map<string, string>();           // name → id
  const agents = new Map<string, string>();               // slug|'__default__' → instanceId
  const agentsByName = new Map<string, string>();         // M5.3：agentName → instanceId
  const tailQueue = new Map<string, DelegationTail[]>();  // sessionId → 待消费尾部增量
  const watchers = new Map<string, (t: TurnTerminal) => void>();
  const waitingStates = new Map<string, WaitingState>();  // sessionId → sessionWaiting 返回（缺省 null=不支持）
  let reportOnline = true;
  let interrupted: Array<{ taskId: string; title: string; workspaceName: string }> = [];
  // D6：前 N 次 startTurn 尝试模拟「RouterService 未就绪」显式拒绝（含已成功的尝试计数）
  let startTurnFailWithin = 0;

  const ports: DelegationRunPorts = {
    settings: () => settings.read(),
    findWorkspaceByName: (name) => {
      const id = workspaces.get(name);
      return id ? { id, name } : null;
    },
    resolveAgentInstance: (workspaceId, agentSlug) => {
      log.resolvedAgents.push({ workspaceId, agentSlug });
      if (agentSlug !== undefined) return agents.get(agentSlug) ?? null;
      return agents.get('__default__') ?? null;
    },
    resolveAgentInstanceByName: (workspaceId, agentName) => {
      log.resolvedAgentsByName.push({ workspaceId, agentName });
      return agentsByName.get(agentName) ?? null;
    },
    createDelegatedSession: (input) => {
      log.createdSessions.push(input);
      log.order.push(`createSession:${input.title}`);
      return `sess-${log.createdSessions.length}`;
    },
    applyRunPolicy: (sessionId, tier) => {
      log.appliedPolicies.push({ sessionId, tier });
      log.order.push(`applyRunPolicy:${sessionId}:${tier}`);
    },
    injectSteer: (sessionId, body) => {
      log.injectedSteers.push({ sessionId, body });
      log.order.push(`injectSteer:${sessionId}`);
    },
    sessionWaiting: (sessionId) => waitingStates.get(sessionId) ?? null,
    startTurn: async (input) => {
      log.startedTurns.push(input);
      log.order.push(`startTurn:${input.sessionId}`);
      if (log.startedTurns.length <= startTurnFailWithin) {
        throw new Error('RouterService 未就绪（boot 竞态），回合未注入');
      }
    },
    stopSession: (sessionId) => {
      log.stoppedSessions.push(sessionId);
      log.order.push(`stop:${sessionId}`);
    },
    watchTurn: (sessionId, onTerminal) => {
      watchers.set(sessionId, onTerminal);
      return () => { watchers.delete(sessionId); };
    },
    sessionTail: (sessionId, afterRowId) => {
      const q = tailQueue.get(sessionId);
      if (!q || q.length === 0) return null;
      const batch = q.splice(0, q.length);
      void afterRowId;
      return batch[batch.length - 1]!; // 末条即批尾（真实端口聚合整批后返回尾部摘要）
    },
    report: async (taskId, payload) => {
      log.reports.push({ taskId, payload });
      log.order.push(`report:${payload.status}:${taskId}`);
      return reportOnline;
    },
    listInterruptedDelegations: async () => interrupted,
    ...overrides,
  };

  const runner = createDelegationRunner({ ports, store, tickMs: 500 });

  return {
    runner, log, settings, store,
    fireTerminal: (sessionId, t) => { watchers.get(sessionId)?.(t); },
    pushTail: (sessionId, tail) => {
      const q = tailQueue.get(sessionId) ?? [];
      q.push(tail);
      tailQueue.set(sessionId, q);
    },
    setReportOnline: (online) => { reportOnline = online; },
    setWaiting: (sessionId, state) => { waitingStates.set(sessionId, state); },
    setInterrupted: (tasks) => { interrupted = tasks; },
    setWorkspace: (name, id) => { workspaces.set(name, id); },
    setAgent: (slug, instanceId) => { agents.set(slug ?? '__default__', instanceId); },
    setAgentByName: (name, instanceId) => { agentsByName.set(name, instanceId); },
    setStartTurnFailures: (within) => { startTurnFailWithin = within; },
  };
}

function assignedEvt(taskId: string, overrides?: Partial<AssignedTaskEvent>): AssignedTaskEvent {
  return {
    taskId,
    workspaceName: 'ws-a',
    task: { title: '修复登录超时', prompt: '请排查并修复登录超时问题，输出修复说明。' },
    byNode: 'node-leader',
    ...overrides,
  };
}

/** 建立一个可执行的委派（工作空间与 agent 就位）→ 返回会话 id */
async function admitOne(h: ReturnType<typeof makeHarness>, taskId: string): Promise<string> {
  h.setWorkspace('ws-a', 'ws-id-1');
  h.setAgent(undefined, 'inst-default');
  await h.runner.handleAssigned(assignedEvt(taskId));
  return `sess-${h.log.createdSessions.length}`;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
});

// ── 前置三拒（§5.3 declined 附因） ─────────────────────────────────────────

describe('前置三拒', () => {
  it('接受开关关闭 → declined 附因，不建会不落账', async () => {
    const h = makeHarness();
    h.settings.write({ acceptTasks: false, maxConcurrent: 2, hitlTimeoutMinutes: 15 });
    h.setWorkspace('ws-a', 'ws-id-1');
    h.setAgent(undefined, 'inst-default');

    await h.runner.handleAssigned(assignedEvt('t1'));

    expect(h.log.reports).toHaveLength(1);
    const r = h.log.reports[0]!;
    expect(r.taskId).toBe('t1');
    expect(r.payload.status).toBe('failed');
    expect(r.payload.reason).toMatch(/^declined:/);
    expect(r.payload.reason).toContain('接受');
    expect(h.log.createdSessions).toHaveLength(0);
    expect(h.store.get('t1')).toBeNull();
  });

  it('并发达上限（默认 2）→ declined；槽位释放后可再接受', async () => {
    const h = makeHarness();
    h.setWorkspace('ws-a', 'ws-id-1');
    h.setAgent(undefined, 'inst-default');
    await h.runner.handleAssigned(assignedEvt('t1'));
    await h.runner.handleAssigned(assignedEvt('t2'));
    expect(h.log.createdSessions).toHaveLength(2);

    await h.runner.handleAssigned(assignedEvt('t3'));
    expect(h.log.createdSessions).toHaveLength(2);
    const declined = h.log.reports.filter((r) => r.taskId === 't3');
    expect(declined).toHaveLength(1);
    expect(declined[0]!.payload.reason).toMatch(/^declined:/);
    expect(declined[0]!.payload.reason).toContain('并发');

    // t1 完成 → 槽位释放 → t4 可接受
    h.fireTerminal('sess-1', { status: 'done' });
    await vi.advanceTimersByTimeAsync(0);
    await h.runner.handleAssigned(assignedEvt('t4'));
    expect(h.log.createdSessions).toHaveLength(3);
    expect(h.store.get('t4')?.state).toBe('running');
  });

  it('工作空间不存在 → declined 附因', async () => {
    const h = makeHarness();
    // 不注册 ws-a
    await h.runner.handleAssigned(assignedEvt('t1'));
    const r = h.log.reports[0]!;
    expect(r.payload.reason).toMatch(/^declined:/);
    expect(r.payload.reason).toContain('工作空间');
    expect(h.log.createdSessions).toHaveLength(0);
  });

  it('agent 无法解析（slug 无匹配且无默认 agent）→ declined 附因', async () => {
    const h = makeHarness();
    h.setWorkspace('ws-a', 'ws-id-1');
    await h.runner.handleAssigned(assignedEvt('t1', { task: { title: 'x', prompt: 'p', agentSlug: 'ghost' } }));
    const r = h.log.reports[0]!;
    expect(r.payload.reason).toMatch(/^declined:/);
    expect(r.payload.reason).toContain('agent');
    expect(h.log.createdSessions).toHaveLength(0);
  });
});

// ── 委派会话（MC1）与首拍 wire 交接 ─────────────────────────────────────────

// ── M5.3 团队外派分支（spec §5.3 接收端） ───────────────────────────────────

describe('团队外派接收（team 段）', () => {
  function teamEvt(
    taskId: string,
    members: Array<{ name: string; isLeader: boolean }>,
    overrides?: Partial<AssignedTaskEvent>,
  ): AssignedTaskEvent {
    return {
      taskId,
      workspaceName: 'ws-a',
      task: { title: '团队任务', prompt: '协作完成团队任务。', team: { members } },
      byNode: 'node-leader',
      ...overrides,
    };
  }

  it('全解析 → 多成员建会（members/leader 标记正确）+ 首回合 mention leader + 首拍 running', async () => {
    const h = makeHarness();
    h.setWorkspace('ws-a', 'ws-id-1');
    h.setAgentByName('PM', 'inst-pm');
    h.setAgentByName('Coder', 'inst-coder');
    h.setAgentByName('QA', 'inst-qa');

    await h.runner.handleAssigned(teamEvt('t1', [
      { name: 'Coder', isLeader: false },
      { name: 'PM', isLeader: true },
      { name: 'QA', isLeader: false },
    ]));

    // 多成员建会：members 快照全量透传（leader 标记保序）——不带 memberInstanceId
    expect(h.log.createdSessions).toEqual([{
      workspaceId: 'ws-id-1',
      title: '团队任务',
      members: [
        { instanceId: 'inst-coder', isLeader: false },
        { instanceId: 'inst-pm', isLeader: true },
        { instanceId: 'inst-qa', isLeader: false },
      ],
    }]);
    // 首回合显式 mention leader（与本地 executor sendKickoff 同机制）
    expect(h.log.startedTurns).toHaveLength(1);
    expect(h.log.startedTurns[0]!.mentionedInstanceIds).toEqual(['inst-pm']);
    // 逐名解析：名单顺序逐个调用
    expect(h.log.resolvedAgentsByName.map((r) => r.agentName)).toEqual(['Coder', 'PM', 'QA']);
    // 单 agent 解析端口不被 team 路径消费
    expect(h.log.resolvedAgents).toHaveLength(0);
    // 账本 running + 首拍 running 必发
    expect(h.store.get('t1')?.state).toBe('running');
    expect(h.log.reports.some((r) => r.taskId === 't1' && r.payload.status === 'running')).toBe(true);
  });

  it('缺一名 → decline 人话名单（缺失者入列、在场者不列）+ 不建会不落账', async () => {
    const h = makeHarness();
    h.setWorkspace('ws-a', 'ws-id-1');
    h.setAgentByName('PM', 'inst-pm');
    h.setAgentByName('QA', 'inst-qa');

    await h.runner.handleAssigned(teamEvt('t1', [
      { name: 'PM', isLeader: true },
      { name: 'Coder', isLeader: false },
      { name: 'QA', isLeader: false },
    ]));

    const r = h.log.reports[0]!;
    expect(r.payload.status).toBe('failed');
    expect(r.payload.reason).toBe(
      'declined:团队成员无法解析: Coder（工作空间 ws-a 无这些 agent）——请先镜像工作空间或改派',
    );
    expect(h.log.createdSessions).toHaveLength(0);
    expect(h.store.get('t1')).toBeNull();
  });

  it('缺多名 → 名单逗号分隔全列', async () => {
    const h = makeHarness();
    h.setWorkspace('ws-a', 'ws-id-1');
    h.setAgentByName('PM', 'inst-pm');

    await h.runner.handleAssigned(teamEvt('t1', [
      { name: 'PM', isLeader: true },
      { name: 'Coder', isLeader: false },
      { name: 'QA', isLeader: false },
    ]));

    expect(h.log.reports[0]!.payload.reason).toBe(
      'declined:团队成员无法解析: Coder, QA（工作空间 ws-a 无这些 agent）——请先镜像工作空间或改派',
    );
  });

  it('leader 解析成功但成员失败 → 仍 decline（leader 单独在场无意义，不缩编）', async () => {
    const h = makeHarness();
    h.setWorkspace('ws-a', 'ws-id-1');
    h.setAgentByName('PM', 'inst-pm');

    await h.runner.handleAssigned(teamEvt('t1', [
      { name: 'PM', isLeader: true },
      { name: 'Coder', isLeader: false },
    ]));

    expect(h.log.createdSessions).toHaveLength(0);
    expect(h.log.reports[0]!.payload.reason).toContain('Coder');
    expect(h.log.reports[0]!.payload.reason).not.toContain('PM（');
  });

  it('团队段非法（单成员 / 双 leader）→ decline 非法附因（hub 校验的纵深防御）', async () => {
    const h = makeHarness();
    h.setWorkspace('ws-a', 'ws-id-1');
    h.setAgentByName('PM', 'inst-pm');
    h.setAgentByName('Coder', 'inst-coder');

    await h.runner.handleAssigned(teamEvt('t1', [{ name: 'PM', isLeader: true }]));
    expect(h.log.reports[0]!.payload.reason).toContain('团队段非法');
    expect(h.log.createdSessions).toHaveLength(0);

    h.log.reports.length = 0;
    await h.runner.handleAssigned(teamEvt('t2', [
      { name: 'PM', isLeader: true },
      { name: 'Coder', isLeader: true },
    ]));
    expect(h.log.reports[0]!.payload.reason).toContain('团队段非法');
    expect(h.log.createdSessions).toHaveLength(0);
  });

  it('无 team 段旧 payload → 单 agent 路径零变化（memberInstanceId 形状 + 无 mention）', async () => {
    const h = makeHarness();
    h.setWorkspace('ws-a', 'ws-id-1');
    h.setAgent('coder', 'inst-coder');

    await h.runner.handleAssigned(assignedEvt('t1', {
      task: { title: '单 agent 任务', prompt: '单独执行。', agentSlug: 'coder' },
    }));

    expect(h.log.createdSessions).toEqual([
      { workspaceId: 'ws-id-1', title: '单 agent 任务', memberInstanceId: 'inst-coder' },
    ]);
    expect(h.log.startedTurns[0]!.mentionedInstanceIds).toBeUndefined();
    expect(h.log.resolvedAgentsByName).toHaveLength(0);
  });
});

describe('委派会话与首拍上报', () => {
  it('建会（标题=任务书、成员=解析 agent）→ 账本 running → 首拍 running 必发且先于执行；excerpt 恒非空', async () => {
    const h = makeHarness();
    h.setWorkspace('ws-a', 'ws-id-1');
    h.setAgent('coder', 'inst-coder');

    await h.runner.handleAssigned(assignedEvt('t1', {
      task: { title: '修复登录超时', prompt: '请排查并修复登录超时问题。', agentSlug: 'coder' },
    }));

    // MC1：会话标题=任务书摘要（title）、成员=按 slug 解析的 agent 实例
    expect(h.log.createdSessions).toEqual([
      { workspaceId: 'ws-id-1', title: '修复登录超时', memberInstanceId: 'inst-coder' },
    ]);
    // 账本：taskId↔sessionId 关联 + running + byNode/工作空间留痕
    expect(h.store.get('t1')).toMatchObject({
      sessionId: 'sess-1', workspaceId: 'ws-id-1', workspaceName: 'ws-a',
      title: '修复登录超时', byNode: 'node-leader', state: 'running',
    });
    // 首拍 running{sessionId} 先于 startTurn（T9 语义：pending→done 直报被拒）
    const firstReportIdx = h.log.order.indexOf('report:running:t1');
    const startIdx = h.log.order.findIndex((e) => e.startsWith('startTurn:'));
    expect(firstReportIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(firstReportIdx);
    // 首拍载荷：running + sessionId + progress（excerpt=任务书首句截断，恒非空）
    const first = h.log.reports[0]!;
    expect(first.payload.status).toBe('running');
    expect(first.payload.sessionId).toBe('sess-1');
    expect(first.payload.progress?.excerpt).toContain('请排查并修复登录超时问题');
    expect(first.payload.progress!.excerpt.length).toBeGreaterThan(0);
    // 首条 user 消息=任务书 prompt（startTurn body）
    expect(h.log.startedTurns).toEqual([{ sessionId: 'sess-1', body: '请排查并修复登录超时问题。' }]);
  });

  it('同 taskId 重复 assigned → 幂等忽略（不重建会话不再上报）', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    const reportsBefore = h.log.reports.length;
    await h.runner.handleAssigned(assignedEvt('t1'));
    expect(h.log.createdSessions).toHaveLength(1);
    expect(h.log.reports).toHaveLength(reportsBefore);
  });
});

// ── 进度批（RF#5：500ms 合并、seq 单调不丢、断线缓冲重连续传） ────────────────

describe('进度 500ms 合并批量转发', () => {
  it('窗口内多增量合并为单拍：lastSeq=批尾、excerpt=末条摘要；无增量不打空拍', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.log.reports.length = 0; // 摘除首拍，聚焦进度拍

    h.pushTail('sess-1', { lastSeq: 3, excerpt: '分析中' });
    h.pushTail('sess-1', { lastSeq: 7, excerpt: '已定位根因' });
    h.pushTail('sess-1', { lastSeq: 9, excerpt: '正在编写修复补丁' });
    await vi.advanceTimersByTimeAsync(500);

    const beats = h.log.reports.filter((r) => r.payload.status === 'running');
    expect(beats).toHaveLength(1);
    expect(beats[0]!.payload.progress).toEqual({ lastSeq: 9, excerpt: '正在编写修复补丁' });

    // 无新增量 → 不打空拍
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.log.reports.filter((r) => r.payload.status === 'running')).toHaveLength(1);
  });

  it('lastSeq 单调不丢：上报失败（断线）不推进游标，重连后按最新批尾续传', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.log.reports.length = 0;

    // 断线窗口内增量持续产生——合并语义：后拍永不回退到旧批尾
    h.setReportOnline(false);
    h.pushTail('sess-1', { lastSeq: 4, excerpt: 'a' });
    await vi.advanceTimersByTimeAsync(500);
    h.pushTail('sess-1', { lastSeq: 8, excerpt: 'b' });
    await vi.advanceTimersByTimeAsync(500);
    const duringOffline = h.log.reports
      .filter((r) => r.payload.status === 'running')
      .map((r) => r.payload.progress!.lastSeq);
    expect(duringOffline.length).toBeGreaterThan(0); // 有尝试（均失败返回 false）
    const nonDecreasing = duringOffline.every((s, i) => i === 0 || s >= duringOffline[i - 1]!);
    expect(nonDecreasing).toBe(true);
    expect(duringOffline[duringOffline.length - 1]).toBe(8); // 断线尾拍已合并到最新批尾

    // 重连 → 下一拍按最新批尾续传（游标从未推进，不丢增量）
    h.setReportOnline(true);
    h.pushTail('sess-1', { lastSeq: 12, excerpt: 'c' });
    await vi.advanceTimersByTimeAsync(500);
    const beats = h.log.reports.filter((r) => r.payload.status === 'running' && r.payload.progress!.lastSeq === 12);
    expect(beats).toHaveLength(1);
    expect(beats[0]!.payload.progress).toEqual({ lastSeq: 12, excerpt: 'c' });
    // 游标推进后无增量 → 不再回放 12
    await vi.advanceTimersByTimeAsync(500);
    expect(h.log.reports.filter((r) => r.payload.status === 'running' && r.payload.progress!.lastSeq === 12)).toHaveLength(1);
  });

  it('运行结束后进度拍停发（tick 不再产出该任务的上报）', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.fireTerminal('sess-1', { status: 'done' });
    await vi.advanceTimersByTimeAsync(0);
    h.log.reports.length = 0;
    h.pushTail('sess-1', { lastSeq: 20, excerpt: '迟到的增量' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.log.reports).toHaveLength(0);
  });
});

// ── 完成与失败上报 ──────────────────────────────────────────────────────────

describe('完成与失败上报', () => {
  it('turn 正常完成 → report done；账本 done；并发槽释放', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.fireTerminal('sess-1', { status: 'done' });
    await vi.advanceTimersByTimeAsync(0);
    const done = h.log.reports.find((r) => r.taskId === 't1' && r.payload.status === 'done');
    expect(done).toBeDefined();
    expect(h.store.get('t1')?.state).toBe('done');
  });

  it('turn 失败 → report failed 携带错误原因；账本 failed', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.fireTerminal('sess-1', { status: 'failed', error: '模型供应商连接失败' });
    await vi.advanceTimersByTimeAsync(0);
    const failed = h.log.reports.find((r) => r.taskId === 't1' && r.payload.status === 'failed');
    expect(failed?.payload.reason).toContain('模型供应商连接失败');
    expect(h.store.get('t1')?.state).toBe('failed');
  });

  // M2.3 P2-1：reason 与上报 hub 载荷同源落本机账本（worker 本机卡 title 全文数据源）
  it('turn 失败 → 账本行 reason 与 report reason 同源（本机卡与 leader 卡同文）', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.fireTerminal('sess-1', { status: 'failed', error: '模型供应商连接失败' });
    await vi.advanceTimersByTimeAsync(0);
    const failed = h.log.reports.find((r) => r.taskId === 't1' && r.payload.status === 'failed');
    expect(h.store.get('t1')?.reason).toBe(failed?.payload.reason);
  });

  it('turn 正常完成 → 账本行不落 reason（done 无因，缺席不空白）', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.fireTerminal('sess-1', { status: 'done' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.get('t1')?.state).toBe('done');
    expect(h.store.get('t1')?.reason).toBeUndefined();
  });

  it('turn 中止（aborted）→ report failed 附因', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.fireTerminal('sess-1', { status: 'aborted' });
    await vi.advanceTimersByTimeAsync(0);
    const failed = h.log.reports.find((r) => r.taskId === 't1' && r.payload.status === 'failed');
    expect(failed?.payload.reason).toBeDefined();
    expect(h.store.get('t1')?.state).toBe('failed');
  });

  it('上报序恒为 running 首拍 → 终态拍（T9：pending→done 直报被拒）', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.fireTerminal('sess-1', { status: 'done' });
    await vi.advanceTimersByTimeAsync(0);
    const statuses = h.log.reports.filter((r) => r.taskId === 't1').map((r) => r.payload.status);
    expect(statuses[0]).toBe('running');
    expect(statuses[statuses.length - 1]).toBe('done');
  });
});

// ── 开关即时生效 ────────────────────────────────────────────────────────────

describe('开关即时生效', () => {
  it('运行中关闭接受开关 → 新委派被拒，既有运行不受影响', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.settings.write({ acceptTasks: false, maxConcurrent: 2, hitlTimeoutMinutes: 15 });
    await h.runner.handleAssigned(assignedEvt('t2'));
    expect(h.log.reports.find((r) => r.taskId === 't2')?.payload.reason).toMatch(/^declined:/);
    // 既有 t1 不停跑
    expect(h.log.stoppedSessions).toHaveLength(0);
    h.pushTail('sess-1', { lastSeq: 5, excerpt: '仍在跑' });
    await vi.advanceTimersByTimeAsync(500);
    expect(h.log.reports.some((r) => r.payload.status === 'running' && r.payload.progress?.lastSeq === 5)).toBe(true);
  });
});

// ── 断线续传（T11） ────────────────────────────────────────────────────────

describe('重连续传', () => {
  it('本地仍在跑 → 直接复报 running 续传（带进度尾部），不重复建回合', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.setInterrupted([{ taskId: 't1', title: '修复登录超时', workspaceName: 'ws-a' }]);
    h.log.reports.length = 0;
    await h.runner.handleOnline();
    const beats = h.log.reports.filter((r) => r.taskId === 't1');
    expect(beats).toHaveLength(1);
    expect(beats[0]!.payload.status).toBe('running');
    expect(beats[0]!.payload.sessionId).toBe('sess-1');
    expect(beats[0]!.payload.progress?.excerpt.length ?? 0).toBeGreaterThan(0); // excerpt 恒非空
    expect(h.log.startedTurns).toHaveLength(1); // 不重复注入续跑回合
  });

  it('本地会话闲置（中断非在跑）→ 复用会话注入续跑回合 → 复报 running', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    // 模拟应用重启后：watcher 不在（terminal 已清算）——账本仍在、无活跃 watcher
    // 直接构造：完成 t1（释放 watcher），再把账本翻回 running 模拟 hub 侧 interrupted
    h.fireTerminal('sess-1', { status: 'failed', error: '进程中断' });
    await vi.advanceTimersByTimeAsync(0);
    h.store.updateState('t1', 'running');
    const turnsBefore = h.log.startedTurns.length;

    h.setInterrupted([{ taskId: 't1', title: '修复登录超时', workspaceName: 'ws-a' }]);
    await h.runner.handleOnline();

    // 复用同一会话注入续跑回合（MC1：会话历史含任务书与已完成部分）
    expect(h.log.startedTurns.length).toBe(turnsBefore + 1);
    const cont = h.log.startedTurns[h.log.startedTurns.length - 1]!;
    expect(cont.sessionId).toBe('sess-1');
    expect(cont.body).toContain('续');
    const beat = h.log.reports.filter((r) => r.taskId === 't1' && r.payload.status === 'running');
    expect(beat.length).toBeGreaterThan(0);
  });

  it('本地无此会话（重启丢档）→ report failed{reason:"local_session_lost"}', async () => {
    const h = makeHarness();
    h.setInterrupted([{ taskId: 'ghost', title: 'x', workspaceName: 'ws-a' }]);
    await h.runner.handleOnline();
    const r = h.log.reports.find((x) => x.taskId === 'ghost');
    expect(r?.payload.status).toBe('failed');
    expect(r?.payload.reason).toBe('local_session_lost');
  });

  // M2.4 T3：补终态拍消费账本 reason（M2.3 P2-1 已把 reason 落本机账本，leader 侧
  // 补拍必须同源——旧实现硬编码老文案，本机卡与 leader 卡不同文）
  it('本地已终态 failed 且账本有 reason → 补终态拍 reason 逐字等于账本 reason', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.fireTerminal('sess-1', { status: 'failed', error: '模型供应商连接失败' });
    await vi.advanceTimersByTimeAsync(0);
    const localReason = h.store.get('t1')?.reason;
    expect(localReason).toContain('模型供应商连接失败');
    const before = h.log.reports.length;

    h.setInterrupted([{ taskId: 't1', title: '修复登录超时', workspaceName: 'ws-a' }]);
    await h.runner.handleOnline();

    const patched = h.log.reports.slice(before).find((r) => r.payload.status === 'failed');
    expect(patched?.payload.reason).toBe(localReason);
  });

  it('本地已终态 failed 但账本无 reason（P2-1 前老数据）→ 补终态拍沿用老文案', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    // 先清活跃回合（done 释放 watcher 且不落 reason），再翻账本 failed 模拟无因终态
    h.fireTerminal('sess-1', { status: 'done' });
    await vi.advanceTimersByTimeAsync(0);
    h.store.updateState('t1', 'failed');
    expect(h.store.get('t1')?.state).toBe('failed');
    expect(h.store.get('t1')?.reason).toBeUndefined();
    const before = h.log.reports.length;

    h.setInterrupted([{ taskId: 't1', title: '修复登录超时', workspaceName: 'ws-a' }]);
    await h.runner.handleOnline();

    const patched = h.log.reports.slice(before).find((r) => r.payload.status === 'failed');
    expect(patched?.payload.reason).toBe('中断前本地回合已失败');
  });

  // ── D6 续传 boot 竞态（重连早于 RouterService lazy 启动）───────────────────

  it('D6：startTurn 前两次未就绪拒绝 → 1s 退避重试第三次成功续传（不误报失败）', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    // 本地闲置（重启后账本 running、无活跃 watcher）——复用「闲置续跑」测试构造
    h.fireTerminal('sess-1', { status: 'failed', error: '进程中断' });
    await vi.advanceTimersByTimeAsync(0);
    h.store.updateState('t1', 'running');
    const priorTurns = h.log.startedTurns.length;

    h.setStartTurnFailures(priorTurns + 2); // 接下来 2 次尝试未就绪，第 3 次成功
    h.setInterrupted([{ taskId: 't1', title: '修复登录超时', workspaceName: 'ws-a' }]);
    const online = h.runner.handleOnline();
    await vi.advanceTimersByTimeAsync(0); // 第 1 次尝试拒绝 → 进入 1s 退避
    await vi.advanceTimersByTimeAsync(1000); // 第 2 次尝试拒绝 → 再退避
    await vi.advanceTimersByTimeAsync(1000); // 第 3 次尝试成功
    await online;

    const cont = h.log.startedTurns[h.log.startedTurns.length - 1]!;
    expect(cont.sessionId).toBe('sess-1');
    expect(cont.body).toContain('续传');
    // 3 次尝试全部发生（2 拒绝 + 1 成功）
    expect(h.log.startedTurns.length).toBe(priorTurns + 3);
    // 未误报 resume_boot_timeout；账本保持 running（回合在跑，等终态）
    const timeout = h.log.reports.find(
      (r) => r.taskId === 't1' && r.payload.reason?.includes('resume_boot_timeout'),
    );
    expect(timeout).toBeUndefined();
    expect(h.store.get('t1')?.state).toBe('running');
  });

  it('D6：startTurn 三连败 → report failed 附 resume_boot_timeout 人话（不留永卡 running）', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.fireTerminal('sess-1', { status: 'failed', error: '进程中断' });
    await vi.advanceTimersByTimeAsync(0);
    h.store.updateState('t1', 'running');
    const priorTurns = h.log.startedTurns.length;

    h.setStartTurnFailures(priorTurns + 3); // 3 次尝试全部未就绪
    h.setInterrupted([{ taskId: 't1', title: '修复登录超时', workspaceName: 'ws-a' }]);
    const online = h.runner.handleOnline();
    await vi.advanceTimersByTimeAsync(3000); // 3 尝试 + 2×1s 退避全覆盖
    await online;

    const r = h.log.reports.find((x) => x.taskId === 't1' && x.payload.reason?.includes('resume_boot_timeout'));
    expect(r?.payload.status).toBe('failed');
    expect(r?.payload.reason).toContain('运行时');
    expect(h.store.get('t1')?.state).toBe('failed');
  });

  it('续传复报 running 后本地已终态 → 随即补终态拍（interrupted→running→done 合法链）', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    // 本地已完成但 hub 侧是 interrupted（完成拍未送达）：必须先 running 再 done（T9 状态机）
    h.fireTerminal('sess-1', { status: 'done' });
    await vi.advanceTimersByTimeAsync(0);
    const before = h.log.reports.length;

    h.setInterrupted([{ taskId: 't1', title: '修复登录超时', workspaceName: 'ws-a' }]);
    await h.runner.handleOnline();

    const after = h.log.reports.slice(before).map((r) => r.payload.status);
    expect(after).toEqual(['running', 'done']);
  });
});

// ── 取消（T11 三态） ───────────────────────────────────────────────────────

describe('取消三态', () => {
  it('运行中 → 停跑（既有取消入口）→ 不再上报（账本已 cancelled）', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.log.reports.length = 0;
    h.runner.handleCancelled({ taskId: 't1' });
    await vi.advanceTimersByTimeAsync(0);

    expect(h.log.stoppedSessions).toEqual(['sess-1']);
    expect(h.log.reports).toHaveLength(0); // 取消不上报
    expect(h.store.get('t1')?.state).toBe('cancelled');
    // 停跑后进度拍彻底停发
    h.pushTail('sess-1', { lastSeq: 99, excerpt: 'x' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.log.reports).toHaveLength(0);
    // 并发槽已释放
    await h.runner.handleAssigned(assignedEvt('t2'));
    expect(h.log.createdSessions).toHaveLength(2);
  });

  it('本地无记录（pending 未受理）→ 无动作：不停跑不上报不抛错', async () => {
    const h = makeHarness();
    expect(() => h.runner.handleCancelled({ taskId: 'unknown' })).not.toThrow();
    expect(h.log.stoppedSessions).toHaveLength(0);
    expect(h.log.reports).toHaveLength(0);
  });

  it('interrupted（本地闲置非在跑）→ 不停跑，仅账本清算', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.fireTerminal('sess-1', { status: 'done' });
    await vi.advanceTimersByTimeAsync(0);
    h.runner.handleCancelled({ taskId: 't1' });
    expect(h.log.stoppedSessions).toHaveLength(0);
    expect(h.store.get('t1')?.state).toBe('cancelled');
  });
});

// ── L0 权限档位（M2.1 T10：applyRunPolicy 预配 + readonly prompt 前置） ───────

describe('权限档位预配（T10）', () => {
  it('调用序锁：createSession → applyRunPolicy → startTurn（档位预配先于回合注入）', async () => {
    const h = makeHarness();
    h.setWorkspace('ws-a', 'ws-id-1');
    h.setAgent(undefined, 'inst-default');

    await h.runner.handleAssigned(assignedEvt('t1'));

    const createIdx = h.log.order.findIndex((e) => e.startsWith('createSession:'));
    const policyIdx = h.log.order.findIndex((e) => e.startsWith('applyRunPolicy:'));
    const startIdx = h.log.order.findIndex((e) => e.startsWith('startTurn:'));
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(policyIdx).toBeGreaterThan(createIdx);
    expect(startIdx).toBeGreaterThan(policyIdx);
  });

  it('readonly 档：applyRunPolicy(sessionId,"readonly") + startTurn body 前置只读约束段', async () => {
    const h = makeHarness();
    h.setWorkspace('ws-a', 'ws-id-1');
    h.setAgent(undefined, 'inst-default');
    const prompt = '请排查并修复登录超时问题，输出修复说明。';

    await h.runner.handleAssigned(assignedEvt('t1', {
      task: { title: '修复登录超时', prompt, permissionTier: 'readonly' },
    }));

    expect(h.log.appliedPolicies).toEqual([{ sessionId: 'sess-1', tier: 'readonly' }]);
    // 任务书前置只读约束段（任务书原文在后，不被吞并）
    expect(h.log.startedTurns).toHaveLength(1);
    expect(h.log.startedTurns[0]!.body.startsWith(READONLY_PROMPT_PREFIX)).toBe(true);
    expect(h.log.startedTurns[0]!.body.endsWith(prompt)).toBe(true);
  });

  it('sandbox 档：applyRunPolicy(sessionId,"sandbox") + 任务书原文直返（零前缀）', async () => {
    const h = makeHarness();
    h.setWorkspace('ws-a', 'ws-id-1');
    h.setAgent(undefined, 'inst-default');
    const prompt = '重构鉴权中间件并补测试。';

    await h.runner.handleAssigned(assignedEvt('t1', {
      task: { title: '重构', prompt, permissionTier: 'sandbox' },
    }));

    expect(h.log.appliedPolicies).toEqual([{ sessionId: 'sess-1', tier: 'sandbox' }]);
    expect(h.log.startedTurns[0]!.body).toBe(prompt);
  });

  it('协议未知容忍：permissionTier 缺省 → confirm（hub 1.2.0 剥离字段，现状默认）', async () => {
    const h = makeHarness();
    h.setWorkspace('ws-a', 'ws-id-1');
    h.setAgent(undefined, 'inst-default');

    await h.runner.handleAssigned(assignedEvt('t1'));

    expect(h.log.appliedPolicies).toEqual([{ sessionId: 'sess-1', tier: 'confirm' }]);
  });

  it('协议未知容忍：permissionTier 非法值（"root"）→ 收敛 confirm 不抛', async () => {
    const h = makeHarness();
    h.setWorkspace('ws-a', 'ws-id-1');
    h.setAgent(undefined, 'inst-default');

    // 异形协议载荷直仿：wire 上来的未知字段不 guarantee 类型（parse 侧白名单前）
    const evt = assignedEvt('t1', { task: { title: 'x', prompt: 'p' } });
    (evt.task as { permissionTier?: unknown }).permissionTier = 'root';
    await h.runner.handleAssigned(evt);

    expect(h.log.appliedPolicies).toEqual([{ sessionId: 'sess-1', tier: 'confirm' }]);
    expect(h.store.get('t1')?.state).toBe('running');
  });

  it('declined 路径不预配：工作空间不存在 → applyRunPolicy 零调用', async () => {
    const h = makeHarness();
    await h.runner.handleAssigned(assignedEvt('t1'));
    expect(h.log.appliedPolicies).toHaveLength(0);
  });
});

// ── L1b waiting-input 进度信号（M2.1 T11，RF#3 粘滞红线） ─────────────────────

describe('waiting-input 进度信号（L1b）', () => {
  it('sessionWaiting→waiting=true：进度拍带 kind=waiting-input、excerpt=summary（无尾部增量也打拍——等待态必须可见）；lastSeq 不回退', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.log.reports.length = 0;

    h.setWaiting('sess-1', { waiting: true, summary: '等待批准写入 /tmp/fix.patch' });
    await vi.advanceTimersByTimeAsync(500);

    const beats = h.log.reports.filter((r) => r.payload.status === 'running');
    expect(beats.length).toBeGreaterThan(0);
    for (const b of beats) {
      expect(b.payload.progress?.kind).toBe('waiting-input');
      expect(b.payload.progress?.excerpt).toBe('等待批准写入 /tmp/fix.patch');
      expect((b.payload.progress?.lastSeq ?? -1)).toBeGreaterThanOrEqual(0);
    }

    // 等待期间出现尾部增量：lastSeq 取批尾（单调不回退），kind 仍为 waiting-input
    h.pushTail('sess-1', { lastSeq: 42, excerpt: '工具调用等待中' });
    await vi.advanceTimersByTimeAsync(500);
    const withTail = h.log.reports.find((r) => r.payload.progress?.lastSeq === 42);
    expect(withTail?.payload.progress?.kind).toBe('waiting-input');
    expect(withTail?.payload.progress?.excerpt).toBe('等待批准写入 /tmp/fix.patch');
  });

  it('恢复（waiting=false）→ 下一拍 kind 消失（RF#3 粘滞钉死）：正常 excerpt 覆盖', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.setWaiting('sess-1', { waiting: true, summary: '等待批准写入' });
    await vi.advanceTimersByTimeAsync(500);
    expect(h.log.reports.some((r) => r.payload.progress?.kind === 'waiting-input')).toBe(true);

    h.setWaiting('sess-1', { waiting: false, summary: '' });
    h.pushTail('sess-1', { lastSeq: 30, excerpt: '已恢复执行，正在收尾' });
    await vi.advanceTimersByTimeAsync(500);

    const afterRecovery = h.log.reports.filter((r) => r.payload.progress?.lastSeq === 30);
    expect(afterRecovery).toHaveLength(1);
    expect(afterRecovery[0]!.payload.progress?.kind).toBeUndefined(); // RF#3：kind 必须消失
    expect(afterRecovery[0]!.payload.progress?.excerpt).toBe('已恢复执行，正在收尾');
    // 后续等待拍再翻回 waiting 仍可带 kind（信号可重复翻转）
    h.setWaiting('sess-1', { waiting: true, summary: '再次等待确认' });
    h.pushTail('sess-1', { lastSeq: 31, excerpt: '新工具调用' });
    await vi.advanceTimersByTimeAsync(500);
    expect(h.log.reports.some((r) => r.payload.progress?.kind === 'waiting-input' && r.payload.progress?.excerpt === '再次等待确认')).toBe(true);
  });

  it('断线缓冲：waiting 拍离线合并为最新 summary（kind 保留），重连后补传；恢复后未发的 waiting 拍去 kind 再传', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.log.reports.length = 0;

    h.setReportOnline(false);
    h.setWaiting('sess-1', { waiting: true, summary: '第一次摘要' });
    await vi.advanceTimersByTimeAsync(500);
    h.setWaiting('sess-1', { waiting: true, summary: '最新等待摘要' });
    await vi.advanceTimersByTimeAsync(500);
    // 离线期间有尝试（report 记录含失败尝试——离线尝试带 kind 合法），全部返回 false
    const offlineAttempts = h.log.reports.filter((r) => r.payload.status === 'running');
    expect(offlineAttempts.length).toBeGreaterThan(0);
    expect(offlineAttempts[offlineAttempts.length - 1]!.payload.progress?.excerpt).toBe('最新等待摘要');

    // 恢复在线 + 恢复等待 → 下一拍补传：缓冲拍去 kind（RF#3），excerpt 为合并后的最新摘要
    const beforeFlush = h.log.reports.length;
    h.setReportOnline(true);
    h.setWaiting('sess-1', { waiting: false, summary: '' });
    await vi.advanceTimersByTimeAsync(500);
    const flushed = h.log.reports.slice(beforeFlush).filter((r) => r.payload.status === 'running');
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.payload.progress?.excerpt).toBe('最新等待摘要');
    expect(flushed[0]!.payload.progress?.kind).toBeUndefined();

    // 再翻转 waiting：重连后新等待拍恢复带 kind
    h.setWaiting('sess-1', { waiting: true, summary: '重连后等待' });
    await vi.advanceTimersByTimeAsync(500);
    expect(h.log.reports.some((r) => r.payload.progress?.kind === 'waiting-input' && r.payload.progress?.excerpt === '重连后等待')).toBe(true);
  });

  it('端口返回 null（信号源不支持）→ 降级不检测：零 kind 拍、超时链零触发', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.log.reports.length = 0;
    // 不设 waitingStates → sessionWaiting 返回 null（缺省不支持）
    h.pushTail('sess-1', { lastSeq: 5, excerpt: '正常增量' });
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1000);
    expect(h.log.reports.some((r) => r.payload.progress?.kind === 'waiting-input')).toBe(false);
    expect(h.log.appliedPolicies).toHaveLength(1); // 仅 T10 首配那一次
    expect(h.log.injectedSteers).toHaveLength(0);
    expect(h.store.get('t1')?.state).toBe('running'); // 无双倍超时误杀
  });

  it('kind 全链：report 载荷 progress={lastSeq, excerpt, kind} 原样上行（hub v0.1.4 白名单透传——momo-hub delegations.test.ts「task.report kind 透传（T11b）」两用例锁 leader 侧形状）', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.log.reports.length = 0;
    h.setWaiting('sess-1', { waiting: true, summary: '等待批准写入 /tmp/fix.patch' });
    await vi.advanceTimersByTimeAsync(500);
    const beat = h.log.reports.find((r) => r.payload.status === 'running');
    // 精确形状锁：本端上行 = hub parseReportPayload 白名单受理 = leader 推送面所见
    expect(beat?.payload.progress).toEqual({
      lastSeq: 0, excerpt: '等待批准写入 /tmp/fix.patch', kind: 'waiting-input',
    });
  });
});

// ── L1 无人确认超时自动拒（M2.1 T11，RF#4 永卡红线） ─────────────────────────

describe('HITL 无人确认超时自动拒（L1）', () => {
  it('持续等待超 hitlTimeoutMinutes → applyRunPolicy(readonly) 先于 injectSteer（调用序锁）+ steer 文案；注入后仍等终态（done 正常上报——不永卡）', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.log.reports.length = 0;
    h.log.order.length = 0;

    h.setWaiting('sess-1', { waiting: true, summary: '等待批准写入' });
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1000); // 默认 15 分钟超时

    // 注入序：applyRunPolicy(readonly)（denied 授权面）→ injectSteer（保守指令）
    expect(h.log.appliedPolicies).toHaveLength(2); // T10 首配 + 超时注入
    expect(h.log.appliedPolicies[1]).toEqual({ sessionId: 'sess-1', tier: 'readonly' });
    expect(h.log.injectedSteers).toHaveLength(1);
    expect(h.log.injectedSteers[0]!.sessionId).toBe('sess-1');
    expect(h.log.injectedSteers[0]!.body).toContain('用户不在场');
    const denyIdx = h.log.order.indexOf('applyRunPolicy:sess-1:readonly');
    const steerIdx = h.log.order.indexOf('injectSteer:sess-1');
    expect(denyIdx).toBeGreaterThan(-1);
    expect(steerIdx).toBeGreaterThan(denyIdx);
    // 注入幂等：再过一个超时周期（未到双倍）不重复注入
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.log.injectedSteers).toHaveLength(1);

    // 注入后 agent 保守收尾 → 终态正常上报（不永卡 running）
    h.fireTerminal('sess-1', { status: 'done' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.log.reports.some((r) => r.taskId === 't1' && r.payload.status === 'done')).toBe(true);
    expect(h.store.get('t1')?.state).toBe('done');
  });

  it('注入后双倍超时仍在等待 → settleRun failed 附 hitl_timeout 人话 + 停跑（RF#4：账本 failed 不滞留 running）', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');

    h.setWaiting('sess-1', { waiting: true, summary: '等待批准写入' });
    await vi.advanceTimersByTimeAsync(2 * 15 * 60 * 1000 + 2000); // 双倍超时

    const failed = h.log.reports.find((r) => r.taskId === 't1' && r.payload.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed!.payload.reason).toContain('hitl_timeout');
    expect(failed!.payload.reason).toContain('15'); // 人话含超时分钟数
    expect(h.store.get('t1')?.state).toBe('failed');
    expect(h.log.stoppedSessions).toContain('sess-1'); // 停跑兜底（不留幽灵回合）
    // 清算后不再打拍
    h.log.reports.length = 0;
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.log.reports).toHaveLength(0);
  });

  it('等待恢复清零时钟：再等待从零计时（不因历史等待段误触发注入）', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');

    h.setWaiting('sess-1', { waiting: true, summary: '第一次等待' });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // 10 分钟（< 15）
    h.setWaiting('sess-1', { waiting: false, summary: '' });
    await vi.advanceTimersByTimeAsync(500);
    h.setWaiting('sess-1', { waiting: true, summary: '第二次等待' });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 500); // 又 10 分钟——累计 20 但连续段仅 10

    expect(h.log.injectedSteers).toHaveLength(0); // 未到 15 分钟连续等待：零注入
    expect(h.store.get('t1')?.state).toBe('running');
  });
});

// ── P2-1（T11 评审）：sessionWaiting 异常/null ≠ 恢复——降级拍保留等待时钟 ────

describe('降级拍不重置等待时钟（P2-1）', () => {
  it('null 一拍后恢复 waiting → 时钟连续：降级窗口计入连续等待段（不在降级拍清零重计时）', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');

    h.setWaiting('sess-1', { waiting: true, summary: '第一次等待' });
    await vi.advanceTimersByTimeAsync(8 * 60 * 1000); // 连续等待 8 分钟（< 15）
    h.setWaiting('sess-1', null); // 信号源降级（查询异常同走 null）——≠ 恢复
    await vi.advanceTimersByTimeAsync(8 * 60 * 1000 + 1000); // 降级窗口 8 分钟：不注入（跳过检测）
    expect(h.log.injectedSteers).toHaveLength(0);

    h.setWaiting('sess-1', { waiting: true, summary: '降级后仍等待' });
    await vi.advanceTimersByTimeAsync(1000); // 下一拍：连续段 ≈16.5 分钟 > 15 → 注入
    // 修复前：降级拍走「恢复」分支清零 waitingSince → 连续段从恢复拍重计（0 分钟）→ 永不注入
    expect(h.log.injectedSteers).toHaveLength(1);
  });

  it('注入后降级拍不清注入标记 → 同等待段不二次注入（越双倍线走 RF#4 清算而非再注入）', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');

    h.setWaiting('sess-1', { waiting: true, summary: '持续等待' });
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1000); // 首次注入
    expect(h.log.injectedSteers).toHaveLength(1);

    h.setWaiting('sess-1', null); // 注入后信号源降级一拍
    await vi.advanceTimersByTimeAsync(500);
    h.setWaiting('sess-1', { waiting: true, summary: '降级后继续等待' });
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1000); // 累计连续 ≈30.5 分钟 ≥ 2×15

    // 修复前：降级拍清 hitlInjectedAt → 15 分钟后二次注入（steers=2 且仍 running）
    expect(h.log.injectedSteers).toHaveLength(1); // 注入幂等跨降级拍保持
    const failed = h.log.reports.find((r) => r.taskId === 't1' && r.payload.status === 'failed');
    expect(failed?.payload.reason).toContain('hitl_timeout'); // 越双倍线 → RF#4 清算
    expect(h.log.stoppedSessions).toContain('sess-1');
    expect(h.store.get('t1')?.state).toBe('failed');
  });
});

// ═══ M2.2 P2-1：readonly 即时拒（会话标记 + denied 进度拍）═══
// 标记真源在 write-blocked-emit（进程内模块态）；runner 在 applyRunPolicy 产物
// 落地后标记，denial 事件经 tick 消费为 kind='denied' 拍（worker 侧等待卡即时
// 可见 denied 而非挂起——excerpt 承载「只读档位」文案，hub v0.1.4 对非
// waiting-input kind 剥除不透传，前向预留）。
describe('readonly 即时拒（M2.2 P2-1）', () => {
  beforeEach(() => {
    __resetInspectStateForTest();
  });

  it('P2-1a. readonly 档 handleAssigned → 会话标记 readonly（applyRunPolicy 产物消费）', async () => {
    const h = makeHarness();
    h.setWorkspace('ws-a', 'ws-id-1');
    h.setAgent(undefined, 'inst-default');
    await h.runner.handleAssigned(
      assignedEvt('t1', { task: { title: '只读巡检', prompt: '巡检', permissionTier: 'readonly' } }),
    );
    expect(isReadonlySession('sess-1')).toBe(true);
  });

  it('P2-1b. confirm/sandbox 档不标记（非 readonly 会话不受影响）', async () => {
    const h = makeHarness();
    h.setWorkspace('ws-a', 'ws-id-1');
    h.setAgent(undefined, 'inst-default');
    await h.runner.handleAssigned(assignedEvt('t1'));
    await h.runner.handleAssigned(
      assignedEvt('t2', { task: { title: '沙箱活', prompt: 'p', permissionTier: 'sandbox' } }),
    );
    expect(isReadonlySession('sess-1')).toBe(false);
    expect(isReadonlySession('sess-2')).toBe(false);
  });

  it('P2-1c. denial 事件 → 进度拍 kind=denied + excerpt 含「只读档位即时拒绝」；消费即清不重复打拍', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.log.reports.length = 0;

    markSessionReadonly('sess-1', true);
    __pushReadonlyDeniedForTest('sess-1', 'bash git push origin main');
    await vi.advanceTimersByTimeAsync(500);

    const deniedBeats = h.log.reports.filter(
      (r) => r.payload.status === 'running' && r.payload.progress?.kind === 'denied',
    );
    expect(deniedBeats).toHaveLength(1);
    expect(deniedBeats[0]!.payload.progress?.excerpt).toContain('只读档位即时拒绝');
    expect(deniedBeats[0]!.payload.progress?.excerpt).toContain('bash git push origin main');

    await vi.advanceTimersByTimeAsync(1500);
    const again = h.log.reports.filter(
      (r) => r.payload.status === 'running' && r.payload.progress?.kind === 'denied',
    );
    expect(again).toHaveLength(1);
  });

  it('P2-1d. HITL 超时注入翻转 readonly → 会话同步标记（后续写调用即时拒）', async () => {
    const h = makeHarness();
    await admitOne(h, 't1');
    h.setWaiting('sess-1', { waiting: true, summary: '等待写授权' });
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_000);
    expect(h.log.injectedSteers).toHaveLength(1);
    expect(isReadonlySession('sess-1')).toBe(true);
  });
});
