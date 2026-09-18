// renderer/src/components/im/SessionTodosPanel.test.tsx
//
// SessionTodosPanel 行为测试（spec §2c）：
//   隐藏规则（无清单整体隐藏）/ 分组渲染（组头 agent 名 + N/M 完成 + 条目）/
//   子 agent 标注 / 多 agent 分组顺序 / 流更新实时跟随（末值清单）
// 测试模式（momo-test-rules）：真实 zustand store + setState，不 vi.mock store 模块；
// mock 收窄到零——ipc 边界在组件渲染路径外（订阅在 App 顶层，测试直写 store）。
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type {
  AgentDefinition,
  ImMessage,
  TodoItem,
  WorkspaceAgentMember,
} from '../../ipc/types';
import type { StreamState } from '../../stores/stream.store';
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore } from '../../stores/stream.store';
import { useAgentStore } from '../../stores/agent.store';
import { SessionTodosPanel } from './SessionTodosPanel';

function mkMessage(id: string, sender: string, overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    id,
    sessionId: 's1',
    sender,
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

/** 三态齐全清单（todo id 唯一，前缀区分归属流） */
function mkTodos(prefix: string, n: number, done: number): TodoItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-todo-${i}`,
    subject: `${prefix} 条目${i + 1}`,
    status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending',
  }));
}

function mkStream(messageId: string, todos: TodoItem[], status: StreamState['status']): StreamState {
  return {
    thinking: '',
    text: '',
    toolCalls: [],
    todos,
    dispatches: [],
    segments: [],
    events: [],
    status,
    messageId,
    startedAt: 0,
  };
}

/** 全字段成员 fixture（agentUserId ↔ definition 经 agentDefinitionId 关联） */
function mkMember(instanceId: string, defId: string, agentUserId: string): WorkspaceAgentMember {
  return {
    instanceId,
    workspaceId: 'ws-1',
    agentDefinitionId: defId,
    agentUserId,
    agentName: agentUserId,
    iconEmoji: '',
    hasApiKeyOverride: false,
    lastRunning: false,
    createdAt: '2026-09-18T00:00:00.000Z',
  };
}

/** 最小合法定义 fixture（useBotNameMap 只消费 id/name 两字段，其余给合法占位） */
function mkDef(id: string, name: string): AgentDefinition {
  return {
    id,
    name,
    slug: id,
    version: '1.0.0',
    runtime: 'momo',
    systemPrompt: '',
    defaultTools: [],
    source: 'builtin',
    description: '',
    iconEmoji: '',
    workspaceId: null,
    modelProviderId: null,
    modelName: '',
  };
}

function setStores(
  messages: ImMessage[],
  streams: Array<[string, StreamState]>,
  sessionId: string | null = 's1',
): void {
  useSessionStore.setState({
    activeSessionId: sessionId,
    messagesBySession: sessionId ? new Map([[sessionId, messages]]) : new Map(),
  });
  useStreamStore.setState({ streams: new Map(streams) });
}

describe('SessionTodosPanel', () => {
  beforeEach(() => {
    // 默认无成员/定义（agentName 走 shortName 回退）；需要配置名的用例单独播种
    useAgentStore.setState({ members: [], definitions: [] });
  });

  it('无任何清单 → 整体隐藏', () => {
    setStores([mkMessage('m-user', 'owner')], []);
    const { container } = render(<SessionTodosPanel sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('streams 条目存在但清单为空 → 整体隐藏（清单清空后从总览消失）', () => {
    setStores([mkMessage('m1', '@pm:ws')], [['m1', mkStream('m1', [], 'done')]]);
    const { container } = render(<SessionTodosPanel sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('单 agent 分组：组头 agent 名 + N/M 完成，条目渲染', () => {
    setStores(
      [mkMessage('m-user', 'owner'), mkMessage('m1', '@pm:ws')],
      [['m1', mkStream('m1', mkTodos('pm', 3, 1), 'streaming')]],
    );
    render(<SessionTodosPanel sessionId="s1" />);
    expect(screen.getByText('pm')).toBeInTheDocument(); // shortName('@pm:ws')
    expect(screen.getByText('1/3 完成')).toBeInTheDocument();
    // TodoList 条目（三态图标 + 序号 subject）
    expect(screen.getByText('1. pm 条目1')).toBeInTheDocument();
    expect(screen.getByText('2. pm 条目2')).toBeInTheDocument();
    expect(screen.getByText('3. pm 条目3')).toBeInTheDocument();
    expect(screen.queryByText('子 agent')).not.toBeInTheDocument();
  });

  it('子 agent 分组带「子 agent」标注，主 agent 不带', () => {
    setStores(
      [
        mkMessage('m1', '@pm:ws', { streamSessionId: 'ss-1' }),
        mkMessage('m-sub', '@coder:ws', {
          streamSessionId: 'ss-sub',
          parentStreamSessionId: 'ss-1',
        }),
      ],
      [
        ['m1', mkStream('m1', mkTodos('pm', 2, 2), 'done')],
        ['m-sub', mkStream('m-sub', mkTodos('sub', 2, 0), 'streaming')],
      ],
    );
    render(<SessionTodosPanel sessionId="s1" />);
    // 唯一「子 agent」标注属于 coder 分组
    const badge = screen.getByText('子 agent');
    expect(badge.closest('section')?.getAttribute('aria-label')).toBe('coder 的任务清单');
    expect(screen.getByText('2/2 完成')).toBeInTheDocument();
    expect(screen.getByText('0/2 完成')).toBeInTheDocument();
  });

  it('多 agent 分组按消息顺序排列', () => {
    setStores(
      [
        mkMessage('m-sub', '@coder:ws', { parentStreamSessionId: 'ss-1' }),
        mkMessage('m-pm', '@pm:ws', { streamSessionId: 'ss-1' }),
      ],
      [
        ['m-pm', mkStream('m-pm', mkTodos('pm', 1, 0), 'done')],
        ['m-sub', mkStream('m-sub', mkTodos('sub', 1, 0), 'done')],
      ],
    );
    const { container } = render(<SessionTodosPanel sessionId="s1" />);
    const sections = container.querySelectorAll('section');
    expect(sections).toHaveLength(2);
    // 消息序 m-sub 在前（数组顺序），与 streams Map 迭代序无关
    expect(sections[0]?.getAttribute('aria-label')).toBe('coder 的任务清单');
    expect(sections[1]?.getAttribute('aria-label')).toBe('pm 的任务清单');
  });

  it('流更新实时跟随：清单替换为末值后面板刷新', () => {
    setStores([mkMessage('m1', '@pm:ws')], [['m1', mkStream('m1', mkTodos('v1', 3, 0), 'streaming')]]);
    const { container } = render(<SessionTodosPanel sessionId="s1" />);
    expect(screen.getByText('0/3 完成')).toBeInTheDocument();
    expect(container.querySelectorAll('section')).toHaveLength(1);

    // 模拟新一轮 todowrite 全量替换（末值胜出）
    act(() => {
      useStreamStore.setState({
        streams: new Map([['m1', mkStream('m1', mkTodos('v2', 2, 2), 'done')]]),
      });
    });
    expect(screen.getByText('2/2 完成')).toBeInTheDocument();
    expect(screen.getByText('1. v2 条目1')).toBeInTheDocument();
    expect(screen.queryByText('1. v1 条目1')).not.toBeInTheDocument();
  });

  it('agentName 经 agent.store 成员/定义解析为配置名', () => {
    useAgentStore.setState({
      members: [mkMember('inst-pm', 'def-pm', '@pm:ws')],
      definitions: [mkDef('def-pm', 'PM 管家')],
    });
    setStores([mkMessage('m1', '@pm:ws')], [['m1', mkStream('m1', mkTodos('pm', 1, 1), 'done')]]);
    render(<SessionTodosPanel sessionId="s1" />);
    expect(screen.getByText('PM 管家')).toBeInTheDocument();
    expect(screen.queryByText('pm')).not.toBeInTheDocument();
  });
});
