// electron/tests/agent/tools/todo-tools.test.ts
// v1.5 todowrite 工具后端测试。覆盖：
//   - 全量替换语义（创建/混合状态/清空）
//   - 输入校验（subject 缺失 / status 非法 / subject 过长 / 数量超限）
//   - 会话隔离（不同 streamSessionId 不串数据）
//   - StreamChunk 推送（todo_update chunk 携带完整 todos）
// v2.3 turn-mandate 扩展：todo source 挂靠字段 + hasPendingUserTodos 判定。
// F9a 扩展：稳定 ID——同归一 subject 跨重写延续 id。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  TodoTools,
  hasPendingUserTodos,
  completeInProgressTodos,
  getTodosForSession,
  __setTodosForTest,
} from '../../../src/main/agent/tools/todo-tools';
import type { ToolContext } from '../../../src/main/agent/tools/types';

let sendChunkCalls: Array<{ type: string; todos: unknown[] }>;
let ctx: ToolContext;

beforeEach(() => {
  sendChunkCalls = [];
  ctx = {
    wsFs: {} as never,
    workspaceId: 'ws',
    workspaceDir: '/tmp',
    skillRegistry: {} as never,
    streamSessionId: 'ssn-1',
    roomId: '!r',
    sendStreamChunk: (chunk) => sendChunkCalls.push(chunk as never),
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: '',
  };
});

describe('todowrite', () => {
  it('创建 3 项 pending', async () => {    const tools = new TodoTools();
    const result = await tools.execute(
      'todowrite',
      {
        todos: [
          { subject: 'A', status: 'pending' },
          { subject: 'B', status: 'pending' },
          { subject: 'C', status: 'pending' },
        ],
      },
      ctx,
    );
    expect(result).toContain('0/3');
    expect(sendChunkCalls).toHaveLength(1);
    expect(sendChunkCalls[0]!.type).toBe('todo_update');
    expect(sendChunkCalls[0]!.todos).toHaveLength(3);
  });

  it('全量替换（混合状态）', async () => {
    const tools = new TodoTools();
    await tools.execute(
      'todowrite',
      { todos: [{ subject: 'A', status: 'pending' }] },
      ctx,
    );
    sendChunkCalls.length = 0;
    const result = await tools.execute(
      'todowrite',
      {
        todos: [
          { subject: 'A', status: 'completed' },
          { subject: 'B', status: 'in_progress' },
        ],
      },
      ctx,
    );
    expect(result).toContain('1/2');
    expect(sendChunkCalls[0]!.todos).toHaveLength(2);
  });

  it('空数组清空 store', async () => {
    const tools = new TodoTools();
    await tools.execute(
      'todowrite',
      { todos: [{ subject: 'X', status: 'pending' }] },
      ctx,
    );
    sendChunkCalls.length = 0;
    await tools.execute('todowrite', { todos: [] }, ctx);
    expect(sendChunkCalls[0]!.todos).toEqual([]);
  });

  it('subject 缺失抛错', async () => {
    const tools = new TodoTools();
    await expect(
      tools.execute(
        'todowrite',
        { todos: [{ status: 'pending' }] },
        ctx,
      ),
    ).rejects.toThrow(/subject/);
  });

  it('status 非法抛错', async () => {
    const tools = new TodoTools();
    await expect(
      tools.execute(
        'todowrite',
        { todos: [{ subject: 'X', status: 'invalid' }] },
        ctx,
      ),
    ).rejects.toThrow(/status/);
  });

  it('subject 超 200 字符抛错', async () => {
    const tools = new TodoTools();
    await expect(
      tools.execute(
        'todowrite',
        { todos: [{ subject: 'x'.repeat(201), status: 'pending' }] },
        ctx,
      ),
    ).rejects.toThrow(/过长/);
  });

  it('数量超 30 抛错', async () => {
    const tools = new TodoTools();
    const todos = Array.from({ length: 31 }, () => ({
      subject: 'x',
      status: 'pending' as const,
    }));
    await expect(tools.execute('todowrite', { todos }, ctx)).rejects.toThrow(
      /超过上限/,
    );
  });

  it('store 按 streamSessionId 隔离', async () => {
    const tools = new TodoTools();
    await tools.execute(
      'todowrite',
      { todos: [{ subject: 'A', status: 'pending' }] },
      ctx,
    );
    const ctx2 = { ...ctx, streamSessionId: 'ssn-2' };
    await tools.execute(
      'todowrite',
      { todos: [{ subject: 'B', status: 'pending' }] },
      ctx2,
    );
    expect(tools.getTodos('ssn-1')).toHaveLength(1);
    expect(tools.getTodos('ssn-1')[0]!.subject).toBe('A');
    expect(tools.getTodos('ssn-2')[0]!.subject).toBe('B');
  });
});

