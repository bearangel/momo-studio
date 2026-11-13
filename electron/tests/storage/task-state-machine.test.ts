// electron/tests/storage/task-state-machine.test.ts
//
// 任务状态机 v2 单元测试（spec 2026-11-13-task-lifecycle-v2 §5.1/§5.2）。覆盖：
//   - 合法转换表 v2（11 态：+waiting_human / submitted）
//   - 语义变更回归锁：in_progress → completed 非法（完成必须经 submitted 验收）
//   - 非法转换（终态不可转、跳跃式转换如 draft→in_progress）
//   - run 状态机（TaskRunStatus 七态 + canTransitionRun 全边）
//   - assertTransition 抛错信息含 from→to
//   - isTerminal 三终态
import { describe, it, expect } from 'vitest';
import {
  canTransition,
  assertTransition,
  isTerminal,
  canTransitionRun,
  type TaskStatus,
  type TaskRunStatus,
} from '../../src/main/storage/tasks/state-machine';

describe('task 状态机 v2', () => {
  it('in_progress → completed 非法（完成必须经 submitted 验收）', () => {
    expect(canTransition('in_progress', 'completed')).toBe(false);
  });
  it('waiting_human 双向与 submitted 出边', () => {
    expect(canTransition('in_progress', 'waiting_human')).toBe(true);
    expect(canTransition('waiting_human', 'in_progress')).toBe(true);
    expect(canTransition('waiting_human', 'paused')).toBe(true);
    expect(canTransition('in_progress', 'submitted')).toBe(true);
    expect(canTransition('submitted', 'completed')).toBe(true);
    expect(canTransition('submitted', 'assigned')).toBe(true);
    expect(canTransition('submitted', 'cancelled')).toBe(true);
    expect(canTransition('submitted', 'failed')).toBe(true);
    expect(canTransition('paused', 'waiting_human')).toBe(true);
  });
  it('run 状态机', () => {
    expect(canTransitionRun('running', 'waiting_human')).toBe(true);
    expect(canTransitionRun('waiting_human', 'running')).toBe(true);
    expect(canTransitionRun('running', 'submitted')).toBe(true);
    expect(canTransitionRun('submitted', 'accepted')).toBe(true);
    expect(canTransitionRun('submitted', 'rejected')).toBe(true);
    expect(canTransitionRun('submitted', 'running')).toBe(false); // 打回=新 run，不是转回
    expect(canTransitionRun('accepted', 'rejected')).toBe(false); // 终态
  });
});

