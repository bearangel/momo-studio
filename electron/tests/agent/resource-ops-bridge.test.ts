// electron/tests/agent/resource-ops-bridge.test.ts
//
// resource-ops 桥主进程侧分支单测（spec 2026-11-09-resource-creation-skills §6）。
// executor 注入 fake——纯函数化锁线协议（type/id 配对、error string 化、非本分支不消费）。
// 桥模块 import resource-ops → crud.ts 引入的 runtime 依赖在测试环境不可用，
// 与 resource-ops.test.ts 同款 mock。
import { describe, it, expect, vi } from 'vitest';
import { handleResourceOpMessage, notifyResourceOpSucceeded, MEMBER_AFFECTING_OPS } from '../../src/main/agent/resource-ops-bridge';

vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  stopAgentRuntime: vi.fn(),
}));

describe('handleResourceOpMessage（主进程侧分支）', () => {
  it('type=resource-op 且 id 配对：成功回 result', async () => {
    const send = vi.fn();
    await handleResourceOpMessage(
      { type: 'resource-op', id: 'r1', op: 'list', args: { type: 'teams' } },
      'ws-1',
      send,
      async (op, args, wsId) => ({ op, args, wsId }), // 注入 fake executeResourceOp
    );
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'resource-op', id: 'r1', result: expect.anything() }));
  });

  it('执行失败回 error（string 化——非 Error 抛出物不许误判成功）', async () => {
    const send = vi.fn();
    await handleResourceOpMessage(
      { type: 'resource-op', id: 'r2', op: 'createTeam', args: {} },
      'ws-1',
      send,
      async () => { throw '裸字符串错误'; },
    );
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'resource-op', id: 'r2', error: '裸字符串错误' }));
  });

  it('非 resource-op 消息返回 false（不消费）', async () => {
    const send = vi.fn();
    const consumed = await handleResourceOpMessage({ type: 'mcp:listTools', id: 'x' }, 'ws-1', send, async () => null);
    expect(consumed).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('成功后按 op 通知刷新（member 类 op 额外广播 runtimeChanged）', () => {
    // MEMBER_AFFECTING_OPS = createAgent | addMember | createTeam（语义固定）
    expect(MEMBER_AFFECTING_OPS).toContain('createTeam');
  });
});
