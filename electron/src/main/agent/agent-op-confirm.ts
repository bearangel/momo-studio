// electron/src/main/agent/agent-op-confirm.ts
// 扩权确认通道（spec §7）：主进程单点裁决，四出口（allow/deny/timeout/child 退出）。
// electron API 经 electron-access 惰性取用（子进程可达共享模块禁止顶层 import
// 'electron'；vi.mock 拦不到 raw require，测试经 __setElectronApisForTest 注入）。
import { randomUUID } from 'node:crypto';
import { logger } from '../logger';
import { loadElectronApis } from '../electron-access';

export const AGENT_OP_CONFIRM_REQUEST_CHANNEL = 'agent-op-confirm:request';
export const CONFIRM_WAIT_MS = 10 * 60_000; // 对齐 write-grant F5（spec §7.2）

export interface AgentOpConfirmPayload {
  requestId: string;
  workspaceId: string;
  requester: { agentName: string; op: string; toolName: string };
  diff: {
    target: { kind: 'member' | 'definition' | 'skill' | 'mcp'; name: string; workspaceName?: string };
    scope?: 'member' | 'definition';
    adds: Array<{ field: 'skills' | 'mcps' | 'tools' | 'pluginTools'; ref: string }>;
    removes: Array<{ field: 'skills' | 'mcps' | 'tools' | 'pluginTools'; ref: string }>;
    fieldChanges?: Array<{ field: string; before?: string; after?: string }>;
  };
  riskNote?: string;
  expiresAt: number;
}
export type AgentOpConfirmOutcome = { allowed: boolean; reason: string };

interface PendingEntry {
  payload: AgentOpConfirmPayload;
  resolve: (o: AgentOpConfirmOutcome) => void;
  childKey: string;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingEntry>();

function broadcast(channel: string, payload: unknown): number {
  const { BrowserWindow } = loadElectronApis();
  if (!BrowserWindow) return 0;
  let live = 0;
  for (const w of BrowserWindow.getAllWindows()) {
    // 析构竞态守卫（F3）：send 打在已毁窗口上会抛「Object has been destroyed」；
    // 计数只含实际送达的窗口——全部已毁视同无人在场，立即拒绝
    if (w.isDestroyed()) continue;
    w.webContents.send(channel, payload);
    live++;
  }
  return live;
}

/** 先到先得结算（四出口共用）：已结算/不存在的 requestId 静默 no-op。 */
function settle(id: string, o: AgentOpConfirmOutcome): void {
  const e = pending.get(id);
  if (!e) return;
  clearTimeout(e.timer);
  pending.delete(id);
  logger.info('能力变更确认裁决', { requestId: id, op: e.payload.requester.op, allowed: o.allowed, reason: o.reason });
  e.resolve(o);
}

export function requestAgentOpConfirm(
  base: Omit<AgentOpConfirmPayload, 'requestId' | 'expiresAt'>,
  childKey: string,
): Promise<AgentOpConfirmOutcome> {
  const payload: AgentOpConfirmPayload = { ...base, requestId: randomUUID(), expiresAt: Date.now() + CONFIRM_WAIT_MS };
  return new Promise((resolve) => {
    const winCount = broadcast(AGENT_OP_CONFIRM_REQUEST_CHANNEL, payload);
    if (winCount === 0) { resolve({ allowed: false, reason: '当前无可用窗口（无人在场），已拒绝' }); return; }
    const timer = setTimeout(() => settle(payload.requestId, { allowed: false, reason: `确认超时（${CONFIRM_WAIT_MS / 60000} 分钟未处置），已拒绝` }), CONFIRM_WAIT_MS);
    timer.unref?.();
    pending.set(payload.requestId, { payload, resolve, childKey, timer });
  });
}

/** 请求方运行时退出：该 childKey 全部在途确认按拒绝收敛（Review Focus ①）。 */
export function resolvePendingByChildExit(childKey: string): void {
  for (const [id, e] of [...pending]) {
    if (e.childKey === childKey) settle(id, { allowed: false, reason: '请求方运行时已退出，确认取消' });
  }
}

export function registerAgentOpConfirmHandlers(): void {
  const { ipcMain } = loadElectronApis();
  if (!ipcMain) return;
  ipcMain.handle('agent-op-confirm:reply', (_evt, input: { requestId?: unknown; allowed?: unknown }) => {
    if (typeof input?.requestId !== 'string') return { skipped: true };
    const known = pending.has(input.requestId);
    settle(input.requestId, { allowed: input.allowed === true, reason: input.allowed === true ? '' : '用户在确认卡上拒绝了本次变更' });
    return { skipped: !known };
  });
}

// 测试后门
export async function __resolveForTest(id: string, allowed: boolean): Promise<{ skipped: boolean }> {
  const known = pending.has(id);
  settle(id, { allowed, reason: allowed ? '' : '测试拒绝' });
  return { skipped: !known };
}
export function __resetPendingForTest(): void {
  for (const [, e] of pending) { clearTimeout(e.timer); e.resolve({ allowed: false, reason: '测试重置' }); }
  pending.clear();
}
