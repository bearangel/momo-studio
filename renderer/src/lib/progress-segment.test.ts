// renderer/src/lib/progress-segment.test.ts
//
// 进度分段识别 / 解析 / 分组单测。解析契约测试用与主进程
// router-service.maybeEmitProgressSegment 完全一致的模板字符串拼 body——
// 契约漂移（模板改动）会让本测试第一时间红（momo-test-rules 铁律 4）。
import { describe, it, expect } from 'vitest';
import type { ImMessage } from '../ipc/types';
import {
  PROGRESS_SEGMENT_PREFIX,
  isProgressSegmentMessage,
  parseProgressSegmentBody,
  groupProgressSegments,
  formatProgressTime,
} from './progress-segment';

/** 生产模板拼 body（与 router-service.maybeEmitProgressSegment 输出逐字对齐） */
function productionBody(label: string, toolCalls: number, changes: number): string {
  return `【进度分段】子任务 ${label} 进行中 · 工具调用累计 ${toolCalls} 次 · 文件变更累计 ${changes} 处`;
}

/** 构造 ImMessage（字段对齐 SQLite messages 表 row，见 MessageList.test.tsx makeMsg） */
function makeMsg(overrides: Partial<ImMessage> & { id: string }): ImMessage {
  return {
    sessionId: 'sess-room',
    sender: '@bot:server',
    body: '',
    eventType: 'm.room.message',
    streamSessionId: null,
    parentStreamSessionId: null,
    segmentOf: null,
    segmentIndex: null,
    status: 'done',
    source: 'local',
    workspaceId: null,
    taskId: null,
    contextJson: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeProgress(overrides: Partial<ImMessage> & { id: string }): ImMessage {
  return makeMsg({ sender: 'system', body: productionBody('示例任务', 1, 0), ...overrides });
}

describe('isProgressSegmentMessage', () => {
  it('sender=system 且 body 带前缀 → true', () => {
    expect(
      isProgressSegmentMessage(makeProgress({ id: 'p1', body: productionBody('重构登录模块', 3, 1) })),
    ).toBe(true);
  });

  it('sender 非 system（agent-x）即使 body 带前缀 → false', () => {
    expect(
      isProgressSegmentMessage(
        makeMsg({ id: 'a1', sender: 'agent-x', body: productionBody('伪造', 1, 1) }),
      ),
    ).toBe(false);
  });

  it('sender=system 但 body 无前缀 → false', () => {
    expect(
      isProgressSegmentMessage(makeMsg({ id: 's1', sender: 'system', body: '普通系统行' })),
    ).toBe(false);
  });

  it('body 为空串 → false', () => {
    expect(
      isProgressSegmentMessage(makeMsg({ id: 'e1', sender: 'system', body: '' })),
    ).toBe(false);
  });
});

describe('parseProgressSegmentBody 契约（生产模板）', () => {
  it('常规中文标签 → 解析出 label / toolCalls / changes', () => {
    const data = parseProgressSegmentBody(productionBody('重构登录模块', 3, 12));
    expect(data).toEqual({ label: '重构登录模块', toolCalls: 3, changes: 12 });
  });

  it('标签含空格 → 完整保留（非贪婪不误截）', () => {
    const data = parseProgressSegmentBody(productionBody('优化 数据库 查询', 8, 2));
    expect(data).toEqual({ label: '优化 数据库 查询', toolCalls: 8, changes: 2 });
  });

  it('大数字（612/23）→ 数值字段正确', () => {
    const data = parseProgressSegmentBody(productionBody('长时任务', 612, 23));
    expect(data).toEqual({ label: '长时任务', toolCalls: 612, changes: 23 });
  });

  // —— 错误路径（momo-test-rules 铁律 3）：格式漂移必须显式降级为 null ——
  it('格式漂移 body → null（调用方降级原始文本）', () => {
    expect(parseProgressSegmentBody('【进度分段】子任务 X 进行中（工具调用累计 1 次）')).toBeNull();
    expect(parseProgressSegmentBody('前缀都没了 子任务 X 进行中 · 工具调用累计 1 次 · 文件变更累计 1 处')).toBeNull();
  });

  it('空串 → null', () => {
    expect(parseProgressSegmentBody('')).toBeNull();
  });

  it('仅前缀 → null', () => {
    expect(parseProgressSegmentBody(PROGRESS_SEGMENT_PREFIX)).toBeNull();
  });
});

describe('groupProgressSegments', () => {
  it('空数组 → 空结果', () => {
    expect(groupProgressSegments([])).toEqual([]);
  });

  it('单条普通消息 → single 透传', () => {
    const n = makeMsg({ id: 'n1', body: '普通' });
    expect(groupProgressSegments([n])).toEqual([{ kind: 'single', message: n }]);
  });

  it('[p,p,p] → 一个 progress 组（3 条）', () => {
    const ps = [
      makeProgress({ id: 'p1' }),
      makeProgress({ id: 'p2' }),
      makeProgress({ id: 'p3' }),
    ];
    expect(groupProgressSegments(ps)).toEqual([{ kind: 'progress', messages: ps }]);
  });

  it('[n,p,p,n2,p] → single、progress(2)、single、progress(1)', () => {
    const n1 = makeMsg({ id: 'n1', body: '一' });
    const p1 = makeProgress({ id: 'p1' });
    const p2 = makeProgress({ id: 'p2' });
    const n2 = makeMsg({ id: 'n2', body: '二' });
    const p3 = makeProgress({ id: 'p3' });
    expect(groupProgressSegments([n1, p1, p2, n2, p3])).toEqual([
      { kind: 'single', message: n1 },
      { kind: 'progress', messages: [p1, p2] },
      { kind: 'single', message: n2 },
      { kind: 'progress', messages: [p3] },
    ]);
  });

  it('分组保持原顺序与消息对象身份（不复制不改序）', () => {
    const p1 = makeProgress({ id: 'p1' });
    const p2 = makeProgress({ id: 'p2' });
    const p3 = makeProgress({ id: 'p3' });
    const result = groupProgressSegments([p1, p2, p3]);
    expect(result).toHaveLength(1);
    const group = result[0]!;
    if (group.kind !== 'progress') throw new Error('应为 progress 组');
    // 身份断言：组内就是原对象引用（渲染层直接消费，不产生副本）
    expect(group.messages[0]).toBe(p1);
    expect(group.messages[1]).toBe(p2);
    expect(group.messages[2]).toBe(p3);
  });
});

describe('formatProgressTime', () => {
  it('epoch ms → 本地 HH:mm 零填充', () => {
    // 固定本地时刻：9 点 05 分 / 23 点整（独立断言口径，不复用被测实现）
    expect(formatProgressTime(new Date(2026, 10, 11, 9, 5).getTime())).toBe('09:05');
    expect(formatProgressTime(new Date(2026, 10, 11, 23, 0).getTime())).toBe('23:00');
  });
});
