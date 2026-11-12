// electron/tests/agent/resource-op-confirm.test.ts
// 确认通道四出口 + 先到先得（spec §7）。electron 假件：BrowserWindow.getAllWindows / ipcMain.handle。
// 注：vi.mock 只拦 transformed import、不拦 electron-access 内部的 raw require()
//（stream-relay.test.ts 同款结论），故经 __setElectronApisForTest 显式注入。
import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';

const windows: Array<{ isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } }> = [];
import { __setElectronApisForTest } from '../../src/main/electron-access';

// 捕获 ipcMain.handle 注册的 listener——reply 出口契约测试直接调用该 fn
const ipcMainHandleMock = vi.fn();

beforeAll(() => {
  __setElectronApisForTest({
    BrowserWindow: { getAllWindows: () => windows },
    ipcMain: { handle: ipcMainHandleMock },
  });
});
afterAll(() => { __setElectronApisForTest(null); });

import {
  requestAgentOpConfirm, resolvePendingByChildExit, registerAgentOpConfirmHandlers, CONFIRM_WAIT_MS,
  __resolveForTest, __resetPendingForTest,
} from '../../src/main/agent/agent-op-confirm';

beforeEach(() => { windows.length = 0; __resetPendingForTest(); });

describe('requestAgentOpConfirm', () => {
  const base = {
    workspaceId: 'ws', requester: { agentName: 'Momo', op: 'updateCapabilities', toolName: 'update_agent_capabilities' },
    diff: { target: { kind: 'member' as const, name: 'A' }, adds: [{ field: 'skills' as const, ref: 'weather' }], removes: [] },
  };

  it('allow 出口：广播 → reply(true) → resolve allowed', async () => {
    const w = { isDestroyed: () => false, webContents: { send: vi.fn() } }; windows.push(w);
    const p = requestAgentOpConfirm(base, 'child-1');
    expect(w.webContents.send).toHaveBeenCalledTimes(1);
    const payload = w.webContents.send.mock.calls[0]![1];
    await __resolveForTest(payload.requestId, true);
    await expect(p).resolves.toEqual({ allowed: true, reason: '' });
  });

  it('deny 出口：reason 回传', async () => {
    windows.push({ isDestroyed: () => false, webContents: { send: vi.fn() } });
    const p = requestAgentOpConfirm(base, 'child-1');
    const payload = windows[0]!.webContents.send.mock.calls[0]![1];
    await __resolveForTest(payload.requestId, false);
    await expect(p).resolves.toMatchObject({ allowed: false });
  });

  it('timeout 出口：CONFIRM_WAIT_MS 后按拒绝收敛（文案含「确认超时」）', async () => {
    vi.useFakeTimers();
    windows.push({ isDestroyed: () => false, webContents: { send: vi.fn() } });
    const p = requestAgentOpConfirm(base, 'child-1');
    vi.advanceTimersByTime(CONFIRM_WAIT_MS + 1);
    await expect(p).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining('确认超时') });
    vi.useRealTimers();
  });

  it('child 退出出口：resolvePendingByChildExit 按拒绝收敛（Review Focus ①）', async () => {
    windows.push({ isDestroyed: () => false, webContents: { send: vi.fn() } });
    const p = requestAgentOpConfirm(base, 'child-9');
    resolvePendingByChildExit('child-9');
    await expect(p).resolves.toMatchObject({ allowed: false });
  });

  it('先到先得：迟到的 reply 是 no-op（Review Focus ②）', async () => {
    windows.push({ isDestroyed: () => false, webContents: { send: vi.fn() } });
    const p = requestAgentOpConfirm(base, 'child-1');
    const payload = windows[0]!.webContents.send.mock.calls[0]![1];
    await __resolveForTest(payload.requestId, true);
    await expect(__resolveForTest(payload.requestId, true)).resolves.toMatchObject({ skipped: true });
    await expect(p).resolves.toMatchObject({ allowed: true });
  });

  it('零窗口（无人在场）→ 立即拒绝不广播', async () => {
    await expect(requestAgentOpConfirm(base, 'child-1')).resolves.toMatchObject({ allowed: false });
  });

  it('expiresAt = now + CONFIRM_WAIT_MS；requestId 为 UUID', async () => {
    windows.push({ isDestroyed: () => false, webContents: { send: vi.fn() } });
    requestAgentOpConfirm(base, 'child-1');
    const payload = windows[0]!.webContents.send.mock.calls[0]![1];
    expect(payload.expiresAt).toBeGreaterThan(Date.now() + CONFIRM_WAIT_MS - 5_000);
    expect(payload.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('registerAgentOpConfirmHandlers（reply IPC 出口——生产注册路径）', () => {
  const base = {
    workspaceId: 'ws', requester: { agentName: 'Momo', op: 'updateSkill', toolName: 'update_skill' },
    diff: { target: { kind: 'skill' as const, name: 's' }, adds: [], removes: [] },
  };

  it('未知 requestId → {skipped:true} 不抛错；在途 requestId → 结算并 resolve 请求方', async () => {
    registerAgentOpConfirmHandlers();
    expect(ipcMainHandleMock).toHaveBeenCalledWith('agent-op-confirm:reply', expect.any(Function));
    const handler = ipcMainHandleMock.mock.calls[0]![1] as (
      evt: unknown,
      input: { requestId?: unknown; allowed?: unknown },
    ) => { skipped: boolean };

    // 未知 id：静默 no-op（防多窗口重复处置后迟到的 reply）
    expect(handler({}, { requestId: 'ghost', allowed: true })).toEqual({ skipped: true });

    // 在途 id：先到先得结算——请求方 resolve allowed
    windows.push({ isDestroyed: () => false, webContents: { send: vi.fn() } });
    const p = requestAgentOpConfirm(base, 'child-h');
    const payload = windows[0]!.webContents.send.mock.calls[0]![1];
    expect(handler({}, { requestId: payload.requestId, allowed: true })).toEqual({ skipped: false });
    await expect(p).resolves.toEqual({ allowed: true, reason: '' });
  });
});