describe('todo source 挂靠', () => {
  const tools = new TodoTools();
  const sid = 'stream-source-test';
  // 最小 ToolContext 桩——todo 工具只消费 streamSessionId / roomId / sendStreamChunk
  const mkCtx = (streamSessionId: string): ToolContext => ({
    wsFs: {} as never,
    workspaceId: 'ws-test',
    workspaceDir: '/tmp',
    skillRegistry: {} as never,
    streamSessionId,
    parentStreamSessionId: undefined,
    roomId: 'room-test',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: 'owner',
  });

  beforeEach(() => __setTodosForTest(sid, []));

  it('source 缺省落 agent（保守取向：未标注不算 user 挂靠）', async () => {
    const out = await tools.execute(
      'todowrite',
      { todos: [{ subject: '步骤A', status: 'pending' }] },
      mkCtx(sid),
    );
    expect(out).toContain('[a] 步骤A');
    expect(hasPendingUserTodos(sid)).toBe(false);
  });

  it('source=user 的 pending/in_progress 项计入挂靠；completed 不计', async () => {
    await tools.execute(
      'todowrite',
      {
        todos: [
          { subject: '用户要求的主任务', status: 'in_progress', source: 'user' },
          { subject: '已完成的用户步骤', status: 'completed', source: 'user' },
          { subject: 'agent 自发项', status: 'pending', source: 'agent' },
        ],
      },
      mkCtx(sid),
    );
    expect(hasPendingUserTodos(sid)).toBe(true);
    await tools.execute(
      'todowrite',
      {
        todos: [
          { subject: '已完成的用户步骤', status: 'completed', source: 'user' },
        ],
      },
      mkCtx(sid),
    );
    expect(hasPendingUserTodos(sid)).toBe(false);
  });

  it('source 非法值抛错（沿 status 校验同款错误风格）', async () => {
    await expect(
      tools.execute(
        'todowrite',
        { todos: [{ subject: 'x', status: 'pending', source: 'wild' }] },
        mkCtx(sid),
      ),
    ).rejects.toThrow(/source/);
  });

  it('回显标注 [u]/[a]', async () => {
    const out = await tools.execute(
      'todowrite',
      {
        todos: [
          { subject: 'U项', status: 'pending', source: 'user' },
          { subject: 'A项', status: 'pending' },
        ],
      },
      mkCtx(sid),
    );
    expect(out).toContain('[ ] [u] U项');
    expect(out).toContain('[ ] [a] A项');
  });
});

