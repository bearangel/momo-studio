// renderer/src/components/task-board/task-filter.test.ts
//
// applyTaskFilters 纯函数测试（spec §4 / §7.2）：text 命中 title/description、
// text 与 status AND 叠加、空 text 不过滤、大小写、排序保持。
import { describe, it, expect } from 'vitest';
import { applyTaskFilters } from './task-filter';
import type { FilterState } from './TaskFilters';
import type { TaskRow } from '../../ipc/types';

const BASE: FilterState = { status: 'all', assignee: 'all', sort: 'priority', text: '' };

function makeTask(overrides: Partial<TaskRow> & { id: string }): TaskRow {
  return {
    workspaceId: 'ws-1',
    title: '任务',
    description: '',
    status: 'pending',
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'u1',
    executionSessionId: null,
    assigneeAgentId: null,
    targetTeamId: null,
    targetSessionId: null,
    recurrenceParentId: null,
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
    createdAt: 100,
    updatedAt: 100,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe('applyTaskFilters — text 过滤', () => {
  const tasks = [
    makeTask({ id: 'T-1', title: '登录页重构', description: '' }),
    makeTask({ id: 'T-2', title: '日常任务', description: '涉及登录态缓存' }),
    makeTask({ id: 'T-3', title: '无关任务', description: '' }),
  ];

  it('text 命中 title', () => {
    const out = applyTaskFilters(tasks, { ...BASE, text: '登录页' });
    expect(out.map((t) => t.id)).toEqual(['T-1']);
  });

  it('text 命中 description', () => {
    const out = applyTaskFilters(tasks, { ...BASE, text: '缓存' });
    expect(out.map((t) => t.id)).toEqual(['T-2']);
  });

  it('text 大小写不敏感（trim 后匹配）', () => {
    const out = applyTaskFilters(
      [makeTask({ id: 'T-9', title: 'Release' })],
      { ...BASE, text: '  release ' },
    );
    expect(out.map((t) => t.id)).toEqual(['T-9']);
  });

  it('空 text（含纯空白）不过滤', () => {
    const out = applyTaskFilters(tasks, { ...BASE, text: '   ' });
    expect(out).toHaveLength(3);
  });

  it('text 与 status AND 叠加', () => {
    const mixed = [
      makeTask({ id: 'T-1', title: '登录', status: 'pending' }),
      makeTask({ id: 'T-2', title: '登录', status: 'completed' }),
    ];
    const out = applyTaskFilters(mixed, { ...BASE, text: '登录', status: 'completed' });
    expect(out.map((t) => t.id)).toEqual(['T-2']);
  });

  it('无命中返回空数组（空态由 UI 层展示「无匹配任务」）', () => {
    const out = applyTaskFilters(tasks, { ...BASE, text: 'zzz' });
    expect(out).toEqual([]);
  });
});