describe('task state machine（存量边保留）', () => {
  describe('合法转换', () => {
    it('draft → pending', () => {
      expect(canTransition('draft', 'pending')).toBe(true);
    });
    it('draft → assigned（直接指派 + 立即启动）', () => {
      expect(canTransition('draft', 'assigned')).toBe(true);
    });
    it('draft → cancelled', () => {
      expect(canTransition('draft', 'cancelled')).toBe(true);
    });
    it('pending → assigned（scheduled_at 到达）', () => {
      expect(canTransition('pending', 'assigned')).toBe(true);
    });
    it('pending → cancelled', () => {
      expect(canTransition('pending', 'cancelled')).toBe(true);
    });
    it('assigned → in_progress（pickup）', () => {
      expect(canTransition('assigned', 'in_progress')).toBe(true);
    });
    it('assigned → session_queued（executor 放行时车道被占）', () => {
      expect(canTransition('assigned', 'session_queued')).toBe(true);
    });
    it('assigned → failed（executor 目标校验失败路径，spec §5.1/§9）', () => {
      expect(canTransition('assigned', 'failed')).toBe(true);
    });
    it('assigned → cancelled', () => {
      expect(canTransition('assigned', 'cancelled')).toBe(true);
    });
    it('session_queued → in_progress（车道空闲放行）', () => {
      expect(canTransition('session_queued', 'in_progress')).toBe(true);
    });
    it('session_queued → failed / cancelled', () => {
      expect(canTransition('session_queued', 'failed')).toBe(true);
      expect(canTransition('session_queued', 'cancelled')).toBe(true);
    });
    it('in_progress → paused（preempt）', () => {
      expect(canTransition('in_progress', 'paused')).toBe(true);
    });
    it('in_progress → failed', () => {
      expect(canTransition('in_progress', 'failed')).toBe(true);
    });
    it('in_progress → cancelled', () => {
      expect(canTransition('in_progress', 'cancelled')).toBe(true);
    });
    it('paused → in_progress（恢复）', () => {
      expect(canTransition('paused', 'in_progress')).toBe(true);
    });
    it('paused → cancelled', () => {
      expect(canTransition('paused', 'cancelled')).toBe(true);
    });
  });

  describe('非法转换', () => {
    it('draft → in_progress（必须先 assigned）', () => {
      expect(canTransition('draft', 'in_progress')).toBe(false);
    });
    it('pending → in_progress（必须先 assigned）', () => {
      expect(canTransition('pending', 'in_progress')).toBe(false);
    });
    it('completed → in_progress（终态）', () => {
      expect(canTransition('completed', 'in_progress')).toBe(false);
    });
    it('failed → in_progress（终态）', () => {
      expect(canTransition('failed', 'in_progress')).toBe(false);
    });
    it('cancelled → in_progress（终态）', () => {
      expect(canTransition('cancelled', 'in_progress')).toBe(false);
    });
    it('completed → 任何（终态不可转出）', () => {
      expect(canTransition('completed', 'draft')).toBe(false);
      expect(canTransition('completed', 'pending')).toBe(false);
      expect(canTransition('completed', 'submitted')).toBe(false);
    });
    it('paused → completed（必须先 in_progress 再 submitted 验收）', () => {
      expect(canTransition('paused', 'completed')).toBe(false);
    });
    it('submitted → in_progress（验收打回走 assigned 重启，不可直回执行）', () => {
      expect(canTransition('submitted', 'in_progress')).toBe(false);
    });
    it('waiting_human → completed（等人不是验收，须先回 in_progress 再 submitted）', () => {
      expect(canTransition('waiting_human', 'completed')).toBe(false);
    });
  });

  it('assertTransition 合法时不抛错', () => {
    expect(() => assertTransition('draft', 'pending')).not.toThrow();
  });

  it('assertTransition 非法时抛错（含 from/to 信息）', () => {
    expect(() => assertTransition('in_progress', 'completed')).toThrow(/in_progress.*completed/);
  });

  it('isTerminal: completed/failed/cancelled 为 true，新增二态为 false', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('in_progress')).toBe(false);
    expect(isTerminal('paused')).toBe(false);
    expect(isTerminal('draft')).toBe(false);
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('assigned')).toBe(false);
    expect(isTerminal('session_queued')).toBe(false);
    expect(isTerminal('waiting_human')).toBe(false);
    expect(isTerminal('submitted')).toBe(false);
  });

  it('类型签名完整性：11 个状态可穷举', () => {
    // 编译期断言：状态机实现覆盖所有 11 个状态。
    const all: TaskStatus[] = [
      'draft',
      'pending',
      'assigned',
      'session_queued',
      'in_progress',
      'waiting_human',
      'submitted',
      'paused',
      'completed',
      'failed',
      'cancelled',
    ];
    expect(all.length).toBe(11);
  });
});

describe('run 状态机全边（spec §5.2）', () => {
  it('running 出边：waiting_human / submitted / failed / cancelled', () => {
    expect(canTransitionRun('running', 'waiting_human')).toBe(true);
    expect(canTransitionRun('running', 'submitted')).toBe(true);
    expect(canTransitionRun('running', 'failed')).toBe(true);
    expect(canTransitionRun('running', 'cancelled')).toBe(true);
  });

  it('waiting_human 出边：running / failed / cancelled', () => {
    expect(canTransitionRun('waiting_human', 'running')).toBe(true);
    expect(canTransitionRun('waiting_human', 'failed')).toBe(true);
    expect(canTransitionRun('waiting_human', 'cancelled')).toBe(true);
    expect(canTransitionRun('waiting_human', 'submitted')).toBe(false);
  });

  it('submitted 出边：accepted / rejected / cancelled / failed', () => {
    expect(canTransitionRun('submitted', 'accepted')).toBe(true);
    expect(canTransitionRun('submitted', 'rejected')).toBe(true);
    expect(canTransitionRun('submitted', 'cancelled')).toBe(true);
    expect(canTransitionRun('submitted', 'failed')).toBe(true);
  });

  it('终态（accepted/rejected/failed/cancelled）不可转出', () => {
    const terminals: TaskRunStatus[] = ['accepted', 'rejected', 'failed', 'cancelled'];
    for (const t of terminals) {
      expect(canTransitionRun(t, 'running')).toBe(false);
      expect(canTransitionRun(t, 'waiting_human')).toBe(false);
      expect(canTransitionRun(t, 'submitted')).toBe(false);
      expect(canTransitionRun(t, 'accepted')).toBe(false);
      expect(canTransitionRun(t, 'rejected')).toBe(false);
      expect(canTransitionRun(t, 'failed')).toBe(false);
      expect(canTransitionRun(t, 'cancelled')).toBe(false);
    }
  });

  it('ACTIVE_TASK_RUN_STATUSES 只含活跃三态（Task 6/9 消费契约）', async () => {
    const { ACTIVE_TASK_RUN_STATUSES } = await import('../../src/main/storage/tasks/state-machine');
    expect(ACTIVE_TASK_RUN_STATUSES).toEqual(['running', 'waiting_human', 'submitted']);
  });
});
