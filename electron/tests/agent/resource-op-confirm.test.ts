// electron/tests/agent/resource-op-confirm.test.ts
// 确认通道四出口 + 先到先得（spec §7）。electron 假件：BrowserWindow.getAllWindows / ipcMain.handle。
// 注：vi.mock 只拦 transformed import、不拦 electron-access 内部的 raw require()
//（stream-relay.test.ts 同款结论），故经 __setElectronApisForTest 显式注入。
import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';

const windows: Array<{ isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } }> = [];
import { __setElectronApisForTest } from '../../src/main/electron-access';

beforeAll(() => {
  __setElectronApisForTest({
    BrowserWindow: { getAllWindows: () => windows },
    ipcMain: { handle: vi.fn() },
  });
});
afterAll(() => { __setElectronApisForTest(null); });

import {
  requestAgentOpConfirm, resolvePendingByChildExit, CONFIRM_WAIT_MS,
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
