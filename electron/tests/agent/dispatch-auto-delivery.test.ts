// electron/tests/agent/dispatch-auto-delivery.test.ts
//
// v2.9 事件驱动 dispatch（spec 2026-09-24）：RouterService 自动送达链路测试。
// 覆盖：
//   1. followup 链终态 → PM 空闲即注入唤醒（dispatch-result 行落库 +
//      routeUserChat systemKickoff；消息行 taskId=链 ID / streamSessionId 与
//      唤醒流同源——单点生成沿线共享）
//   2. PM 忙碌 → 不打扰在途回合；onPmIdle 边沿补投
//   3. 非 followup（bg/sync）链：未经历 PM 空闲快照 → 不投递（回合内消费模型）；
//      markPmIdle 后在途翻转 → 投递
//   4. in_progress 心跳：registry 续命、不触发投递
//   5. routeDispatch 同链在途重复轮 → 拒绝（steer 提示 PM，不重复 executeTask）
//
// fixture 保真度（momo-test-rules）：真实 SQLite（dispatch-result 行真实落库）+
// 真实 RouterService / dispatchRegistry；mock 仅 runner（进程边界）。
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// mock electron：stream-relay 的 BrowserWindow 推送在测试环境静默降级（同款模式）
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: vi.fn() } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { listMessagesBySession } from '../../src/main/storage/messages/repo';
import { RouterService } from '../../src/main/agent/router-service';
import { dispatchRegistry, __resetDispatchRegistryForTest } from '../../src/main/agent/dispatch-registry';
import type { AgentRunner } from '../../src/main/agent/agent-runner';
const tmpRoot = path.join(
  os.tmpdir(),
  `ap-dispatch-delivery-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

let sessChatId = '';

/** PM runner mock（busy 可变——用 getter 让 onPmIdle 前的「回合结束」可翻转） */
function mkRunner(initialBusy = false): { runner: AgentRunner; spies: {
  executeTask: Mock;
  steer: Mock;
  notifyTaskReply: Mock;
  setBusy: (b: boolean) => void;
} } {
  const executeTask = vi.fn(async (t: { streamSessionId: string }) => ({ streamSessionId: t.streamSessionId }));
  const steer = vi.fn((): boolean => true);
  const notifyTaskReply = vi.fn(async (): Promise<void> => undefined);
  let busyNow = initialBusy;
  const runner = {
    executeTask,
    steer,
    notifyTaskReply,
    get busy(): boolean {
      return busyNow;
    },
  } as unknown as AgentRunner;
  return { runner, spies: { executeTask, steer, notifyTaskReply, setBusy: (b) => { busyNow = b; } } };
}

/** 构造 InternalEvent 形状（routeEvent 消费的最小闭包） */
function mkEvent(
  type: string,
  content: Record<string, unknown>,
  roomId: string,
  sender = 'agent-inst-sub',
): Parameters<RouterService['routeEvent']>[0] {
  return {
    getType: () => type,
    getContent: () => content,
    getSender: () => sender,
    getRoomId: () => roomId,
  };
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`).run();
  // R2（安全复审）：fail-closed 身份校验需要真实成员行——PM 'agent-pm-01' → inst-pm，
  // 子 'agent-inst-sub' → inst-sub（dispatch 事件 sender 用 PM 身份，task_reply 用子身份）
  for (const [inst, uid] of [['inst-pm', 'agent-pm-01'], ['inst-sub', 'agent-inst-sub']] as const) {
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
          default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
       VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', 'm', 1)`,
    ).run(inst, inst, inst);
    db.prepare(
      `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
       VALUES (?, 'ws', ?, ?)`,
    ).run(inst, inst, uid);
  }
  const sess = insertSession({ workspaceId: 'ws', title: 'delivery' });
  sessChatId = sess.id;
  __resetDispatchRegistryForTest();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('followup 终态自动送达', () => {
  it('PM 空闲 → 注入唤醒：dispatch-result 行落库（taskId=链 ID）+ routeUserChat(systemKickoff) 同流 id', async () => {
    dispatchRegistry.register({
      taskId: 'T-fu-1',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
      pmStreamSessionId: 'ss-pm',
      isFollowupRound: true,
    });
    const { runner, spies } = mkRunner(false);
    const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });

    await svc.routeEvent(
      mkEvent('io.momo-studio.task_reply', {
        task_id: 'T-fu-1',
        status: 'completed',
        body: '追问的完整答复',
        tool_calls_used: 5,
        reply_to: 'inst-pm',
      }, sessChatId),
      'owner',
      null,
      'inst-pm',
    );

    // 唤醒发生：PM executeTask 收到自动送达输入
    expect(spies.executeTask).toHaveBeenCalledTimes(1);
    const task = spies.executeTask.mock.calls[0]![0] as {
      body: string; streamSessionId: string; assignmentId: string;
    };
    expect(task.body).toContain('【dispatch 回执自动送达】');
    expect(task.body).toContain('T-fu-1');
    expect(task.body).toContain('追问的完整答复');
    expect(task.body).toContain('已完成');
    expect(task.body).toContain('dispatch_followup');
    expect(task.streamSessionId.length).toBeGreaterThan(0);

    // 消息行已落库：sender=owner + taskId=链 ID（进链历史，后续 followup 重建聚合）
    // + streamSessionId 与唤醒流同源（单点生成沿线共享——boundary-rules 铁律 1）
    const rows = listMessagesBySession(sessChatId).filter((r) => r.taskId === 'T-fu-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sender).toBe('owner');
    expect(rows[0]?.body).toContain('追问的完整答复');
    expect(rows[0]?.streamSessionId).toBe(task.streamSessionId);
  });

  it('PM 忙碌 → 不打扰在途回合；onPmIdle 边沿补投', async () => {
    dispatchRegistry.register({
      taskId: 'T-fu-2',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
      isFollowupRound: true,
    });
    const { runner, spies } = mkRunner(true); // busy
    const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });

    await svc.routeEvent(
      mkEvent('io.momo-studio.task_reply', {
        task_id: 'T-fu-2', status: 'failed', body: '执行失败详情', reply_to: 'inst-pm',
      }, sessChatId),
      'owner',
      null,
      'inst-pm',
    );
    expect(spies.executeTask).not.toHaveBeenCalled();

    // PM 回合结束（busy 归零）→ AgentRunner onIdle 边沿 → 补投
    spies.setBusy(false);
    svc.onPmIdle('inst-pm');
    expect(spies.executeTask).toHaveBeenCalledTimes(1);
    const body = (spies.executeTask.mock.calls[0]![0] as { body: string }).body;
    expect(body).toContain('已失败');
    expect(body).toContain('执行失败详情');
  });
});

