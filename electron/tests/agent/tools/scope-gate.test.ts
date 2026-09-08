// electron/tests/agent/tools/scope-gate.test.ts
//
// 软门禁回归锁（spec §5.3）：无 user 挂靠时 create_task / memory_save 附 warning，不阻断。
//
// 追加要求（T4 审查遗留项，随本任务一并落）：谓词一致性用例——
// hasPendingUserTodos（公共 API）与 T4 生产代码使用的过滤条件
// （status !== 'completed' && source === 'user'）行为一致：种子四项
// [pending user, in_progress user, completed user, pending agent] 断言 true；
// 改种子为 [completed user, pending agent] 断言 false。
// 该测试同时把 T1 导出的谓词锁定为生产行为。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskTools } from '../../../src/main/agent/tools/task-tools';
import {
  hasPendingUserTodos,
  __setTodosForTest,
} from '../../../src/main/agent/tools/todo-tools';
import type { TodoItem } from '../../../src/main/agent/tools/todo-types';
import type { ToolContext } from '../../../src/main/agent/tools/types';

vi.mock('../../../src/main/storage/tasks/repo', () => ({
  insertTask: (input: { title: string }) => ({
    id: 'T-900',
    status: 'assigned',
    recurrenceRule: null,
    ...input,
  }),
  transitionTaskStatus: vi.fn(),
}));
vi.mock('../../../src/main/task/executor', () => ({ notifyExecutor: vi.fn() }));
vi.mock('../../../src/main/memory', () => ({
  getMemoryProvider: () => ({
    saveMemory: async (input: { content: string }) => ({
      id: 'mem-1',
      kind: 'summary',
      content: input.content,
      pinned: false,
    }),
  }),
}));

/** 最小 ToolContext 桩——task 工具消费 workspaceId / creatorUserId / roomId / streamSessionId；memory_save 消费 workspaceId / roomId / streamSessionId */
const mkCtx = (streamSessionId: string): ToolContext => ({
  wsFs: {} as never,
  workspaceId: 'ws-g',
  workspaceDir: '/tmp/ws-g',
  skillRegistry: {} as never,
  streamSessionId,
  roomId: 'room-g',
  sendStreamChunk: () => {},
  permissionConfig: { allowedTools: [], deniedTools: [] },
  creatorUserId: 'owner',
});

describe('副作用软门禁', () => {
  const sid = 'sid-gate';

  beforeEach(() => __setTodosForTest(sid, []));

  it('create_task 无挂靠 → TaskRow 顶层附 warning（不阻断）', async () => {
    const out = JSON.parse(
      await new TaskTools().execute(
        'create_task',
        { title: '测试任务', assigneeAgentId: 'a1' },
        { ...mkCtx(sid), workspaceId: 'ws-g', creatorUserId: 'owner' },
      ),
    );
    expect(out.id).toBe('T-900'); // 未阻断：实际 TaskRow 仍落库
    expect(out.warning).toContain('未挂靠到本轮用户请求');
  });

  it('memory_save 无挂靠 → 返回串追加警告行（不阻断）', async () => {
    const { MemoryTools } = await import('../../../src/main/agent/tools/memory-tools');
    const out = await new MemoryTools().execute(
      'memory_save',
      { kind: 'summary', content: '测试记忆内容' },
      mkCtx(sid),
    );
    expect(out).toContain('已保存记忆'); // 主路径文本未改
    expect(out).toContain('⚠'); // 警告行追加
  });
});

// ─── T4 审查遗留项：谓词一致性回归锁 ────────────────────────────────────────

describe('谓词一致性（hasPendingUserTodos ↔ runtime-entry 闭包）', () => {
  const sid = 'sid-predicate';

  /** 种子项：subject 与 id 占位（id 不影响谓词判定，但 TodoItem 字段必需） */
  const itemsOf = (specs: Array<{ status: TodoItem['status']; source: TodoItem['source'] }>): TodoItem[] =>
    specs.map((s, i) => ({
      id: `seed-${i}`,
      subject: `seed-${i}`,
      status: s.status,
      source: s.source,
    }));

  beforeEach(() => __setTodosForTest(sid, []));

  it('四项种子 [pending user, in_progress user, completed user, pending agent] → true', () => {
    __setTodosForTest(
      sid,
      itemsOf([
        { status: 'pending', source: 'user' },
        { status: 'in_progress', source: 'user' },
        { status: 'completed', source: 'user' },
        { status: 'pending', source: 'agent' },
      ]),
    );
    expect(hasPendingUserTodos(sid)).toBe(true);
  });

  it('改种子为 [completed user, pending agent] → false', () => {
    __setTodosForTest(
      sid,
      itemsOf([
        { status: 'completed', source: 'user' },
        { status: 'pending', source: 'agent' },
      ]),
    );
    expect(hasPendingUserTodos(sid)).toBe(false);
  });

  it('空种子 → false', () => {
    expect(hasPendingUserTodos(sid)).toBe(false);
  });

  it('completed agent 不计（边界）', () => {
    __setTodosForTest(
      sid,
      itemsOf([
        { status: 'completed', source: 'agent' },
        { status: 'pending', source: 'agent' },
      ]),
    );
    expect(hasPendingUserTodos(sid)).toBe(false);
  });
});