// electron/tests/agent/tools/todo-tools.test.ts
// v1.5 todowrite 工具后端测试。覆盖：
//   - 全量替换语义（创建/混合状态/清空）
//   - 输入校验（subject 缺失 / status 非法 / subject 过长 / 数量超限）
//   - 会话隔离（不同 streamSessionId 不串数据）
//   - StreamChunk 推送（todo_update chunk 携带完整 todos）

import { describe, it, expect, beforeEach } from 'vitest';
import { TodoTools } from '../../../src/main/agent/tools/todo-tools';
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
  };
});

describe('todowrite', () => {
  it('创建 3 项 pending', async () => {
    const tools = new TodoTools();
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
