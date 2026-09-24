// electron/tests/agent/dispatch-registry.test.ts
//
// v2.9 事件驱动 dispatch（spec 2026-09-24）：主进程 DispatchRegistry 单元测试。
// 纯逻辑模块 + fake clock——覆盖：
//   1. register：首注册 / 同链在途重复拒绝 / settle 后复用（round+1、状态重置）
//   2. heartbeat：仅 in_flight 链续命；settled / 未知链幂等 false
//   3. settle：completed / failed / needs_input（归 failed）；迟到回执幂等忽略
//   4. cancel：在途 → cancelled；终态幂等；cancelled 恒不投递
//   5. markPmIdle + takeDeliverable：awaitWake 快照 / followup 恒投递 /
//      delivered 一次性 take / 非 followup 未快照不投递
//   6. sweepDead：阈值内不误杀；超阈值判死（fake clock 推进）
//   7. settled 容量驱逐（CHAIN_SETTLED_CAP）：最旧 settled 逐出、in_flight 永不逐出
import { describe, it, expect } from 'vitest';
import {
  DispatchRegistry,
  HEARTBEAT_DEAD_THRESHOLD_MS,
  CHAIN_SETTLED_CAP,
} from '../../src/main/agent/dispatch-registry';

/** fake clock：手动推进的毫秒计数器 */
function mkClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function mkRegistry(start = 1_000_000): { reg: DispatchRegistry; clock: ReturnType<typeof mkClock> } {
  const clock = mkClock(start);
  return { reg: new DispatchRegistry({ now: clock.now }), clock };
}

const CHAIN_INPUT = {
  taskId: 'T-1',
  pmAssignmentId: 'inst-pm',
  subAssignmentId: 'inst-sub',
  sessionId: 'sess-1',
  isFollowupRound: false,
} as const;

describe('DispatchRegistry register', () => {
  it('首注册 → in_flight、round=1、lastHeartbeatAt=startedAt', () => {
    const { reg } = mkRegistry();
    expect(reg.register({ ...CHAIN_INPUT })).toBe(true);
    const h = reg.get('T-1');
    expect(h?.status).toBe('in_flight');
    expect(h?.round).toBe(1);
    expect(h?.lastHeartbeatAt).toBe(h?.startedAt);
  });

  it('同链在途重复注册 → false（重复轮拒绝）；settle 后复用 → true 且 round+1、状态重置', () => {
    const { reg } = mkRegistry();
    reg.register({ ...CHAIN_INPUT });
    expect(reg.register({ ...CHAIN_INPUT, isFollowupRound: true })).toBe(false);

    reg.settle('T-1', 'completed', '答', 3);
    expect(reg.register({ ...CHAIN_INPUT, isFollowupRound: true })).toBe(true);
    const h = reg.get('T-1');
    expect(h?.status).toBe('in_flight');
    expect(h?.round).toBe(2);
    expect(h?.isFollowupRound).toBe(true);
    expect(h?.body).toBeUndefined();
    expect(h?.delivered).toBe(false);
    expect(h?.awaitWake).toBe(false);
  });
});

describe('DispatchRegistry heartbeat / settle / cancel', () => {
  it('heartbeat 仅 in_flight 生效；推进时钟后 lastHeartbeatAt 更新', () => {
    const { reg, clock } = mkRegistry();
    reg.register({ ...CHAIN_INPUT });
    clock.advance(30_000);
    expect(reg.heartbeat('T-1')).toBe(true);
    expect(reg.get('T-1')?.lastHeartbeatAt).toBe(1_030_000);

    reg.settle('T-1', 'completed', '答', 0);
    expect(reg.heartbeat('T-1')).toBe(false);
    expect(reg.heartbeat('T-unknown')).toBe(false);
  });

  it('settle：needs_input 归 failed outcome；迟到回执幂等忽略（终态不覆盖）', () => {
    const { reg } = mkRegistry();
    reg.register({ ...CHAIN_INPUT });
    const h1 = reg.settle('T-1', 'needs_input', '需要输入', 2);
    expect(h1?.outcome).toBe('failed');
    expect(h1?.body).toBe('需要输入');
    expect(h1?.toolCallsUsed).toBe(2);

    const h2 = reg.settle('T-1', 'completed', '迟到', 9);
    expect(h2).toBeUndefined();
    expect(reg.get('T-1')?.outcome).toBe('failed');
    expect(reg.get('T-1')?.body).toBe('需要输入');
  });

  it('cancel：在途 → cancelled；已终态幂等 undefined', () => {
    const { reg } = mkRegistry();
    reg.register({ ...CHAIN_INPUT });
    expect(reg.cancel('T-1')?.status).toBe('cancelled');
    expect(reg.cancel('T-1')).toBeUndefined();
    expect(reg.settle('T-1', 'completed', '迟到', 0)).toBeUndefined();
  });
});

