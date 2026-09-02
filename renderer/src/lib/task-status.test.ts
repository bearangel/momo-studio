// renderer/src/lib/task-status.test.ts
// 任务状态统一映射测试：覆盖八状态 + tone 映射 + Badge 类同源三组断言
// + dispatch 五态映射 + TaskStatusKey 与 ipc TaskStatus 的类型层派生锁。
import { describe, expect, it } from 'vitest';
import type { TaskStatus } from '../ipc/types';
import { dispatchStatusStyle, taskStatusStyle, type TaskStatusKey } from './task-status';

// 类型层派生锁：TaskStatusKey 与 ipc TaskStatus 是同一类型
const _typeLock: TaskStatusKey = 'draft' as TaskStatus;
void _typeLock;

describe('task-status 统一状态映射', () => {
  it('八状态全覆盖且中文标签唯一', () => {
    const keys: TaskStatusKey[] = [
      'draft', 'pending', 'assigned', 'in_progress',
      'paused', 'completed', 'cancelled', 'failed',
    ];
    const labels = new Set<string>();
    for (const k of keys) {
      const s = taskStatusStyle(k);
      expect(s.label).toBeTruthy();
      expect(s.className).toBeTruthy();
      labels.add(s.label);
    }
    expect(labels.size).toBe(8);
  });

  it('语义 tone 映射符合规范 §3.6', () => {
    expect(taskStatusStyle('draft').tone).toBe('neutral');
    expect(taskStatusStyle('pending').tone).toBe('warning');
    expect(taskStatusStyle('assigned').tone).toBe('accent');
    expect(taskStatusStyle('in_progress').tone).toBe('success');
    expect(taskStatusStyle('paused').tone).toBe('violet');
    expect(taskStatusStyle('completed').tone).toBe('neutral');
    expect(taskStatusStyle('cancelled').tone).toBe('neutral');
    expect(taskStatusStyle('failed').tone).toBe('error');
  });

  it('className 与 Badge tone 类完全同源（不另造调色板）', () => {
    expect(taskStatusStyle('failed').className).toContain('bg-status-error-tint');
    expect(taskStatusStyle('in_progress').className).toContain('bg-status-success-tint');
  });
});

describe('dispatchStatusStyle', () => {
  it('五状态 tone 映射：queued=neutral/executing=warning/completed=success/failed=error/aborted=warning', () => {
    expect(dispatchStatusStyle('queued').tone).toBe('neutral');
    expect(dispatchStatusStyle('executing').tone).toBe('warning');
    expect(dispatchStatusStyle('completed').tone).toBe('success');
    expect(dispatchStatusStyle('failed').tone).toBe('error');
    expect(dispatchStatusStyle('aborted').tone).toBe('warning');
  });
  it('className 与 Badge tone 同源', () => {
    expect(dispatchStatusStyle('failed').className).toContain('bg-status-error-tint');
    expect(dispatchStatusStyle('executing').className).toContain('bg-status-warning-tint');
  });
});
