// electron/tests/task/conflict-detector.test.ts
//
// 冲突触发检测器测试（I3 修复）。
//
// 检测逻辑：用户在 execution_room 内发消息，消息含 #T-xxx mention，
// 且当前房间有 in_progress 任务、mentioned task 与当前任务不同 → 冲突。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectConflict } from '../../src/main/task/conflict-detector';
import type { TaskRow } from '../../src/main/storage/tasks/repo';

function mkTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'T-default',
    workspaceId: 'ws-1',
    title: 'task',
    description: '',
    status: 'in_progress',
    sourceRoomId: null,
    sourceMessageId: null,
    creatorUserId: '@owner:home',
    executionRoomId: '!room:home',
    assigneeAgentId: null,
    priority: 0,
    scheduledAt: null,
    recurrenceRule: null,
    deadlineAt: null,
    queuePosition: null,
    runtimeInstanceId: null,
    estimatedTokens: null,
    actualTokens: null,
    toolCallsUsed: 0,
    errorMessage: null,
    sourceNodeId: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe('detectConflict', () => {
  const deps = {
    findInProgressTaskByRoom: vi.fn(),
    getTask: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('房间有 in_progress 任务 + 消息 mention 另一个存在的任务 → 检测到冲突', () => {
    const currentTask = mkTask({ id: 'T-001', executionRoomId: '!room:home' });
    const mentionedTask = mkTask({ id: 'T-002', status: 'assigned' });
    deps.findInProgressTaskByRoom.mockReturnValue(currentTask);
    deps.getTask.mockReturnValue(mentionedTask);

    const result = detectConflict('!room:home', '帮我做 #T-002 这个任务', deps);

    expect(result).toEqual({
      newTaskId: 'T-002',
      currentTaskId: 'T-001',
      currentRoomId: '!room:home',
    });
  });

  it('房间无 in_progress 任务 → 无冲突', () => {
    deps.findInProgressTaskByRoom.mockReturnValue(null);

    const result = detectConflict('!room:home', '看看 #T-002', deps);

    expect(result).toBeNull();
  });

  it('消息无 task mention → 无冲突', () => {
    const currentTask = mkTask({ id: 'T-001' });
    deps.findInProgressTaskByRoom.mockReturnValue(currentTask);

    const result = detectConflict('!room:home', '普通消息没有 mention', deps);

    expect(result).toBeNull();
  });

  it('mention 的任务与当前 in_progress 任务相同 → 无冲突', () => {
    const currentTask = mkTask({ id: 'T-001' });
    deps.findInProgressTaskByRoom.mockReturnValue(currentTask);
    deps.getTask.mockReturnValue(currentTask);

    const result = detectConflict('!room:home', '讨论 #T-001', deps);

    expect(result).toBeNull();
  });

  it('mention 的任务在 DB 不存在（无法解析）→ 无冲突', () => {
    const currentTask = mkTask({ id: 'T-001' });
    deps.findInProgressTaskByRoom.mockReturnValue(currentTask);
    deps.getTask.mockReturnValue(null);

    const result = detectConflict('!room:home', '看看 #T-999', deps);

    expect(result).toBeNull();
  });

  it('消息 mention 多个任务 → 取第一个可解析且不同的', () => {
    const currentTask = mkTask({ id: 'T-001' });
    const task3 = mkTask({ id: 'T-003', status: 'draft' });
    deps.findInProgressTaskByRoom.mockReturnValue(currentTask);
    deps.getTask.mockImplementation((id: string) => {
      if (id === 'T-001') return currentTask;
      if (id === 'T-003') return task3;
      return null;
    });

    const result = detectConflict('!room:home', '#T-001 和 #T-003', deps);

    expect(result).toEqual({
      newTaskId: 'T-003',
      currentTaskId: 'T-001',
      currentRoomId: '!room:home',
    });
  });

  it('邮箱 / markdown 标题不误识别为 task mention', () => {
    const currentTask = mkTask({ id: 'T-001' });
    deps.findInProgressTaskByRoom.mockReturnValue(currentTask);

    const result = detectConflict('!room:home', '联系 a@b.com 或 # 标题', deps);

    expect(result).toBeNull();
  });
});
