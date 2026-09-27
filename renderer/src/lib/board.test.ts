// renderer/src/lib/board.test.ts
// 看板列组装纯函数测试（看板重构 Task 9）：排序 NULLS-LAST / 泳道切分 / 过滤 / 组色映射。
import { describe, expect, it } from 'vitest';
import type { GroupRow, TaskRow } from '../ipc/types';
import {
  filterBoardTasks,
  groupChipColor,
  groupColorHex,
  groupColorStyle,
  sortColumn,
  splitLanes,
} from './board';

/** 构造最小 TaskRow 测试行（仅本文件关注字段，其余填安全默认值） */
function mkTask(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    workspaceId: 'ws1',
    title: `任务 ${id}`,
    description: '',
    status: 'draft',
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
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    groupId: null,
    boardPosition: null,
    archivedAt: null,
    ...overrides,
  };
}

/** 构造最小 GroupRow 测试行 */
function mkGroup(id: string, overrides: Partial<GroupRow> = {}): GroupRow {
  return {
    id,
    workspaceId: 'ws1',
    name: `组 ${id}`,
    color: null,
    position: 0,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('sortColumn', () => {
  it('有值在前升序，NULL 垫底按 createdAt', () => {
    const mk = (id: string, pos: number | null, createdAt: number): TaskRow =>
      mkTask(id, { boardPosition: pos, createdAt });
    const out = sortColumn([
      mk('a', null, 300),
      mk('b', 2000, 1),
      mk('c', 1000, 2),
      mk('d', null, 100),
    ]);
    expect(out.map((t) => t.id)).toEqual(['c', 'b', 'd', 'a']); // NULL 之间 createdAt 升序
  });

  it('不修改输入数组（纯函数）', () => {
    const input = [
      mkTask('x', { boardPosition: 5, createdAt: 1 }),
      mkTask('y', { boardPosition: 1, createdAt: 2 }),
    ];
    const snapshot = [...input];
    sortColumn(input);
    expect(input).toEqual(snapshot);
  });
});

describe('splitLanes', () => {
  const groups = [
    mkGroup('g2', { position: 2, name: '研发' }),
    mkGroup('g1', { position: 1, name: '设计' }),
  ];
  const tasks = [
    mkTask('t1', { groupId: 'g1' }),
    mkTask('t2', { groupId: 'g2' }),
    mkTask('t3', { groupId: null }),
    mkTask('t4', { groupId: 'g1' }),
  ];

  it('泳道模式：活跃组按 position 升序各成道，未分组垫底', () => {
    const lanes = splitLanes(tasks, groups, 'lanes');
    expect(lanes.map((l) => l.group?.id ?? null)).toEqual(['g1', 'g2', null]);
    expect(lanes[0]?.tasks.map((t) => t.id)).toEqual(['t1', 't4']); // 组内保持输入序
    expect(lanes[1]?.tasks.map((t) => t.id)).toEqual(['t2']);
    expect(lanes[2]?.group).toBeNull();
    expect(lanes[2]?.tasks.map((t) => t.id)).toEqual(['t3']);
  });

  it('泳道模式：空组也成道（无任务）', () => {
    const emptyGroup = mkGroup('g0', { position: 0 });
    const lanes = splitLanes([], [emptyGroup], 'lanes');
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.group?.id).toBe('g0');
    expect(lanes[0]?.tasks).toEqual([]);
  });

  it('平铺模式：单道全量，group 为 null', () => {
    const lanes = splitLanes(tasks, groups, 'flat');
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.group).toBeNull();
    expect(lanes[0]?.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4']); // 全量保持输入序
  });
});

describe('filterBoardTasks', () => {
  const tasks = [
    mkTask('a', { title: '登录页修复', description: '样式错乱', assigneeAgentId: 'agent-1' }),
    mkTask('b', { title: '导出功能', description: '支持 PDF', assigneeAgentId: 'agent-2' }),
    mkTask('c', { title: 'PDF 解析', description: '', assigneeAgentId: null }),
  ];

  it('文本命中 title（不区分大小写）', () => {
    const out = filterBoardTasks(tasks, { text: 'pdf', assigneeId: null });
    expect(out.map((t) => t.id)).toEqual(['b', 'c']);
  });

  it('文本命中 description', () => {
    const out = filterBoardTasks(tasks, { text: '样式错乱', assigneeId: null });
    expect(out.map((t) => t.id)).toEqual(['a']);
  });

  it('assigneeId 过滤', () => {
    const out = filterBoardTasks(tasks, { text: '', assigneeId: 'agent-1' });
    expect(out.map((t) => t.id)).toEqual(['a']);
  });

  it('text 与 assigneeId 同时给出时 AND', () => {
    const out = filterBoardTasks(tasks, { text: 'pdf', assigneeId: 'agent-2' });
    expect(out.map((t) => t.id)).toEqual(['b']); // c 命中文本但未指派，被 AND 排除
  });

  it('空条件不过滤（全量返回）', () => {
    expect(filterBoardTasks(tasks, { text: '', assigneeId: null })).toHaveLength(3);
  });
});

describe('groupColorStyle', () => {
  it('已知语义色名映射到 CSS 变量串', () => {
    expect(groupColorStyle('accent')).toBe('rgb(var(--accent-500))');
    expect(groupColorStyle('success')).toBe('rgb(var(--status-success))');
    expect(groupColorStyle('warning')).toBe('rgb(var(--status-warning))');
    expect(groupColorStyle('error')).toBe('rgb(var(--status-error))');
    expect(groupColorStyle('violet')).toBe('rgb(var(--status-violet))');
  });

  it('自定义 hex（#rrggbb 小写）原值直返（UX 波 2 #5）', () => {
    expect(groupColorStyle('#5e6ad2')).toBe('#5e6ad2');
    expect(groupColorStyle('#ff0000')).toBe('#ff0000');
  });

  it('null 返回 null', () => {
    expect(groupColorStyle(null)).toBeNull();
  });

  it('未知名返回 null（调用方自定回退）', () => {
    expect(groupColorStyle('magenta')).toBeNull();
    expect(groupColorStyle('')).toBeNull();
  });

  it('非 6 位 / 大写 / 非 hex 串不按自定义色处理（入库约定小写 6 位）', () => {
    expect(groupColorStyle('#5E6AD2')).toBeNull();
    expect(groupColorStyle('#fff')).toBeNull();
    expect(groupColorStyle('#gggggg')).toBeNull();
    expect(groupColorStyle('5e6ad2')).toBeNull();
  });
});

describe('groupColorHex（react-colorful 取色器初始值映射）', () => {
  it('5 语义色名映射到亮色主题 hex（与 globals.css :root 同源）', () => {
    expect(groupColorHex('accent')).toBe('#5e6ad2');
    expect(groupColorHex('violet')).toBe('#6e56cf');
    expect(groupColorHex('success')).toBe('#23835c');
    expect(groupColorHex('warning')).toBe('#b7791f');
    expect(groupColorHex('error')).toBe('#d33f49');
  });

  it('自定义 hex（#rrggbb 小写）原值直返（取色器起点 = 当前自定义色）', () => {
    expect(groupColorHex('#ff8800')).toBe('#ff8800');
  });

  it('null / 未知名 / 非小写 6 位 hex → 兜底靛蓝 #5e6ad2（与 accent-500 同值）', () => {
    expect(groupColorHex(null)).toBe('#5e6ad2');
    expect(groupColorHex('magenta')).toBe('#5e6ad2');
    expect(groupColorHex('')).toBe('#5e6ad2');
    expect(groupColorHex('#5E6AD2')).toBe('#5e6ad2');
    expect(groupColorHex('#fff')).toBe('#5e6ad2');
  });
});

describe('groupChipColor（UX 波 2 #7：平铺组 chip 配色）', () => {
  it('hex → 前景原值 / 底色原值 + 22 alpha', () => {
    expect(groupChipColor('#5e6ad2')).toEqual({ fg: '#5e6ad2', bg: '#5e6ad222' });
  });

  it('语义名 → 前景 CSS 变量串 / 底色 color-mix 14% 透明', () => {
    expect(groupChipColor('accent')).toEqual({
      fg: 'rgb(var(--accent-500))',
      bg: 'color-mix(in srgb, rgb(var(--accent-500)) 14%, transparent)',
    });
    expect(groupChipColor('violet')).toEqual({
      fg: 'rgb(var(--status-violet))',
      bg: 'color-mix(in srgb, rgb(var(--status-violet)) 14%, transparent)',
    });
  });

  it('null / 未知名 → null（调用方回退中性样式）', () => {
    expect(groupChipColor(null)).toBeNull();
    expect(groupChipColor('magenta')).toBeNull();
    expect(groupChipColor('#FFF')).toBeNull();
  });
});
