// 看板列契约单源测试(看板重构 Task 3；v2 生命周期 Task 8 扩七列)。
// 锁死:七列对十一状态不重不漏、columnOf 归列、canDropIntoColumn 语义表关键格
// (含 v2 新列 waiting/review 的禁投规则)。
import { describe, it, expect } from 'vitest';
import { BOARD_COLUMNS, columnOf, canDropIntoColumn, type TaskStatus } from './board-columns';

describe('BOARD_COLUMNS 契约', () => {
  it('七列全覆盖十一状态且不重不漏', () => {
    const all = BOARD_COLUMNS.flatMap((c) => c.statuses).sort();
    expect(all).toEqual([
      'assigned','cancelled','completed','draft','failed','in_progress','paused','pending',
      'session_queued','submitted','waiting_human',
    ].sort());
  });
  it('columnOf 按状态归列', () => {
    expect(columnOf('draft')).toBe('backlog');
    expect(columnOf('session_queued')).toBe('assigned');
    expect(columnOf('paused')).toBe('active');
    expect(columnOf('waiting_human')).toBe('waiting');
    expect(columnOf('submitted')).toBe('review');
    expect(columnOf('completed')).toBe('done');
    expect(columnOf('failed')).toBe('closed');
  });
  it('columnOf 未知状态抛错(错误路径)', () => {
    expect(() => columnOf('bogus' as TaskStatus)).toThrow(/未知任务状态/);
  });
  it('canDropIntoColumn 与语义表一致(抽验关键格)', () => {
    const s = (x: string) => x as TaskStatus;
    expect(canDropIntoColumn(s('completed'), 'active')).toBe(false); // 终态锁死
    expect(canDropIntoColumn(s('in_progress'), 'backlog')).toBe(false); // 待办只出不进
    expect(canDropIntoColumn(s('assigned'), 'active')).toBe(true);   // start 通道
    expect(canDropIntoColumn(s('paused'), 'active')).toBe(true);     // resume 通道
    expect(canDropIntoColumn(s('draft'), 'assigned')).toBe(true);    // 指派
    expect(canDropIntoColumn(s('pending'), 'active')).toBe(false);   // 不可跳进
    // v2 新列关键格：
    expect(canDropIntoColumn(s('in_progress'), 'waiting')).toBe(false);  // 等待中系统驱动
    expect(canDropIntoColumn(s('waiting_human'), 'waiting')).toBe(true); // 同列恒可
    expect(canDropIntoColumn(s('in_progress'), 'review')).toBe(true);    // 提交验收
    expect(canDropIntoColumn(s('in_progress'), 'done')).toBe(true);      // 一步提交+验收
    expect(canDropIntoColumn(s('submitted'), 'done')).toBe(true);        // 验收通过
    expect(canDropIntoColumn(s('submitted'), 'assigned')).toBe(true);    // 打回
    expect(canDropIntoColumn(s('paused'), 'done')).toBe(false);          // v2:完成必经验收
  });
});
