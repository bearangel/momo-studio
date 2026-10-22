// renderer/src/lib/session-type.test.ts
//
// 会话类型判定（spec 2026-10-22 §3.1）判定顺序回归锁：
// kind 优先 → sessionType 次之 → 成员数兜底（旧库防御）。
import { describe, it, expect } from 'vitest';
import { deriveSessionType } from './session-type';
import type { SessionMemberInfo, SessionSummary } from '../ipc/types';

/** 按个数生成成员（判定只读 length，字段取合法最小值） */
function members(n: number): SessionMemberInfo[] {
  return Array.from({ length: n }, () => ({
    instanceId: 'i',
    agentName: 'a',
    iconEmoji: '',
    lastRunning: false,
    isLeader: false,
  }));
}

// mk：Partial<First arg of deriveSessionType>，保证透传后仍满足入参类型
const mk = (
  over: Partial<Parameters<typeof deriveSessionType>[0]>,
): Parameters<typeof deriveSessionType>[0] => ({
  kind: 'chat' as const,
  sessionType: null,
  members: members(1),
  ...over,
});

describe('deriveSessionType（spec §3.1 判定顺序）', () => {
  it('kind 优先：task_execution 恒任务', () => {
    expect(deriveSessionType(mk({ kind: 'task_execution' }))).toBe('task_execution');
  });

  it('kind 优先级高于 sessionType（即使 sessionType 已写值）', () => {
    expect(deriveSessionType(mk({ kind: 'task_execution', sessionType: 'quick' }))).toBe(
      'task_execution',
    );
  });

  it('sessionType 次之；NULL 兜底按成员数推断', () => {
    expect(deriveSessionType(mk({ sessionType: 'collab' }))).toBe('collab');
    expect(deriveSessionType(mk({ sessionType: 'quick', members: members(2) }))).toBe('quick');
    expect(deriveSessionType(mk({ sessionType: null, members: members(2) }))).toBe('collab');
    expect(deriveSessionType(mk({ sessionType: null }))).toBe('quick');
  });

  it('旧库防御：sessionType NULL 且成员为空数组 → 快速会话', () => {
    expect(deriveSessionType(mk({ sessionType: null, members: [] }))).toBe('quick');
  });

  it('SessionSummary 全量对象可直接传入（结构兼容锚点）', () => {
    const s: SessionSummary = {
      id: 's1',
      workspaceId: 'ws-1',
      title: 't',
      titleAuto: false,
      kind: 'chat',
      lastMessageAt: null,
      pinnedAt: null,
      groupId: null,
      groupName: null,
      sessionType: 'collab',
      members: [],
    };
    expect(deriveSessionType(s)).toBe('collab');
  });
});
