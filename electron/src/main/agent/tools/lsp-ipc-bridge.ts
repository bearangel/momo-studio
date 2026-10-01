// electron/src/main/agent/tools/lsp-ipc-bridge.ts
// LSP 工具子进程 IPC 桥（browser-ipc-bridge 同型第三例，spec §7/§8）：
// 真实 LspManager 只活在主进程，子进程经 fork IPC 往返。
// 错误路径铁律照抄：ok:false → Error(message)；超时 reject 中文 + 清 pending；
// process.send 缺失立即 reject。
import { randomUUID } from 'node:crypto';

const TIMEOUT_MESSAGE = 'LSP IPC 无响应（主进程未接线或超时）';
const NO_SEND_MESSAGE = 'LSP IPC 不可用（process.send 缺失：非 fork 子进程环境）';

/** 冷启动联动：gopls/clangd 首调 30s+ 诊断计算，桥超时必须远大于之 */
export const LSP_OP_BRIDGE_TIMEOUT_MS = 120_000;

interface PendingEntry {
  resolve: (s: string) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}
const pending = new Map<string, PendingEntry>();

export function sendLspOp(op: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(new Error(NO_SEND_MESSAGE));
      return;
    }
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(TIMEOUT_MESSAGE));
    }, LSP_OP_BRIDGE_TIMEOUT_MS);
    timer.unref?.();
    pending.set(requestId, { resolve, reject, timer });
    try {
      // 必须以 process.send(...) 方法调用形式发送：Node 内部实现读取 this.connected，
      // 解构后裸调用在严格模式下 this=undefined 直接抛错（P0-1 教训，桥同型遵守）
      process.send({ type: 'lsp:op', requestId, op });
    } catch (err) {
      const e = pending.get(requestId);
      if (e) { clearTimeout(e.timer); pending.delete(requestId); }
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function handleLspOpResult(msg: unknown): void {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as { type?: string; requestId?: string; ok?: boolean; result?: string; error?: string };
  if (m.type !== 'lsp:op-result' || typeof m.requestId !== 'string') return;
  const entry = pending.get(m.requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(m.requestId);
  if (m.ok) entry.resolve(m.result ?? '');
  else entry.reject(new Error(m.error ?? 'LSP 调用失败'));
}

/** 测试钩子：注册伪 pending 拿 requestId（子进程无 process.send 时经此构造在途请求） */
export async function __testRegisterPending(
  resolve: (s: string) => void,
  reject: (e: Error) => void,
): Promise<string> {
  const requestId = randomUUID();
  const timer = setTimeout(() => pending.delete(requestId), 5_000);
  pending.set(requestId, { resolve, reject, timer });
  return requestId;
}
