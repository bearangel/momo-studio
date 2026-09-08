// renderer/src/components/task-board/useTaskEntityNames.test.tsx
//
// K4 回归锁：任务实体名称解析——store 已有数据时即时解析；查不到回退
// ID 前 8 位（成员移除/团队解散/会话删除的残留引用场景）。
// 真实 store（momo-test-rules #5：mock 越厚离生产越远）+ window.api 只挂
// 兜底拉取通道（失败路径静默回退也是断言点）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTaskEntityNames } from './useTaskEntityNames';
import { useAgentStore } from '../../stores/agent.store';
import { useSessionStore } from '../../stores/session.store';
import type { WorkspaceAgentMember, Team } from '../../ipc/types';

const mockApi = {
  agent: {
    listMembers: vi.fn().mockRejectedValue(new Error('no ipc')),
  },
  team: {
    list: vi.fn().mockRejectedValue(new Error('no ipc')),
  },
  session: {
    list: vi.fn().mockRejectedValue(new Error('no ipc')),
  },
};

function mkMember(instanceId: string, agentName: string): WorkspaceAgentMember {
  return {
    instanceId,
    workspaceId: 'ws-1',
    agentDefinitionId: `def-${instanceId}`,
    agentUserId: `@${instanceId}:s`,
    agentName,
    iconEmoji: '',
    hasApiKeyOverride: false,
    lastRunning: false,
    createdAt: '2026-01-01',
  };
}

function mkTeam(id: string, name: string): Team {
  return {
    id,
    workspaceId: 'ws-1',
    name,
    iconEmoji: '',
    leaderInstanceId: 'inst-1',
    members: [],
    createdAt: '2026-01-01',
  };
}

beforeEach(() => {
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  mockApi.session.list.mockClear();
  useAgentStore.setState({ members: [mkMember('inst-1', 'coder')], teams: [mkTeam('team-1', '研发一组')] });
  useSessionStore.setState({
    sessions: [
      {
        id: 'sess-1',
        workspaceId: 'ws-1',
        title: '架构评审',
        titleAuto: false,
        kind: 'chat',
        lastMessageAt: null,
        members: [],
      },
    ],
  });
});

describe('useTaskEntityNames', () => {
  it('store 已有数据 → 解析 agent/团队/会话名称', () => {
    const { result } = renderHook(() => useTaskEntityNames('ws-1'));
    expect(result.current.agentName('inst-1')).toBe('coder');
    expect(result.current.teamName('team-1')).toBe('研发一组');
    expect(result.current.sessionTitle('sess-1')).toBe('架构评审');
  });

  it('未知 ID → 回退前 8 位片段（残留引用场景）', () => {
    const { result } = renderHook(() => useTaskEntityNames('ws-1'));
    expect(result.current.agentName('inst-removed-9999')).toBe('inst-rem');
    expect(result.current.teamName('team-gone-9999')).toBe('team-gon');
    expect(result.current.sessionTitle('sess-dead-99999')).toBe('sess-dea');
  });

  it('store 无数据且兜底拉取失败 → 静默回退，不抛异常', () => {
    useAgentStore.setState({ members: [], teams: [] });
    useSessionStore.setState({ sessions: [] });
    const { result } = renderHook(() => useTaskEntityNames('ws-1'));
    expect(result.current.agentName('inst-1')).toBe('inst-1'.slice(0, 8));
  });

  it('workspaceId 为 null（面板加载中）→ 不触发拉取，可安全调用', () => {
    const { result } = renderHook(() => useTaskEntityNames(null));
    // store 已有数据照常解析（即时可用）；未知 ID 回退
    expect(result.current.agentName('inst-1')).toBe('coder');
    expect(result.current.agentName('inst-unknown')).toBe('inst-unk'.slice(0, 8));
    expect(mockApi.session.list).not.toHaveBeenCalled();
  });
});
