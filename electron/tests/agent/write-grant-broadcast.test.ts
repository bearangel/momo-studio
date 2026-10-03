// electron/tests/agent/write-grant-broadcast.test.ts
// 写授权拒绝广播链（spec hard-gate §4.4）：registry 遍历 runner → 活跃流 child.send。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  broadcastWriteGrantDenied,
  __clearRuntimeRegistryForTest,
  __pushRunnerForTest,
} from '../../src/main/agent/runtime-registry';
import type { AgentRunner } from '../../src/main/agent/agent-runner';

beforeEach(() => __clearRuntimeRegistryForTest());
afterEach(() => __clearRuntimeRegistryForTest());

/**
 * stub runner：只实现广播链消费的两个方法 + assignmentId 键
 * （结构 typing——AgentRunner 其余成员不参与本链路）。
 * Preflight Ruling 4：agentRunners Map 实际以 runner.assignmentId 为键
 * （真实 registerTaskDrivenRuntime：agentRunners.set(instanceId, runner)，
 * instanceId 即 AgentRunner.opts.agentAssignmentId，经 getter 暴露为 assignmentId），
 * 故 stub 必须自带唯一 assignmentId 字段以避免 Map.set 互相覆盖。
 */
function stubRunner(active: number, id = `stub-${Math.random().toString(36).slice(2, 10)}`): AgentRunner {
  return {
    assignmentId: id,
    activeTaskCount: () => active,
    notifyWriteGrantDenied: vi.fn(),
  } as unknown as AgentRunner;
}

describe('broadcastWriteGrantDenied（spec §4.4）', () => {
  it('有活跃流的 runner → 推送；无活跃流跳过；返回命中', () => {
    const busy = stubRunner(1, 'busy');
    const idle = stubRunner(0, 'idle');
    __pushRunnerForTest(busy);
    __pushRunnerForTest(idle);
    const hit = broadcastWriteGrantDenied(['/d']);
    expect(hit).toBe(true);
    expect(busy.notifyWriteGrantDenied).toHaveBeenCalledWith(['/d']);
    expect(idle.notifyWriteGrantDenied).not.toHaveBeenCalled();
  });

  it('无 runner / 全空闲 → false', () => {
    expect(broadcastWriteGrantDenied(['/d'])).toBe(false);
    __pushRunnerForTest(stubRunner(0, 'idle'));
    expect(broadcastWriteGrantDenied(['/d'])).toBe(false);
  });

  it('空 dirs 合法载荷（降级卡链路）——原样广播不拦截', () => {
    const busy = stubRunner(1, 'busy-empty');
    __pushRunnerForTest(busy);
    broadcastWriteGrantDenied([]);
    expect(busy.notifyWriteGrantDenied).toHaveBeenCalledWith([]);
  });
});