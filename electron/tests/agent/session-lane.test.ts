// 会话车道注册表（v2.3 spec §4）：注册/清除/占道判定/精确中止
import { beforeEach, describe, expect, it, vi } from 'vitest';

// listTasks 打桩：isLaneOccupied 的 DB 兜底分支可控（保持真实签名形状）
const listTasksMock = vi.fn<[unknown], unknown>((_opts: unknown) => []);
vi.mock('../../src/main/storage/tasks/repo', () => ({
  listTasks: (opts: unknown) => listTasksMock(opts),
}));
// abortStreamBySessionId 打桩：精确中止断言载体（保持真实签名形状）
const abortMock = vi.fn<[string], boolean>((_id: string) => true);
vi.mock('../../src/main/agent/stream-relay', () => ({
  abortStreamBySessionId: (id: string) => abortMock(id),
}));

import {
  registerLane, clearLaneIfMatch, getLane, isLaneOccupied,
  abortTaskStreamByLane, __clearLaneForTest,
} from '../../src/main/agent/session-lane';

const ENTRY_A = { taskId: 'T-1', streamSessionId: 's-a', assignmentId: 'asg-1' };

beforeEach(() => {
  __clearLaneForTest();
  listTasksMock.mockClear().mockReturnValue([]);
  abortMock.mockClear().mockReturnValue(true);
});

describe('session-lane 注册与清除', () => {
  it('registerLane 后 getLane 返回条目；clearLaneIfMatch 匹配 streamSessionId 才清除', () => {
    registerLane('room-1', ENTRY_A);
    expect(getLane('room-1')).toEqual(ENTRY_A);

    // 迟到收尾（流 id 不匹配）不清新注册——abort 回退重派发场景（spec §4.1）
    clearLaneIfMatch('room-1', 's-other');
    expect(getLane('room-1')).toEqual(ENTRY_A);

    clearLaneIfMatch('room-1', 's-a');
    expect(getLane('room-1')).toBeNull();
  });

  it('kickoff 覆盖注册不抛错（车道被手输流占用的竞态窗口，spec §7）', () => {
    registerLane('room-1', ENTRY_A);
    expect(() =>
      registerLane('room-1', { taskId: 'T-2', streamSessionId: 's-b', assignmentId: 'asg-1' }, { kickoff: true }),
    ).not.toThrow();
    expect(getLane('room-1')?.streamSessionId).toBe('s-b');
  });
});

describe('session-lane 占道判定（内存 ∪ DB 兜底，spec §4.2）', () => {
  it('内存有活跃流即占道', () => {
    registerLane('room-1', ENTRY_A);
    expect(isLaneOccupied('room-1')).toBe(true);
  });

  it('内存为空但 DB 有 in_progress 任务行仍占道（重启恢复兜底）', () => {
    listTasksMock.mockImplementation((rawOpts: unknown) => {
      const opts = rawOpts as { executionSessionId?: string; status?: string };
      expect(opts.executionSessionId).toBe('room-1');
      expect(opts.status).toBe('in_progress');
      return [{ id: 'T-old' }];
    });
    expect(isLaneOccupied('room-1')).toBe(true);
  });

  it('两者皆空 → 不占道', () => {
    expect(isLaneOccupied('room-1')).toBe(false);
  });
});

describe('K7-3 精确中止（spec §6）', () => {
  it('按 taskId 反查车道流并 abort——只命中匹配流', () => {
    registerLane('room-1', ENTRY_A);
    registerLane('room-2', { taskId: 'T-9', streamSessionId: 's-c', assignmentId: 'asg-2' });
    const hit = abortTaskStreamByLane('T-1');
    expect(hit).toBe(true);
    expect(abortMock).toHaveBeenCalledTimes(1);
    expect(abortMock).toHaveBeenCalledWith('s-a');
  });

  it('dispatch 子流未注册车道 → 不受影响；无匹配返回 false', () => {
    registerLane('room-1', ENTRY_A);
    expect(abortTaskStreamByLane('T-dispatch-derived')).toBe(false);
    expect(abortMock).not.toHaveBeenCalled();
  });

  it('同会话另一任务的车道流不被误中止（双车道场景）', () => {
    registerLane('room-1', { taskId: 'T-1', streamSessionId: 's-a', assignmentId: 'asg-1' });
    registerLane('room-2', { taskId: 'T-2', streamSessionId: 's-b', assignmentId: 'asg-2' });
    abortTaskStreamByLane('T-2');
    expect(abortMock).toHaveBeenCalledTimes(1);
    expect(abortMock).toHaveBeenCalledWith('s-b'); // 只命中 T-2 的流，s-a 不动
  });
});
