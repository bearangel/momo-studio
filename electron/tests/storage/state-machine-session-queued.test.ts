// 会话车道（v2.3 spec §3）：session_queued 状态机转换锁
import { describe, expect, it } from 'vitest';
import { canTransition, isTerminal } from '../../src/main/storage/tasks/state-machine';

describe('state-machine session_queued', () => {
  it('assigned → session_queued 合法（executor 放行时车道被占）', () => {
    expect(canTransition('assigned', 'session_queued')).toBe(true);
  });

  it('session_queued → in_progress / failed / cancelled 合法', () => {
    expect(canTransition('session_queued', 'in_progress')).toBe(true);
    expect(canTransition('session_queued', 'failed')).toBe(true);
    expect(canTransition('session_queued', 'cancelled')).toBe(true);
  });

  it('session_queued → completed / paused / assigned 非法（未执行不可完成、无暂停语义、不可回退）', () => {
    expect(canTransition('session_queued', 'completed')).toBe(false);
    expect(canTransition('session_queued', 'paused')).toBe(false);
    expect(canTransition('session_queued', 'assigned')).toBe(false);
  });

  it('session_queued 非终态', () => {
    expect(isTerminal('session_queued')).toBe(false);
  });
});