describe('DispatchRegistry 投递语义（markPmIdle / takeDeliverable）', () => {
  it('非 followup 链：PM 未空闲快照前 settle → 不投递（回合内 gather 消费模型）', () => {
    const { reg } = mkRegistry();
    reg.register({ ...CHAIN_INPUT });
    reg.settle('T-1', 'completed', '答', 1);
    expect(reg.takeDeliverable('inst-pm')).toEqual([]);
  });

  it('非 followup 链：PM 空闲快照后 settle → 投递一次（delivered 幂等）', () => {
    const { reg } = mkRegistry();
    reg.register({ ...CHAIN_INPUT });
    reg.markPmIdle('inst-pm');
    expect(reg.get('T-1')?.awaitWake).toBe(true);
    reg.settle('T-1', 'completed', '答', 1);
    const got = reg.takeDeliverable('inst-pm');
    expect(got).toHaveLength(1);
    expect(got[0]?.taskId).toBe('T-1');
    // take 语义：第二次取不再返回
    expect(reg.takeDeliverable('inst-pm')).toEqual([]);
  });

  it('followup 轮恒投递（无需空闲快照）；cancelled 恒不投递', () => {
    const { reg } = mkRegistry();
    reg.register({ ...CHAIN_INPUT, isFollowupRound: true });
    reg.settle('T-1', 'completed', '追答', 4);
    expect(reg.takeDeliverable('inst-pm')).toHaveLength(1);

    reg.register({ taskId: 'T-2', pmAssignmentId: 'inst-pm', subAssignmentId: 'inst-sub', sessionId: 'sess-1', isFollowupRound: true });
    reg.cancel('T-2');
    expect(reg.takeDeliverable('inst-pm')).toEqual([]);
  });

  it('markPmIdle 只影响该 PM 的链', () => {
    const { reg } = mkRegistry();
    reg.register({ ...CHAIN_INPUT });
    reg.register({ taskId: 'T-o', pmAssignmentId: 'inst-other', subAssignmentId: 'inst-sub', sessionId: 'sess-1', isFollowupRound: false });
    reg.markPmIdle('inst-other');
    expect(reg.get('T-1')?.awaitWake).toBe(false);
    expect(reg.get('T-o')?.awaitWake).toBe(true);
  });
});

describe('DispatchRegistry sweepDead（fake clock）', () => {
  it('阈值内不误杀；超阈值判死（outcome=failed + reason 文案）', () => {
    const { reg, clock } = mkRegistry();
    reg.register({ ...CHAIN_INPUT });

    // 恰好等于阈值：不判死（严格大于判死——边界留在安全侧）
    clock.advance(HEARTBEAT_DEAD_THRESHOLD_MS);
    expect(reg.sweepDead()).toEqual([]);

    clock.advance(1);
    const dead = reg.sweepDead();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.taskId).toBe('T-1');
    expect(dead[0]?.pmAssignmentId).toBe('inst-pm');
    expect(dead[0]?.reason).toContain('心跳超时');
    expect(reg.get('T-1')?.outcome).toBe('failed');
  });

  it('心跳续命防误杀：阈值内持续 heartbeat → 永不判死', () => {
    const { reg, clock } = mkRegistry();
    reg.register({ ...CHAIN_INPUT });
    for (let i = 0; i < 10; i++) {
      clock.advance(60_000);
      expect(reg.heartbeat('T-1')).toBe(true);
      expect(reg.sweepDead()).toEqual([]);
    }
  });
});

describe('DispatchRegistry settled 容量驱逐', () => {
  it('settled 超 CHAIN_SETTLED_CAP → 最旧 settled 逐出；in_flight 永不逐出', () => {
    const { reg } = mkRegistry();
    // 先留一条 in_flight（绝不可被驱逐）
    reg.register({ taskId: 'T-keep-inflight', pmAssignmentId: 'inst-pm', subAssignmentId: 'inst-sub', sessionId: 's', isFollowupRound: false });
    // 灌满 CAP+1 条 settled
    for (let i = 0; i <= CHAIN_SETTLED_CAP; i++) {
      const id = `T-settled-${String(i).padStart(3, '0')}`;
      reg.register({ taskId: id, pmAssignmentId: 'inst-pm', subAssignmentId: 'inst-sub', sessionId: 's', isFollowupRound: false });
      reg.settle(id, 'completed', 'x', 0);
    }
    // 最旧一条（T-settled-000）已被逐出；其余与新 settle 可查
    expect(reg.get('T-settled-000')).toBeUndefined();
    expect(reg.get(`T-settled-${String(CHAIN_SETTLED_CAP).padStart(3, '0')}`)).toBeDefined();
    expect(reg.get('T-keep-inflight')?.status).toBe('in_flight');
  });
});