describe('非 followup 链投递边界', () => {
  it('bg/sync 链：未经历空闲快照 → 终态不投递（回合内 gather 消费模型）', async () => {
    dispatchRegistry.register({
      taskId: 'T-bg-1',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
      isFollowupRound: false,
    });
    const { runner, spies } = mkRunner(false);
    const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });

    await svc.routeEvent(
      mkEvent('io.momo-studio.task_reply', {
        task_id: 'T-bg-1', status: 'completed', body: 'bg 结果', reply_to: 'inst-pm',
      }, sessChatId),
      'owner',
      null,
      'inst-pm',
    );
    expect(spies.executeTask).not.toHaveBeenCalled();
  });

  it('链在途期间 PM 回合结束（markPmIdle）→ 迟到终态投递（bg 挂起不丢失）', async () => {
    dispatchRegistry.register({
      taskId: 'T-bg-2',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
      isFollowupRound: false,
    });
    const { runner, spies } = mkRunner(false);
    const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });

    // PM 结束回合时链仍在途（gather 超时 pending → PM 收尾）→ awaitWake 快照
    svc.onPmIdle('inst-pm');
    // 子 agent 随后完成 → 自动送达
    await svc.routeEvent(
      mkEvent('io.momo-studio.task_reply', {
        task_id: 'T-bg-2', status: 'completed', body: '迟到但没丢', reply_to: 'inst-pm',
      }, sessChatId),
      'owner',
      null,
      'inst-pm',
    );
    expect(spies.executeTask).toHaveBeenCalledTimes(1);
    expect((spies.executeTask.mock.calls[0]![0] as { body: string }).body).toContain('迟到但没丢');
  });

  it('in_progress 心跳：registry 续命、不触发任何投递', async () => {
    dispatchRegistry.register({
      taskId: 'T-hb',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
      isFollowupRound: true,
    });
    const { runner, spies } = mkRunner(false);
    const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });

    const before = dispatchRegistry.get('T-hb')?.lastHeartbeatAt;
    await svc.routeEvent(
      mkEvent('io.momo-studio.task_reply', {
        task_id: 'T-hb', status: 'in_progress', body: '子任务运行中', reply_to: 'inst-pm',
      }, sessChatId),
      'owner',
      null,
      'inst-pm',
    );
    expect(spies.executeTask).not.toHaveBeenCalled();
    expect(dispatchRegistry.get('T-hb')?.status).toBe('in_flight');
    expect(dispatchRegistry.get('T-hb')?.lastHeartbeatAt).toBeGreaterThanOrEqual(before ?? 0);
  });
});

