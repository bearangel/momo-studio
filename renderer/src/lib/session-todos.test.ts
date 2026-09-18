// renderer/src/lib/session-todos.test.ts
//
// collectSessionTodos 行为测试（spec §2c）：
//   空 / 单 agent 多项 / 多 agent 含子 agent / 同流多次 todo_update 末值胜出 /
//   streams 缺失容错 / agent 名解析（botNameMap 命中 + shortName 回退）
// 保真度约定（momo-test-rules）：
//   - mock 的 id 全部真实唯一（消息 id / event id / todo id 各自私有前缀）
//   - 「末值胜出」用真实 aggregateEvents(events) 构建 StreamState——契约测试：
//     生产者（todo_update 事件 → 聚合器）真实产出直接喂消费者，不经手写中间数据
import { describe, expect, it } from 'vitest';
import type { ImMessage, MessageEventRow, TodoItem } from '../ipc/types';
import type { StreamState } from '../stores/stream.store';
import { aggregateEvents } from './stream-aggregator';
import { collectSessionTodos } from './session-todos';
import { shortName } from '../components/im/avatars';

/** 全字段 ImMessage fixture（与 SQLite messages row 契约对齐，id 由调用方保证唯一） */
function mkMessage(id: string, sender: string, overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    id,
    sessionId: 'sess-aggregate',
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

/** 三态齐全的 todo 清单 fixture（todo id 唯一，前缀区分归属流） */
function mkTodos(prefix: string, n: number, done: number): TodoItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-todo-${i}`,
    subject: `${prefix} 步骤${i + 1}`,
    status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending',
  }));
}

/** 最小合法 StreamState fixture（聚合字段全给，todos 为当前清单快照） */
function mkStream(messageId: string, todos: TodoItem[], status: StreamState['status'] = 'done'): StreamState {
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

/** 全字段 MessageEventRow fixture（event id / seq 桶内唯一） */
function mkEvent(id: string, messageId: string, seq: number, payload: Record<string, unknown>): MessageEventRow {
  return {
    id,
    messageId,
    seq,
    eventType: 'todo_update',
    payload,
    createdAt: seq,
  };
}

describe('collectSessionTodos', () => {
  it('空消息 + 空 streams → 空数组', () => {
    expect(collectSessionTodos([], new Map())).toEqual([]);
  });

  it('streams 有条目但消息列表为空 → 空数组（以消息序为遍历源）', () => {
    const streams = new Map([['msg-orphan', mkStream('msg-orphan', mkTodos('orphan', 2, 1))]]);
    expect(collectSessionTodos([], streams)).toEqual([]);
  });

  it('单 agent 多项：产出一条聚合，字段按流快照透传', () => {
    const todos = mkTodos('pm', 3, 1);
    const messages = [mkMessage('msg-user-1', 'owner'), mkMessage('msg-pm-1', '@pm-agent:ws')];
    const streams = new Map([['msg-pm-1', mkStream('msg-pm-1', todos, 'streaming')]]);
    const botNameMap = new Map([['@pm-agent:ws', 'PM 管家']]);

    const entries = collectSessionTodos(messages, streams, botNameMap);

    expect(entries).toEqual([
      {
        messageId: 'msg-pm-1',
        agentName: 'PM 管家',
        isSubAgent: false,
        // 条目数组直接引用聚合结果（引用相等——消费方改不出漂移副本）
        todos,
      },
    ]);
  });

  it('多 agent 含子 agent：按消息顺序分组，isSubAgent 按 parentStreamSessionId 判定', () => {
    const messages = [
      mkMessage('msg-user-1', 'owner'),
      mkMessage('msg-pm-1', '@pm-agent:ws', { streamSessionId: 'ss-pm-1' }),
      mkMessage('msg-sub-1', '@coder:ws', {
        streamSessionId: 'ss-sub-1',
        parentStreamSessionId: 'ss-pm-1',
      }),
    ];
    const streams = new Map([
      ['msg-pm-1', mkStream('msg-pm-1', mkTodos('pm', 2, 2))],
      ['msg-sub-1', mkStream('msg-sub-1', mkTodos('sub', 2, 0), 'streaming')],
    ]);
    const botNameMap = new Map([
      ['@pm-agent:ws', 'PM 管家'],
      ['@coder:ws', '程序员'],
    ]);

    const entries = collectSessionTodos(messages, streams, botNameMap);

    expect(entries.map((e) => [e.messageId, e.agentName, e.isSubAgent])).toEqual([
      ['msg-pm-1', 'PM 管家', false],
      ['msg-sub-1', '程序员', true],
    ]);
  });

  it('同流多次 todo_update 末值胜出（契约：真实 aggregateEvents 产出喂入）', () => {
    // 生产链路：todowrite 全量替换 → todo_update 事件按 seq 升序落库 →
    // aggregateEvents 取最后一次写入。这里用真实聚合器产出 StreamState，
    // 锁死「事件 → 聚合 → 选择器」整链契约
    const first = mkTodos('v1', 3, 0);
    const second = mkTodos('v2', 2, 1);
    const events = [
      mkEvent('evt-todo-1', 'msg-pm-1', 1, { todos: first }),
      mkEvent('evt-todo-2', 'msg-pm-1', 2, { todos: second }),
    ];
    const aggregated = aggregateEvents(events);
    expect(aggregated.todos).toEqual(second); // 契约前置：聚合器末值胜出

    const streams = new Map<string, StreamState>([
      ['msg-pm-1', { ...aggregated, messageId: 'msg-pm-1', startedAt: 0 }],
    ]);
    const entries = collectSessionTodos([mkMessage('msg-pm-1', '@pm-agent:ws')], streams);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.todos).toEqual(second);
    // 断言被消费字段的真实性质：末值清单的 id 前缀是 v2（非首写 v1）
    expect(entries[0]!.todos.map((t) => t.id)).toEqual(['v2-todo-0', 'v2-todo-1']);
  });

  it('streams 缺失消息容错：中间缺条目不抛错，只跳过', () => {
    const messages = [
      mkMessage('msg-a', '@a:ws'),
      mkMessage('msg-b', '@b:ws'), // 无 streams 条目（如尚未 hydrate）
      mkMessage('msg-c', '@c:ws'),
    ];
    const streams = new Map([
      ['msg-a', mkStream('msg-a', mkTodos('a', 1, 1))],
      ['msg-c', mkStream('msg-c', mkTodos('c', 1, 0))],
    ]);

    const entries = collectSessionTodos(messages, streams);

    expect(entries.map((e) => e.messageId)).toEqual(['msg-a', 'msg-c']);
  });

  it('streams 条目存在但 todos 为空 → 不产出条目（清单清空后从总览消失）', () => {
    const messages = [mkMessage('msg-a', '@a:ws')];
    const streams = new Map([['msg-a', mkStream('msg-a', [], 'done')]]);
    expect(collectSessionTodos(messages, streams)).toEqual([]);
  });

  it('agentName 解析：botNameMap 缺省时回退 shortName（与气泡展示同款逻辑）', () => {
    const messages = [mkMessage('msg-x', '@alice:localhost')];
    const streams = new Map([['msg-x', mkStream('msg-x', mkTodos('x', 1, 0))]]);

    // 不传 botNameMap（默认空表）→ shortName('@alice:localhost') = 'alice'
    const entries = collectSessionTodos(messages, streams);
    expect(entries[0]!.agentName).toBe(shortName('@alice:localhost'));
    expect(entries[0]!.agentName).toBe('alice');

    // map 未命中（成员未加载）同样回退；命中则用配置名
    const entries2 = collectSessionTodos(messages, streams, new Map([['@bob:ws', '鲍勃']]));
    expect(entries2[0]!.agentName).toBe('alice');
  });
});
