// electron/tests/agent/router-context.test.ts
//
// 接线锁（momo-boundary-rules 第 4 条）：context 从 routeUserChat 注入 TaskConfig 与
// steer 分支——摘掉任何一跳的透传该锁必红。
//
// 保真度约定（momo-test-rules）：
//   - Mock 收窄到 runner 边界（结构子集，as never 构造）；路由/车道/expander 走真实实现
//   - setExpanderDeps 清空 skill 根 + workspace 目录解析——expander 走纯降级路径
//     （skill → '[skill 已不可用]' 占位、文件 → content=null），断言不依赖环境
//   - 车道（session-lane）是模块级内存态：beforeEach 清空防跨用例污染
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { RouterService } from '../../src/main/agent/router-service';
import { registerLane, __clearLaneForTest } from '../../src/main/agent/session-lane';
import { setExpanderDeps } from '../../src/main/im/context-expander';

function mkRunner() {
  return {
    executeTask: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockReturnValue(true),
    abortStream: vi.fn(),
    notifyTaskReply: vi.fn(),
  };
}

beforeAll(() => {
  setExpanderDeps({ skillRoots: [], workspaceDir: () => null });
});

afterAll(() => {
  setExpanderDeps({});
});

beforeEach(() => {
  __clearLaneForTest();
});

describe('routeUserChat context 接线', () => {
  it('executeTask 路径：TaskConfig 携带展开后的 ExpandedContext', async () => {
    const runner = mkRunner();
    const svc = new RouterService({
      runners: new Map([['a1', runner as never]]),
    } as never);
    const ctx = { skills: [{ slug: 's', name: 'n' }], files: [] };
    await svc.routeUserChat({ sessionId: 's1', assignmentId: 'a1', body: 'hi', context: ctx });
    const task = runner.executeTask.mock.calls[0]![0];
    expect(task.context).toBeDefined();
    expect(task.context.skills[0]!.slug).toBe('s');
    expect(task.context.skills[0]!.body).toBe('[skill 已不可用]'); // 测试环境无 skill 根 → 降级占位
  });

  it('steer 路径：展开后 context 作为第 3 参下发', async () => {
    const runner = mkRunner();
    // 占道：先注册车道，再触发 steer 分流（kickoff=false 保持手输语义）
    const svc = new RouterService({
      runners: new Map([['a1', runner as never]]),
    } as never);
    const ctx = { skills: [], files: [{ path: 'a.ts' }] };
    registerLane('s2', { taskId: null, streamSessionId: 'str-1', assignmentId: 'a1' }, { kickoff: false });
    await svc.routeUserChat({ sessionId: 's2', assignmentId: 'a1', body: '补充', context: ctx });
    expect(runner.steer).toHaveBeenCalledWith(
      'str-1',
      '补充',
      expect.objectContaining({ files: expect.any(Array) }),
    );
  });

  it('无 context 时 TaskConfig.context 为 undefined（向后兼容）', async () => {
    const runner = mkRunner();
    const svc = new RouterService({
      runners: new Map([['a1', runner as never]]),
    } as never);
    await svc.routeUserChat({ sessionId: 's3', assignmentId: 'a1', body: 'hi' });
    const task = runner.executeTask.mock.calls[0]![0];
    expect(task.context).toBeUndefined();
  });
});
