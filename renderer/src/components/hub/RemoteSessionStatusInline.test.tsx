// RemoteSessionStatusInline：远端运行状态内联到会话标题行（spec 2026-11-18 头部统一）。
// 覆盖：目标会话匹配才渲染 / 实时与断连两态 / 旧 worker 简版回放 chip。
import { beforeEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { RemoteSessionStatusInline } from './RemoteSessionStatusInline';
import { useRemoteSessionStore } from '../../stores/remote-session.view';
import type { TaskRow } from '../../ipc/types';

function task(executionSessionId: string | null): TaskRow {
  return {
    id: 'T-7', workspaceId: 'ws1', title: 't', description: '', status: 'in_progress',
    sourceSessionId: null, sourceMessageId: null, creatorUserId: 'owner', executionSessionId,
    assigneeAgentId: null, targetTeamId: null, targetSessionId: null, recurrenceParentId: null,
    priority: 0, scheduledAt: null, recurrenceRule: null, deadlineAt: null, queuePosition: null,
    runtimeInstanceId: null, estimatedTokens: null, actualTokens: null, toolCallsUsed: 0,
    errorMessage: null, sourceNodeId: null, createdAt: 0, updatedAt: 0, startedAt: null, completedAt: null,
    currentRunId: null, submittedAt: null, acceptedAt: null, delegationRole: 'out', autoAccept: false,
    groupId: null, pinnedAt: null, archivedAt: null,
    routing: { mode: 'node', groupId: 'g', targetNodeId: 'node-b' },
    delegationId: 'dl', origin: 'user', parentTaskId: null,
  };
}

const TARGET = {
  targetNodeId: 'node-b', workspaceName: 'ws-b', groupId: 'g', runNo: 1,
  nodeName: '节点B', sessionId: 'remote-sx',
};

beforeEach(() => {
  useRemoteSessionStore.setState({
    phase: 'ready', errorText: null, task: task('sx'), target: TARGET,
    wire2: true, frames: [], legacy: [], mirrorRows: [], hasMore: false,
    loadingEarlier: false, live: true, hubOnline: true, liveError: null, pendingSteers: [],
  } as Partial<ReturnType<typeof useRemoteSessionStore.getState>>);
});

describe('RemoteSessionStatusInline', () => {
  it('目标会话匹配 → 实时徽标 + 节点 · run · 工作区', () => {
    const { container } = render(<RemoteSessionStatusInline sessionId="sx" />);
    const txt = container.textContent!;
    expect(txt).toContain('实时');
    expect(txt).toContain('节点B');
    expect(txt).toContain('run #1');
    expect(txt).toContain('ws-b');
  });

  it('会话不匹配 / 无 target → 不渲染（防切会话闪现上一条状态）', () => {
    const { container: other } = render(<RemoteSessionStatusInline sessionId="other" />);
    expect(other).toBeEmptyDOMElement();
    useRemoteSessionStore.setState({ target: null } as Partial<ReturnType<typeof useRemoteSessionStore.getState>>);
    const { container: none } = render(<RemoteSessionStatusInline sessionId="sx" />);
    expect(none).toBeEmptyDOMElement();
  });

  it('断线 → 「已断开 · 重连后恢复」', () => {
    useRemoteSessionStore.setState({ live: false, hubOnline: false } as Partial<ReturnType<typeof useRemoteSessionStore.getState>>);
    const { container } = render(<RemoteSessionStatusInline sessionId="sx" />);
    expect(container.textContent).toContain('已断开');
  });

  it('旧 worker（wire2=false）→ 简版回放 chip', () => {
    useRemoteSessionStore.setState({ wire2: false } as Partial<ReturnType<typeof useRemoteSessionStore.getState>>);
    const { container } = render(<RemoteSessionStatusInline sessionId="sx" />);
    expect(container.textContent).toContain('简版回放');
  });
});
