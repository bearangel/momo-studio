// 看板列契约单源测试(看板重构 Task 3)。
// 锁死:五列对九状态不重不漏、columnOf 归列、canDropIntoColumn 语义表关键格。
import { describe, it, expect } from 'vitest';
import { BOARD_COLUMNS, columnOf, canDropIntoColumn, type TaskStatus } from './board-columns';

describe('BOARD_COLUMNS 契约', () => {
  it('五列全覆盖九状态且不重不漏', () => {
    const all = BOARD_COLUMNS.flatMap((c) => c.statuses).sort();
    expect(all).toEqual(['assigned','cancelled','completed','draft','failed','in_progress','paused','pending','session_queued'].sort());
  });
  it('columnOf 按状态归列', () => {
    expect(columnOf('draft')).toBe('backlog');
    expect(columnOf('session_queued')).toBe('assigned');
    expect(columnOf('paused')).toBe('active');
    expect(columnOf('completed')).toBe('done');
    expect(columnOf('failed')).toBe('closed');
  });
  it('canDropIntoColumn 与语义表一致(抽验关键格)', () => {
    const s = (x: string) => x as TaskStatus;
    expect(canDropIntoColumn(s('completed'), 'active')).toBe(false); // 终态锁死
    expect(canDropIntoColumn(s('in_progress'), 'backlog')).toBe(false); // 待办只出不进
    expect(canDropIntoColumn(s('assigned'), 'active')).toBe(true);   // start 通道
    expect(canDropIntoColumn(s('paused'), 'active')).toBe(true);     // resume 通道
    expect(canDropIntoColumn(s('in_progress'), 'done')).toBe(true);  // 确认后完成
    expect(canDropIntoColumn(s('draft'), 'assigned')).toBe(true);    // 指派
    expect(canDropIntoColumn(s('pending'), 'active')).toBe(false);   // 不可跳进
  });
});
