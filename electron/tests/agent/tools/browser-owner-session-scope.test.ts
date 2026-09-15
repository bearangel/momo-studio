// electron/tests/agent/tools/browser-owner-session-scope.test.ts
//
// 归属键会话作用域回归锁（2026-09-15 主机验收 P1 复发）：
// 快速会话共用 workspace 默认 agent 实例 → 两会话 agentInstanceId 相同 →
// 纯实例键 ownerId 相同 → 同一 tab 集合同一光标，抢占复发。
// 修复：ownerId 复合化 `${roomId}:${agentInstanceId}`（会话内 agent 隔离；
// 无会话上下文退化为纯实例键；无 agent 身份归 'user'）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserTools, __resetBrowserToolsForTest, initBrowserTools } from '../../../src/main/agent/tools/browser-tools';
import { USER_OP_CTX, type BrowserOpCtx } from '../../../src/main/browser/op-protocol';
import type { BrowserManagerPort, BrowserPolicyPort } from '../../../src/main/agent/tools/browser-tools';
import type { ToolContext } from '../../../src/main/agent/tools/types';

function mkCtx(roomId: string, agentInstanceId?: string): ToolContext {
  return {
    wsFs: {} as never,
    workspaceId: 'w1',
    workspaceDir: '/tmp',
    skillRegistry: {} as never,
    streamSessionId: `stream-${roomId}`,
    roomId,
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: 'u1',
    agentInstanceId,
  };
}

describe('归属键会话作用域（ownerId 复合化）', () => {
  const makeNavigateMock = () =>
    vi.fn(async (_wsId: string, _url: string, _ctx: BrowserOpCtx) => ({ url: 'https://example.com', title: 'E' }));
  /** 第 i 次调用透传的归属身份（断言取值单点） */
  const ctxOf = (i: number): BrowserOpCtx => navigate.mock.calls[i]![2];
  let navigate: ReturnType<typeof makeNavigateMock>;
  let tools: BrowserTools;

  beforeEach(() => {
    navigate = makeNavigateMock();
    const manager = { navigate } as unknown as BrowserManagerPort;
    const policy = { assertAllowed: () => {}, assertEvaluate: () => {} } as unknown as BrowserPolicyPort;
    initBrowserTools(policy, manager);
    tools = new BrowserTools();
    return () => __resetBrowserToolsForTest();
  });

  it('同实例不同会话 → ownerId 不同（会话隔离，P1 复发回归锁）', async () => {
    await tools.execute('browser_navigate', { url: 'https://a.com' }, mkCtx('sess-1', 'inst-x'));
    await tools.execute('browser_navigate', { url: 'https://b.com' }, mkCtx('sess-2', 'inst-x'));
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(ctxOf(0)).toEqual({ ownerId: 'sess-1:inst-x', sessionId: 'sess-1' });
    expect(ctxOf(1)).toEqual({ ownerId: 'sess-2:inst-x', sessionId: 'sess-2' });
  });

  it('同会话同实例 → ownerId 稳定（会话内连续性）', async () => {
    await tools.execute('browser_navigate', { url: 'https://a.com' }, mkCtx('sess-1', 'inst-x'));
    await tools.execute('browser_navigate', { url: 'https://b.com' }, mkCtx('sess-1', 'inst-x'));
    expect(ctxOf(0).ownerId).toBe(ctxOf(1).ownerId);
  });

  it('无会话上下文（roomId 空）→ 退化为纯实例键（后台任务共享集合）', async () => {
    await tools.execute('browser_navigate', { url: 'https://a.com' }, mkCtx('', 'inst-x'));
    expect(ctxOf(0).ownerId).toBe('inst-x');
  });

  it('无 agent 身份 → 缺省用户键（不复合）', async () => {
    await tools.execute('browser_navigate', { url: 'https://a.com' }, mkCtx('sess-1'));
    expect(ctxOf(0).ownerId).toBe(USER_OP_CTX.ownerId);
  });
});
