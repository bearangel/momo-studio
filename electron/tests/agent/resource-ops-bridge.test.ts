// electron/tests/agent/resource-ops-bridge.test.ts
//
// resource-ops 桥主进程侧分支单测（spec 2026-11-09-resource-creation-skills §6）。
// executor 注入 fake——纯函数化锁线协议（type/id 配对、error string 化、非本分支不消费）。
// 桥模块 import resource-ops → crud.ts 引入的 runtime 依赖在测试环境不可用，
// 与 resource-ops.test.ts 同款 mock。
import { describe, it, expect, vi } from 'vitest';
import { handleResourceOpMessage, notifyResourceOpSucceeded, MEMBER_AFFECTING_OPS } from '../../src/main/agent/resource-ops-bridge';
import { broadcastRuntimeChanged } from '../../src/main/im/session-service';
import { broadcastResourceChanged } from '../../src/main/resource/changed-emit';

vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  stopAgentRuntime: vi.fn(),
}));
vi.mock('../../src/main/im/session-service', () => ({
  broadcastRuntimeChanged: vi.fn(),
}));
vi.mock('../../src/main/resource/changed-emit', () => ({
  broadcastResourceChanged: vi.fn(),
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

  it('list 成功不广播刷新（只读 op——技能「创建前先盘点」高频触发，不得引发 renderer 重拉）', async () => {
    vi.mocked(broadcastResourceChanged).mockClear();
    vi.mocked(broadcastRuntimeChanged).mockClear();
    const send = vi.fn();
    await handleResourceOpMessage(
      { type: 'resource-op', id: 'r-list', op: 'list', args: {} },
      'ws-1',
      send,
      async () => ({ agents: [] }),
    );
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'resource-op', id: 'r-list' }));
    expect(broadcastResourceChanged).not.toHaveBeenCalled();
    expect(broadcastRuntimeChanged).not.toHaveBeenCalled();
  });

  it('写 op 成功广播 resource:changed（member 类额外广播 runtimeChanged）', async () => {
    vi.mocked(broadcastResourceChanged).mockClear();
    vi.mocked(broadcastRuntimeChanged).mockClear();
    const send = vi.fn();
    await handleResourceOpMessage(
      { type: 'resource-op', id: 'r-cs', op: 'createSkill', args: {} },
      'ws-1',
      send,
      async () => ({ slug: 's' }),
    );
    expect(broadcastResourceChanged).toHaveBeenCalledTimes(1);
    expect(broadcastRuntimeChanged).not.toHaveBeenCalled();

    await handleResourceOpMessage(
      { type: 'resource-op', id: 'r-ct', op: 'createTeam', args: {} },
      'ws-1',
      send,
      async () => ({ teamId: 't' }),
    );
    expect(broadcastResourceChanged).toHaveBeenCalledTimes(2);
    expect(broadcastRuntimeChanged).toHaveBeenCalledTimes(1);

    // MEMBER_AFFECTING_OPS = createAgent | addMember | createTeam（语义固定）
    expect(MEMBER_AFFECTING_OPS).toContain('createTeam');
  });
});
