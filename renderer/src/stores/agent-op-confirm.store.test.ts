// renderer/src/stores/agent-op-confirm.store.test.ts
// 扩权确认卡状态（spec 2026-11-12 §7）：pending 单卡 + reply 先到先得 + TTL 清扫。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAgentOpConfirmStore } from './agent-op-confirm.store';
import { ipc } from '../ipc/client';
import type { AgentOpConfirmPayload } from '../ipc/types';

vi.mock('../ipc/client', () => ({
  ipc: { agent: { replyAgentOpConfirm: vi.fn(async () => ({ skipped: false })) } },
}));

const replyMock = vi.mocked(ipc.agent.replyAgentOpConfirm);

function payload(overrides?: Partial<AgentOpConfirmPayload>): AgentOpConfirmPayload {
  return {
    requestId: 'req-1',
    workspaceId: 'w1',
    requester: { agentName: 'Momo', op: 'updateCapabilities', toolName: 'update_agent_capabilities' },
    diff: {
      target: { kind: 'member', name: '翻译官', workspaceName: '当前工作空间' },
      scope: 'member',
      adds: [{ field: 'skills', ref: 'weather' }],
      removes: [],
    },
    expiresAt: Date.now() + 10 * 60_000,
    ...overrides,
  };
}

beforeEach(() => {
  useAgentOpConfirmStore.getState().__resetForTest();
  replyMock.mockReset();
  replyMock.mockResolvedValue({ skipped: false });
});

describe('agent-op-confirm.store（spec 2026-11-12 §7）', () => {
  it('receive 置 pending；后续 receive 覆盖为最新（单卡）', () => {
    useAgentOpConfirmStore.getState().receive(payload());
    useAgentOpConfirmStore.getState().receive(payload({ requestId: 'req-2' }));
    expect(useAgentOpConfirmStore.getState().pending?.requestId).toBe('req-2');
  });

  it('receive 到达即过期（expiresAt 已过）→ 不置 pending（主进程超时兜底拒绝）', () => {
    useAgentOpConfirmStore.getState().receive(payload({ expiresAt: Date.now() - 1 }));
    expect(useAgentOpConfirmStore.getState().pending).toBeNull();
  });

  it('reply(true) → replyAgentOpConfirm(requestId, true) 且清 pending', async () => {
    useAgentOpConfirmStore.getState().receive(payload());
    await useAgentOpConfirmStore.getState().reply(true);
    expect(replyMock).toHaveBeenCalledWith('req-1', true);
    expect(useAgentOpConfirmStore.getState().pending).toBeNull();
  });

  it('reply(false) → replyAgentOpConfirm(requestId, false) 且清 pending', async () => {
    useAgentOpConfirmStore.getState().receive(payload());
    await useAgentOpConfirmStore.getState().reply(false);
    expect(replyMock).toHaveBeenCalledWith('req-1', false);
    expect(useAgentOpConfirmStore.getState().pending).toBeNull();
  });

  it('先到先得：回执 skipped=true（他窗已裁决）→ 同样清卡，静默收敛', async () => {
    useAgentOpConfirmStore.getState().receive(payload());
    replyMock.mockResolvedValue({ skipped: true });
    await useAgentOpConfirmStore.getState().reply(true);
    expect(useAgentOpConfirmStore.getState().pending).toBeNull();
  });

  it('reply IPC 拒绝 → 卡恢复供重试（不静默吞状态）', async () => {
    useAgentOpConfirmStore.getState().receive(payload());
    replyMock.mockRejectedValue(new Error('通道不可用'));
    await useAgentOpConfirmStore.getState().reply(true);
    expect(useAgentOpConfirmStore.getState().pending).not.toBeNull();
    // 重试路径：IPC 恢复后同一 requestId 仍可回执
    replyMock.mockResolvedValue({ skipped: false });
    await useAgentOpConfirmStore.getState().reply(true);
    expect(replyMock).toHaveBeenCalledTimes(2);
    expect(useAgentOpConfirmStore.getState().pending).toBeNull();
  });

  // D1 回归锁（2026-11-13 真机两轮复现）：首笔回包迟迟不达（裁决已被主进程
  // 受理）时，模态遮罩不得阻塞整页——消卡是乐观的，不依赖 invoke 落地。
  it('reply invoke 永不落定 → 立即消卡（乐观 dismiss，遮罩不等回包）', async () => {
    useAgentOpConfirmStore.getState().receive(payload());
    replyMock.mockImplementation(() => new Promise(() => {}));
    void useAgentOpConfirmStore.getState().reply(true);
    // 微任务两拍内（await ipc 前后）即应已消卡
    await Promise.resolve();
    await Promise.resolve();
    expect(useAgentOpConfirmStore.getState().pending).toBeNull();
    // replyPromise 永不落定是 mock 语义本身——不 await（挂起 promise 无 rejection，
    // 不构成 unhandled；用例在此结束即回归锁成立）
  });

  it('reply reject 时若新请求已顶上 → 不覆盖新卡（旧请求主进程超时兜底）', async () => {
    useAgentOpConfirmStore.getState().receive(payload({ requestId: 'req-old' }));
    replyMock.mockRejectedValue(new Error('通道不可用'));
    const replyPromise = useAgentOpConfirmStore.getState().reply(true);
    // invoke 在途期间新请求到达（覆盖式单卡）
    useAgentOpConfirmStore.getState().receive(payload({ requestId: 'req-new' }));
    await replyPromise;
    expect(useAgentOpConfirmStore.getState().pending?.requestId).toBe('req-new');
  });

  it('无 pending 时 reply → 不调 IPC', async () => {
    await useAgentOpConfirmStore.getState().reply(true);
    expect(replyMock).not.toHaveBeenCalled();
  });

  it('dismissExpired：未到期保留；到期清空', () => {
    useAgentOpConfirmStore.getState().receive(payload());
    useAgentOpConfirmStore.getState().dismissExpired();
    expect(useAgentOpConfirmStore.getState().pending).not.toBeNull();

    useAgentOpConfirmStore.setState({ pending: { ...payload(), expiresAt: Date.now() - 1 } });
    useAgentOpConfirmStore.getState().dismissExpired();
    expect(useAgentOpConfirmStore.getState().pending).toBeNull();
  });
});
