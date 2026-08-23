// electron/tests/agent/router-bootstrap.test.ts
//
// RouterService lazy 启动器（router-bootstrap.ts）单元测试。
//
// 覆盖 5 个用例：
//   1. 首次调用：启动 RouterService + setRouterService
//   2. 二次调用：no-op（currentRouterService 已存在）
//   3. runners.size === 0 时 no-op
//   4. destroyRouterService：清理 + setRouterService(null)
//   5. destroyRouterService 在 currentRouterService=null 时 no-op
//
// setRouterService（sync-manager）/ logger / TaskDispatcher 全部 mock，
// 测试聚焦于 router-bootstrap 模块自身的状态机。

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock setRouterService（sync-manager 模块）避免依赖 Matrix client
vi.mock('../../src/main/matrix/sync-manager', () => ({
  setRouterService: vi.fn(),
}));

// Mock logger（不输出噪声）
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock TaskDispatcher（不依赖真实 dispatcher 逻辑）
vi.mock('../../src/main/task/dispatcher', () => ({
  TaskDispatcher: vi.fn().mockImplementation(() => ({ scanPickup: vi.fn() })),
}));

import {
  ensureRouterService,
  destroyRouterService,
  __resetRouterServiceForTest,
} from '../../src/main/agent/router-bootstrap';
import { setRouterService } from '../../src/main/matrix/sync-manager';
import { RouterService } from '../../src/main/agent/router-service';
import type { AgentRunner } from '../../src/main/agent/agent-runner';
import type { ProviderTokenBucket } from '../../src/main/agent/llm/token-bucket';

// 测试用 fake runner + bucket（不依赖真实 spawn）
function makeFakeRunner(id: string): AgentRunner {
  return {
    assignmentId: id,
    botUserId: `@${id}:localhost`,
    workspaceId: 'ws-test',
    executeTask: vi.fn(),
    abortStream: vi.fn(),
    activeTaskCount: vi.fn().mockReturnValue(0),
    notifyTaskReply: vi.fn(),
    destroy: vi.fn(),
  } as unknown as AgentRunner;
}

function makeFakeBuckets(): Map<string, ProviderTokenBucket> {
  const m = new Map<string, ProviderTokenBucket>();
  m.set('provider-1', { tryConsume: vi.fn().mockReturnValue(true) } as unknown as ProviderTokenBucket);
  return m;
}

describe('router-bootstrap (Task 1)', () => {
  beforeEach(() => {
    __resetRouterServiceForTest();
    vi.clearAllMocks();
  });

  it('首次调用：启动 RouterService + setRouterService', async () => {
    const runners = new Map<string, AgentRunner>();
    runners.set('inst-1', makeFakeRunner('inst-1'));
    const buckets = makeFakeBuckets();

    await ensureRouterService(runners, buckets);

    expect(setRouterService).toHaveBeenCalledOnce();
    // 验证传入的是 RouterService 实例（或 duck-type 兼容对象）
    const svc = (setRouterService as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(svc).toBeDefined();
    expect(typeof (svc as RouterService).routeEvent).toBe('function');
  });

  it('二次调用：no-op（currentRouterService 已存在）', async () => {
    const runners = new Map<string, AgentRunner>();
    runners.set('inst-1', makeFakeRunner('inst-1'));
    const buckets = makeFakeBuckets();

    await ensureRouterService(runners, buckets);
    await ensureRouterService(runners, buckets);  // 第二次

    // setRouterService 应只被调用 1 次（首次启动时）
    expect(setRouterService).toHaveBeenCalledOnce();
  });

  it('runners.size === 0 时 no-op', async () => {
    const runners = new Map<string, AgentRunner>();
    const buckets = makeFakeBuckets();

    await ensureRouterService(runners, buckets);

    expect(setRouterService).not.toHaveBeenCalled();
  });

  it('destroyRouterService：清理 + setRouterService(null)', async () => {
    const runners = new Map<string, AgentRunner>();
    runners.set('inst-1', makeFakeRunner('inst-1'));
    const buckets = makeFakeBuckets();
    await ensureRouterService(runners, buckets);
    vi.clearAllMocks();

    destroyRouterService();

    expect(setRouterService).toHaveBeenCalledWith(null);
  });

  it('destroyRouterService 在 currentRouterService=null 时 no-op', () => {
    expect(() => destroyRouterService()).not.toThrow();
    // setRouterService 不应被调用（无 service 可销毁）
    expect(setRouterService).not.toHaveBeenCalled();
  });
});