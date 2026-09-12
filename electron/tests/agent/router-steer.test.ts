// electron/tests/agent/router-steer.test.ts
//
// routeUserChat steer 分流（v2.3 spec §5.1）：活跃期手输注入，空闲正常派发
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunner } from '../../src/main/agent/agent-runner';
import { RouterService } from '../../src/main/agent/router-service';
import { registerLane, __clearLaneForTest } from '../../src/main/agent/session-lane';

/** 最小 runner 桩：steer / executeTask 可分别断言 */
function mkRunner() {
  return {
    steer: vi.fn(() => true),
    executeTask: vi.fn(async () => ({ streamSessionId: 's-new' })),
    abortTasksBySession: vi.fn(() => false),
  };
}

const runners = new Map<string, AgentRunner>();

/** RouterService 构造（与 router-service.test.ts 既有用法对齐：runners + dispatcher） */
function mkService(): RouterService {
  return new RouterService({ runners, dispatcher: { tryPickup: vi.fn() } as never });
}

beforeEach(() => {
  runners.clear();
  __clearLaneForTest();
});

describe('routeUserChat steer 分流', () => {
  it('车道占用且目标 runner 匹配 → steer 注入，不派发新流', async () => {
    const runner = mkRunner();
    runners.set('asg-1', runner as unknown as AgentRunner);
    registerLane('room-1', { taskId: 'T-1', streamSessionId: 's-a', assignmentId: 'asg-1' });

    await mkService().routeUserChat({ sessionId: 'room-1', assignmentId: 'asg-1', body: '补充：用 pnpm' });

    expect(runner.steer).toHaveBeenCalledWith('s-a', '补充：用 pnpm');
    expect(runner.executeTask).not.toHaveBeenCalled();
  });

  it('车道空闲 → 正常派发（现有行为不变）', async () => {
    const runner = mkRunner();
    runners.set('asg-1', runner as unknown as AgentRunner);

    await mkService().routeUserChat({ sessionId: 'room-1', assignmentId: 'asg-1', body: '新问题' });

    expect(runner.executeTask).toHaveBeenCalledTimes(1);
    expect(runner.steer).not.toHaveBeenCalled();
  });

  it('车道被占但目标是另一 runner（@ 其他成员）→ 正常派发', async () => {
    const leader = mkRunner();
    const other = mkRunner();
    runners.set('asg-leader', leader as unknown as AgentRunner);
    runners.set('asg-other', other as unknown as AgentRunner);
    registerLane('room-1', { taskId: 'T-1', streamSessionId: 's-a', assignmentId: 'asg-leader' });

    await mkService().routeUserChat({ sessionId: 'room-1', assignmentId: 'asg-other', body: '问你一下' });

    expect(other.executeTask).toHaveBeenCalledTimes(1);
    expect(leader.steer).not.toHaveBeenCalled();
  });

  it('systemKickoff 消息不做 steer（车道注册覆盖语义归 Task 3）', async () => {
    const runner = mkRunner();
    runners.set('asg-1', runner as unknown as AgentRunner);
    registerLane('room-1', { taskId: 'T-manual', streamSessionId: 's-a', assignmentId: 'asg-1' });

    await mkService().routeUserChat({
      sessionId: 'room-1', assignmentId: 'asg-1', body: '【任务启动】#T-2',
      systemKickoff: true, sourceTaskId: 'T-2',
    });

    expect(runner.steer).not.toHaveBeenCalled();
    expect(runner.executeTask).toHaveBeenCalledTimes(1);
  });

  it('steer 发送失败（死通道）→ 回退正常派发（spec §5.4）', async () => {
    const runner = mkRunner();
    runner.steer = vi.fn(() => false);
    runners.set('asg-1', runner as unknown as AgentRunner);
    registerLane('room-1', { taskId: 'T-1', streamSessionId: 's-a', assignmentId: 'asg-1' });

    await mkService().routeUserChat({ sessionId: 'room-1', assignmentId: 'asg-1', body: '流刚结束' });

    expect(runner.steer).toHaveBeenCalledTimes(1);
    expect(runner.executeTask).toHaveBeenCalledTimes(1);
  });
});
