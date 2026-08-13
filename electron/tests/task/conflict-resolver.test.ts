// electron/tests/task/conflict-resolver.test.ts
//
// conflict-resolver 纯函数测试（B 子系统 B9）。
//
// resolveConflict 是纯函数：根据 room_settings.conflict_strategy 决定动作。
// 不涉及 DB / Matrix——所有副作用（startTask / transitionTaskStatus）在 IPC handler 层。
//
// 测试覆盖（5 个 it）：5 策略各自返回正确结构
//   1. queue   → { action: 'queue', newTaskId }
//   2. preempt → { action: 'preempt', newTaskId, pausedTaskId: currentTaskId }
//   3. fork    → { action: 'fork', newTaskId, newExecutionRoomId: 以 '!' 开头 }
//   4. reject  → { action: 'reject', reason: 非空字符串 }
//   5. ask     → { action: 'ask' }（让 UI 弹窗，调用方决定后续）
import { describe, it, expect } from 'vitest';
import { resolveConflict, type ConflictStrategy } from '../../src/main/task/conflict-resolver';

function mkCtx(strategy: ConflictStrategy) {
  return {
    newTaskId: 'T-002',
    currentTaskId: 'T-001',
    currentRoomId: '!room:home',
    strategy,
  };
}

describe('conflict-resolver', () => {
  it('strategy=queue → 排队', () => {
    expect(resolveConflict(mkCtx('queue'))).toEqual({ action: 'queue', newTaskId: 'T-002' });
  });

  it('strategy=preempt → 暂停当前 + 启动新', () => {
    expect(resolveConflict(mkCtx('preempt'))).toEqual({
      action: 'preempt',
      newTaskId: 'T-002',
      pausedTaskId: 'T-001',
    });
  });

  it('strategy=fork → 分流（创建新会话）', () => {
    const r = resolveConflict(mkCtx('fork'));
    expect(r.action).toBe('fork');
    if (r.action === 'fork') {
      expect(r.newTaskId).toBe('T-002');
      // 新 room id（Matrix 格式以 '!' 开头）
      expect(r.newExecutionRoomId).toMatch(/^!/);
    }
  });

  it('strategy=reject → 拒绝', () => {
    expect(resolveConflict(mkCtx('reject'))).toEqual({
      action: 'reject',
      reason: expect.any(String),
    });
  });

  it('strategy=ask → 返回 ask（让 UI 弹窗）', () => {
    expect(resolveConflict(mkCtx('ask'))).toEqual({ action: 'ask' });
  });
});