describe('routeDispatch 重复轮拒绝', () => {
  it('同链在途再次派发 → 拒绝（不重复 executeTask）+ steer 提示 PM', async () => {
    const { runner: subRunner, spies: subSpies } = mkRunner(false);
    const { runner: pmRunner, spies: pmSpies } = mkRunner(false);
    const svc = new RouterService({
      runners: new Map([['inst-sub', subRunner], ['inst-pm', pmRunner]]),
    });

    const dispatchContent = {
      body: '任务', task_id: 'T-dup', dispatch_from: 'inst-pm', dispatch_to: 'inst-sub',
      tool_stream_session_id: 'ss-pm-cur',
    };
    await svc.routeEvent(mkEvent('io.momo-studio.dispatch', dispatchContent, sessChatId, 'agent-pm-01'), 'owner', null, 'inst-sub');
    await svc.routeEvent(mkEvent('io.momo-studio.dispatch', dispatchContent, sessChatId, 'agent-pm-01'), 'owner', null, 'inst-sub');

    // 子 agent 只收到一次派发；重复轮被注册表拒绝
    expect(subSpies.executeTask).toHaveBeenCalledTimes(1);
    // 拒绝不静默：PM 回合内经 steer 收到系统提示
    expect(pmSpies.steer).toHaveBeenCalledTimes(1);
    const steered = pmSpies.steer.mock.calls[0] as unknown as [string, string];
    expect(steered[0]).toBe('ss-pm-cur');
    expect(steered[1]).toContain('T-dup');
    expect(steered[1]).toContain('自动送达');
  });

  it('B3 回归锁：taskId 含路径穿越/非法字符 → 丢弃（不注册不派发）', async () => {
    const { runner: subRunner, spies: subSpies } = mkRunner(false);
    const svc = new RouterService({ runners: new Map([['inst-sub', subRunner]]) });

    for (const evil of ['../../etc/evil', 'a/b', 'x'.repeat(65)]) {
      await svc.routeEvent(
        mkEvent('io.momo-studio.dispatch', {
          body: '任务', task_id: evil, dispatch_from: 'inst-pm', dispatch_to: 'inst-sub',
        }, sessChatId, 'agent-pm-01'),
        'owner',
        null,
        'inst-sub',
      );
    }
    expect(subSpies.executeTask).not.toHaveBeenCalled();
    expect(dispatchRegistry.get('../../etc/evil')).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B6（质量 review）：投递串行化——一回合一条，第二条等第一条完成后投递。
// ══════════════════════════════════════════════════════════════════════════

describe('B6 投递串行化（一回合一条）', () => {
  it('两条 followup 链同时 settle → 第一条投递后 PM 占线，第二条等空闲边沿再投', async () => {
    for (const id of ['T-ser-1', 'T-ser-2']) {
      dispatchRegistry.register({
        taskId: id,
        pmAssignmentId: 'inst-pm',
        subAssignmentId: 'inst-sub',
        sessionId: sessChatId,
        isFollowupRound: true,
      });
    }
    // 挂起式 executeTask：投递发起后 PM 变 busy，手动释放
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const busyRef = { value: false };
    const executeTask = vi.fn(async (t: { streamSessionId: string }) => {
      busyRef.value = true;
      await gate;
      return { streamSessionId: t.streamSessionId };
    });
    const runner = {
      executeTask,
      steer: vi.fn(),
      notifyTaskReply: vi.fn(async (): Promise<void> => undefined),
      get busy(): boolean { return busyRef.value; },
    } as unknown as AgentRunner;
    const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });

    // 两条链先后 settle（PM 空闲）——第一条开始投递（executeTask 挂起、PM busy）
    await svc.routeEvent(
      mkEvent('io.momo-studio.task_reply', { task_id: 'T-ser-1', status: 'completed', body: '一', reply_to: 'inst-pm' }, sessChatId),
      'owner', null, 'inst-pm',
    );
    await svc.routeEvent(
      mkEvent('io.momo-studio.task_reply', { task_id: 'T-ser-2', status: 'completed', body: '二', reply_to: 'inst-pm' }, sessChatId),
      'owner', null, 'inst-pm',
    );
    await vi.waitFor(() => { expect(executeTask).toHaveBeenCalledTimes(1); });
    // 给串行循环一个微任务窗口确认没有第二条并发投递
    await new Promise((r) => setTimeout(r, 20));
    expect(executeTask).toHaveBeenCalledTimes(1);

    // 回合结束（释放 + 空闲）→ 第二条在下一个 idle 边沿投递
    busyRef.value = false;
    release();
    await gate;
    svc.onPmIdle('inst-pm');
    await vi.waitFor(() => { expect(executeTask).toHaveBeenCalledTimes(2); });
    const bodies = executeTask.mock.calls.map((c) => (c[0] as unknown as { body: string }).body);
    expect(bodies[0]).toContain('一');
    expect(bodies[1]).toContain('二');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B4（质量 review）：强制退出补投 + 复用前补投。
// ══════════════════════════════════════════════════════════════════════════

describe('B4 强制退出补投 + 复用前补投', () => {
  it('done-未投递的 bg 链：正常收尾 onPmIdle 不补投；forcedExit=true 补投', async () => {
    dispatchRegistry.register({
      taskId: 'T-forced-1',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
      isFollowupRound: false,
    });
    // PM 回合内翻转（未 gather 即回合结束）→ done + 未投递 + 无 awaitWake
    dispatchRegistry.settle('T-forced-1', 'completed', '回合内完成的结果', 2);

    const { runner, spies } = mkRunner(false);
    const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });

    // 正常收尾：不补投（gather 契约）
    svc.onPmIdle('inst-pm');
    expect(spies.executeTask).not.toHaveBeenCalled();

    // 强制截断（预算/中断/崩溃）：补投
    svc.onPmIdle('inst-pm', true);
    await vi.waitFor(() => { expect(spies.executeTask).toHaveBeenCalledTimes(1); });
    expect((spies.executeTask.mock.calls[0]![0] as { body: string }).body).toContain('回合内完成的结果');
  });

  it('复用 done-未投递链（routeDispatch 前置补投）→ 上一轮结果经投递路径送达', async () => {
    dispatchRegistry.register({
      taskId: 'T-reuse-1',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
      isFollowupRound: false,
    });
    dispatchRegistry.settle('T-reuse-1', 'completed', '上一轮未投递的结果', 1);

    const { runner: subRunner, spies: subSpies } = mkRunner(false);
    const { runner: pmRunner, spies: pmSpies } = mkRunner(false);
    const svc = new RouterService({
      runners: new Map([['inst-sub', subRunner], ['inst-pm', pmRunner]]),
    });

    // 新一轮派发复用该链 → 前置补投：PM（idle）收到上一轮结果 + 新轮正常派发
    await svc.routeEvent(
      mkEvent('io.momo-studio.dispatch', {
        body: '新一轮', task_id: 'T-reuse-1', dispatch_from: 'inst-pm', dispatch_to: 'inst-sub',
      }, sessChatId, 'agent-pm-01'),
      'owner', null, 'inst-sub',
    );
    expect(subSpies.executeTask).toHaveBeenCalledTimes(1); // 新轮派发
    await vi.waitFor(() => { expect(pmSpies.executeTask).toHaveBeenCalledTimes(1); }); // 上一轮补投
    expect((pmSpies.executeTask.mock.calls[0]![0] as unknown as { body: string }).body).toContain('上一轮未投递的结果');
    // 链已复位为新一轮在途
    expect(dispatchRegistry.get('T-reuse-1')?.status).toBe('in_flight');
    expect(dispatchRegistry.get('T-reuse-1')?.round).toBe(2);
  });

  it('R3 回归锁：PM 忙碌时复用链 → 补投挂起不并发投递；idle 边沿送达（串行化不绕过）', async () => {
    dispatchRegistry.register({
      taskId: 'T-reuse-busy',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
      isFollowupRound: false,
    });
    dispatchRegistry.settle('T-reuse-busy', 'completed', '忙碌期补投的结果', 1);

    const { runner: subRunner } = mkRunner(false);
    const { runner: pmRunner, spies: pmSpies } = mkRunner(true); // PM 在回合中
    const setBusy = pmSpies.setBusy;
    const svc = new RouterService({
      runners: new Map([['inst-sub', subRunner], ['inst-pm', pmRunner]]),
    });

    await svc.routeEvent(
      mkEvent('io.momo-studio.dispatch', {
        body: '新轮', task_id: 'T-reuse-busy', dispatch_from: 'inst-pm', dispatch_to: 'inst-sub',
      }, sessChatId, 'agent-pm-01'),
      'owner', null, 'inst-sub',
    );
    // busy 门生效：补投不在 PM 回合中并发拉起第二条顶层流
    expect(pmSpies.executeTask).not.toHaveBeenCalled();

    // 回合结束 → idle 边沿 → 补投送达
    setBusy(false);
    svc.onPmIdle('inst-pm');
    await vi.waitFor(() => { expect(pmSpies.executeTask).toHaveBeenCalledTimes(1); });
    expect((pmSpies.executeTask.mock.calls[0]![0] as unknown as { body: string }).body).toContain('忙碌期补投的结果');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// R2（安全复审）：fail-closed 身份校验——reject 状态（会话不存在/非成员/
// 身份不符）一律丢弃，仅环境性 DB 失败降级放行。
// ══════════════════════════════════════════════════════════════════════════

describe('R2 fail-closed 身份校验', () => {
  it('sender 反查成功但 ≠ dispatch_from（跨身份冒充）→ 丢弃（不注册不派发）', async () => {
    const { runner: subRunner, spies: subSpies } = mkRunner(false);
    const svc = new RouterService({ runners: new Map([['inst-sub', subRunner]]) });

    await svc.routeEvent(
      // sender 'agent-inst-sub'（默认）反查 inst-sub，dispatch_from 冒充 inst-pm
      mkEvent('io.momo-studio.dispatch', {
        body: '伪造派发', task_id: 'T-spoof-1', dispatch_from: 'inst-pm', dispatch_to: 'inst-sub',
      }, sessChatId),
      'owner', null, 'inst-sub',
    );
    expect(subSpies.executeTask).not.toHaveBeenCalled();
    expect(dispatchRegistry.get('T-spoof-1')).toBeUndefined();
  });

  it('envelope sessionId 指向不存在会话（攻击者可安排的 reject 态）→ 丢弃', async () => {
    const { runner: subRunner, spies: subSpies } = mkRunner(false);
    const svc = new RouterService({ runners: new Map([['inst-sub', subRunner]]) });

    await svc.routeEvent(
      mkEvent('io.momo-studio.dispatch', {
        body: '幽灵会话', task_id: 'T-spoof-2', dispatch_from: 'inst-pm', dispatch_to: 'inst-sub',
      }, 'sess-ghost-不存在', 'agent-pm-01'),
      'owner', null, 'inst-sub',
    );
    expect(subSpies.executeTask).not.toHaveBeenCalled();
    expect(dispatchRegistry.get('T-spoof-2')).toBeUndefined();
  });

  it('sender 非会话 workspace 成员（跨 workspace 攻击面）→ 丢弃', async () => {
    const { runner: subRunner, spies: subSpies } = mkRunner(false);
    const svc = new RouterService({ runners: new Map([['inst-sub', subRunner]]) });

    // 'agent-ghost-99' 未插入 workspace_agent_members → 反查落空 → reject
    await svc.routeEvent(
      mkEvent('io.momo-studio.dispatch', {
        body: '外来者', task_id: 'T-spoof-3', dispatch_from: 'inst-pm', dispatch_to: 'inst-sub',
      }, sessChatId, 'agent-ghost-99'),
      'owner', null, 'inst-sub',
    );
    expect(subSpies.executeTask).not.toHaveBeenCalled();
  });

  it('第三方子进程 settle 他人链（reject：伪造 sessionId 使反查落空）→ 忽略，链保持 in_flight；正身回执正常 settle', async () => {
    dispatchRegistry.register({
      taskId: 'T-hijack-1',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
      isFollowupRound: true,
    });
    const { runner, spies } = mkRunner(false);
    const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });

    // 攻击形态：伪造 envelope sessionId（反查落空 → reject）+ 他人链 taskId 终态回执
    await svc.routeEvent(
      mkEvent('io.momo-studio.task_reply', {
        task_id: 'T-hijack-1', status: 'completed', body: '伪造结果', reply_to: 'inst-pm',
      }, 'sess-ghost-attack', 'agent-attacker'),
      'owner', null, 'inst-pm',
    );
    expect(dispatchRegistry.get('T-hijack-1')?.status).toBe('in_flight'); // settle 被忽略
    expect(spies.executeTask).not.toHaveBeenCalled(); // 无注入唤醒

    // 正身回执（合法 sender + 真实会话）→ settle 正常 + followup 恒投递
    await svc.routeEvent(
      mkEvent('io.momo-studio.task_reply', {
        task_id: 'T-hijack-1', status: 'completed', body: '真实结果', reply_to: 'inst-pm',
      }, sessChatId),
      'owner', null, 'inst-pm',
    );
    expect(dispatchRegistry.get('T-hijack-1')?.status).toBe('done');
    await vi.waitFor(() => { expect(spies.executeTask).toHaveBeenCalledTimes(1); });
  });
});
