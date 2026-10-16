// electron/src/main/agent/plugin-hook-bridge.ts
//
// 子进程侧插件钩子桥（spec §5.2）：preToolUse 同步问询（id 配对 + 5s 超时
// 降级 null——hook 挂了不拦工具，fail-open）；postToolUse fire-and-forget。
// 无 process.send 环境（vitest 直调 doExecuteTool）立即直通——Review Focus #1，
// 这是 runtime-entry-routing 既有测试群的兼容前提。
import { randomUUID } from 'node:crypto';
import type { HookDecision } from '../plugin/hook-bus';

export interface PreToolUseRequest {
  workspaceId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface PostToolUseNotice extends PreToolUseRequest {
  success: boolean;
  durationMs: number;
}

export const PRE_TOOL_USE_TIMEOUT_MS = 5_000;

interface PreToolUseResponse {
  id?: unknown;
  decision?: unknown;
  error?: unknown;
}

/** 聚合决策（主进程 waterfall 结果）——parseDecision 的输出形状 */
export type PreToolUseDecision = HookDecision;

function parseDecision(raw: unknown): HookDecision | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as { action?: unknown; reason?: unknown; args?: unknown };
  if (d.action !== 'deny' && d.action !== 'rewrite') return null;
  return {
    action: d.action,
    reason: typeof d.reason === 'string' ? d.reason : undefined,
    args:
      d.action === 'rewrite' && typeof d.args === 'object' && d.args !== null
        ? (d.args as Record<string, unknown>)
        : undefined,
  };
}

export function requestPreToolUse(payload: PreToolUseRequest): Promise<HookDecision | null> {
  const send = (process as { send?: (m: unknown) => void }).send;
  if (typeof send !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      process.off('message', handler);
      // 超时降级：不拦工具（fail-open），warn 观测
      process.stderr.write(`[plugin-hook] preToolUse 问询超时（${PRE_TOOL_USE_TIMEOUT_MS}ms），直通\n`);
      resolve(null);
    }, PRE_TOOL_USE_TIMEOUT_MS);
    timer.unref?.();
    const handler = (msg: unknown): void => {
      const m = msg as PreToolUseResponse;
      if (m?.id !== id) return;
      process.off('message', handler);
      clearTimeout(timer);
      if (m.error !== undefined) {
        process.stderr.write(`[plugin-hook] preToolUse 主进程处理失败，直通: ${String(m.error)}\n`);
        resolve(null);
        return;
      }
      resolve(parseDecision(m.decision));
    };
    process.on('message', handler);
    send({ type: 'plugin:preToolUse', id, ...payload });
  });
}

export function notifyPostToolUse(notice: PostToolUseNotice): void {
  const send = (process as { send?: (m: unknown) => void }).send;
  send?.({ type: 'plugin:postToolUse', ...notice });
}

/** callService 子进程桥：无 IPC 明确 reject（区别于 preToolUse 的直通语义——
 * 工具需要拿到错误结果而不是静默跳过）；id 配对 + 10s 超时 */
export function requestPluginCallService(
  pluginId: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  const send = (process as { send?: (m: unknown) => void }).send;
  if (typeof send !== 'function') {
    return Promise.reject(new Error(`插件 ${pluginId} 的 callService 桥不可用（无 IPC 通道）`));
  }
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      process.off('message', handler);
      reject(new Error(`插件 ${pluginId} callService 超时`));
    }, 10_000);
    timer.unref?.();
    const handler = (msg: unknown): void => {
      const m = msg as { id?: unknown; result?: unknown; error?: unknown };
      if (m?.id !== id) return;
      process.off('message', handler);
      clearTimeout(timer);
      if (m.error !== undefined) {
        reject(new Error(String(m.error)));
        return;
      }
      resolve(m.result ?? null);
    };
    process.on('message', handler);
    send({ type: 'plugin:callService', id, pluginId, method, params });
  });
}
