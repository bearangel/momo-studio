// electron/tests/task/create-status.test.ts
//
// K1 落态决策单源测试（spec 2026-09-30 §4.1）：
//   form（表单路径：看板新建 / 会话内创建按钮 / InlineTaskSuggestion）
//     → 一律 draft——「创建即入队」退役，「启动」是唯一入队动作
//   agent（create_task 工具，用户在会话中已授权）
//     → 有目标 assigned（建即入队；未来 scheduledAt 由 executor 闸门管）
//     → 无目标 undefined（repo insertTask 默认 draft）
// pending 不再产出（迁移 051 退役）。
import { describe, it, expect } from 'vitest';
import { resolveCreateStatus } from '../../src/main/task/create-status';

describe('resolveCreateStatus（K1 落态单源）', () => {
  it('表单路径一律 draft——无论目标/定时（核心行为变化：创建即入队退役）', () => {
    expect(resolveCreateStatus({ hasDelegationTarget: true, scheduledAt: null }, 'form')).toBe('draft');
    expect(
      resolveCreateStatus({ hasDelegationTarget: true, scheduledAt: Date.now() + 3_600_000 }, 'form'),
    ).toBe('draft');
    expect(
      resolveCreateStatus({ hasDelegationTarget: false, scheduledAt: Date.now() + 3_600_000 }, 'form'),
    ).toBe('draft');
    expect(resolveCreateStatus({ hasDelegationTarget: false, scheduledAt: null }, 'form')).toBe('draft');
  });

  it('agent 路径：有目标建即入队 assigned（未来时间由闸门管，不再产 pending）', () => {
    expect(resolveCreateStatus({ hasDelegationTarget: true, scheduledAt: null }, 'agent')).toBe('assigned');
    expect(
      resolveCreateStatus({ hasDelegationTarget: true, scheduledAt: Date.now() + 3_600_000 }, 'agent'),
    ).toBe('assigned');
  });

  it('agent 路径：无目标 undefined（repo 默认 draft）', () => {
    expect(resolveCreateStatus({ hasDelegationTarget: false, scheduledAt: null }, 'agent')).toBeUndefined();
    expect(
      resolveCreateStatus({ hasDelegationTarget: false, scheduledAt: Date.now() }, 'agent'),
    ).toBeUndefined();
  });
});
