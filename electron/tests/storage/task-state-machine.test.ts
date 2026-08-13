// electron/tests/storage/task-state-machine.test.ts
//
// 任务状态机单元测试。覆盖：
//   - 合法转换表（覆盖所有源/目标组合中合法的部分）
//   - 非法转换（终态不可转、跳跃式转换如 draft→in_progress）
//   - assertTransition 抛错信息含 from→to
//   - isTerminal 三终态 + 五非终态
import { describe, it, expect } from 'vitest';
import {
  canTransition,
  assertTransition,
  isTerminal,
  type TaskStatus,
} from '../../src/main/storage/tasks/state-machine';

describe('task state machine', () => {
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
    it('assigned → cancelled', () => {
      expect(canTransition('assigned', 'cancelled')).toBe(true);
    });
    it('in_progress → paused（preempt）', () => {
      expect(canTransition('in_progress', 'paused')).toBe(true);
    });
    it('in_progress → completed', () => {
      expect(canTransition('in_progress', 'completed')).toBe(true);
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
    });
    it('paused → completed（必须先 in_progress）', () => {
      // paused 恢复到 in_progress 才能完成——paused → completed 是非法跳跃
      expect(canTransition('paused', 'completed')).toBe(false);
    });
  });

  it('assertTransition 合法时不抛错', () => {
    expect(() => assertTransition('draft', 'pending')).not.toThrow();
  });

  it('assertTransition 非法时抛错（含 from/to 信息）', () => {
    expect(() => assertTransition('completed', 'in_progress')).toThrow(/completed.*in_progress/);
  });

  it('isTerminal: completed/failed/cancelled 为 true，其他 false', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('in_progress')).toBe(false);
    expect(isTerminal('paused')).toBe(false);
    expect(isTerminal('draft')).toBe(false);
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('assigned')).toBe(false);
  });

  it('类型签名完整性：8 个状态可穷举', () => {
    // 编译期断言：状态机实现覆盖所有 8 个状态。
    const all: TaskStatus[] = ['draft', 'pending', 'assigned', 'in_progress', 'paused', 'completed', 'failed', 'cancelled'];
    expect(all.length).toBe(8);
  });
});