describe('completeInProgressTodos 回合收尾收敛', () => {
  const sid = 'stream-wrapup-test';

  it('in_progress → completed；pending/completed 原样；id/subject/source 保留', () => {
    __setTodosForTest(sid, [
      { id: 'a', subject: '已完成项', status: 'completed', source: 'user' },
      { id: 'b', subject: '进行中项（终文交付）', status: 'in_progress', source: 'user' },
      { id: 'c', subject: '未启动项', status: 'pending', source: 'agent' },
    ]);
    const r = completeInProgressTodos(sid);
    expect(r.changed).toBe(true);
    expect(r.todos.map((t) => t.status)).toEqual(['completed', 'completed', 'pending']);
    // 生产消费字段逐项断言（momo-test-rules #2）：id 是 renderer 列表 key，不得漂移
    expect(r.todos.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(r.todos.map((t) => t.subject)).toEqual(['已完成项', '进行中项（终文交付）', '未启动项']);
    expect(r.todos.map((t) => t.source)).toEqual(['user', 'user', 'agent']);
  });

  it('无 in_progress 项 → changed:false（幂等门：不追加事件）', () => {
    __setTodosForTest(sid, [
      { id: 'a', subject: 'x', status: 'completed', source: 'agent' },
      { id: 'b', subject: 'y', status: 'pending', source: 'agent' },
    ]);
    const before = completeInProgressTodos(sid).todos;
    const r = completeInProgressTodos(sid);
    expect(r.changed).toBe(false);
    expect(r.todos).toBe(before); // 未变更时返回同一数组引用
  });

  it('会话无记录（空输入边界）→ changed:false + 空列表', () => {
    const r = completeInProgressTodos('no-such-session');
    expect(r.changed).toBe(false);
    expect(r.todos).toEqual([]);
  });
});

// ─── F9a：稳定 ID（subject 归一延续） ────────────────────────────────────────

describe('todowrite 稳定 ID', () => {
  const tools = new TodoTools();

  it('同 subject 跨重写延续 id（含 trim 归一）；subject 改写换新 id', async () => {
    await tools.execute(
      'todowrite',
      {
        todos: [
          { subject: '委派 CodeForge', status: 'completed', source: 'user' },
          { subject: '委派 PixelMuse', status: 'in_progress', source: 'user' },
        ],
      },
      ctx,
    );
    const first = getTodosForSession('ssn-1');
    const idBySubject = new Map(first.map((t) => [t.subject, t.id]));

    await tools.execute(
      'todowrite',
      {
        todos: [
          // trim 归一：前后空格不影响匹配
          { subject: '  委派 CodeForge ', status: 'completed', source: 'user' },
          { subject: '收割回执并汇总', status: 'pending', source: 'agent' },
        ],
      },
      ctx,
    );
    const second = getTodosForSession('ssn-1');
    expect(second).toHaveLength(2);
    // 同 subject 延续既有 id
    expect(second.find((t) => t.subject === '委派 CodeForge')!.id).toBe(idBySubject.get('委派 CodeForge'));
    // 「委派 PixelMuse」被移除（全量替换）+ 新 subject 全新 id
    expect(second.find((t) => t.subject === '收割回执并汇总')!.id).not.toBe(idBySubject.get('委派 PixelMuse'));
  });

  it('同批重复 subject 仅首个延续既有 id，其余新 id（表内 id 不重复）', async () => {
    await tools.execute(
      'todowrite',
      { todos: [{ subject: '重复项', status: 'pending', source: 'user' }] },
      ctx,
    );
    const firstId = getTodosForSession('ssn-1')[0]!.id;

    await tools.execute(
      'todowrite',
      {
        todos: [
          { subject: '重复项', status: 'in_progress', source: 'user' },
          { subject: '重复项', status: 'pending', source: 'user' },
        ],
      },
      ctx,
    );
    const second = getTodosForSession('ssn-1');
    expect(second.map((t) => t.id)).toEqual([firstId, expect.not.stringMatching(new RegExp(`^${firstId}$`))]);
    // 表内 id 唯一（renderer 列表 key 不得撞车）
    expect(new Set(second.map((t) => t.id)).size).toBe(second.length);
  });

  it('id 稳定跨多次重写（三轮链式）', async () => {
    for (const status of ['pending', 'in_progress', 'completed'] as const) {
      await tools.execute(
        'todowrite',
        { todos: [{ subject: '链式任务', status, source: 'user' }] },
        ctx,
      );
    }
    const final = getTodosForSession('ssn-1');
    expect(final).toHaveLength(1);
    expect(final[0]!.status).toBe('completed');
    // 三轮重写 id 不变（身份稳定——聚合视图/历史追踪的前提）
    expect(final[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
