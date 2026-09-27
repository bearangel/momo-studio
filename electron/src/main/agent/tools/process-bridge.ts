// electron/src/main/agent/tools/process-bridge.ts
//
// 回合进程管理子进程 IPC 桥（2026-09-25 生命周期立项 E-A，镜像
// net-trust-bridge.ts 结构）。背景：seatbelt 的 signal 过滤器无法表达
// 「自身进程组」（pgrp 变体语法实测全非法），沙箱内 agent 连自己启动的
// dev server 都杀不掉——本桥把 process_list / process_kill 代理为主进程
// 侧执行，授权口径 = 该回合登记的进程组（sandbox/process-registry）。
// 不放宽沙箱一寸；主进程沙箱外执行 + 精确授权 + 跨平台。
//
// 线协议（两端同 commit 修改——momo-boundary-rules 生产者消费者成对）：
//   child → main: { type: 'process-op', requestId, op: 'list' | 'kill' | 'keep',
//                   streamSessionId, workspaceId?, pgid?/pid?/port? }
//   main → child: { type: 'process-op:result', requestId, ok, payload? | error }
//
// 错误路径铁律（照抄 net-trust-bridge）：
//   - 超时 reject 中文文案并清 pending（防泄漏 + 迟到结果安全 no-op）
//   - process.send 不可用（非 fork 环境，如直跑单测）立即 reject，绝不挂等
//   - process.send 必须以方法调用形式发送（真实 Node 读 this.connected——
//     2.0.0 主机验收 P0-1 教训：解构裸调用在严格模式下直接抛错）
import { randomUUID } from 'node:crypto';

/** 超时中文文案（同时覆盖「主进程未接线」情形） */
const TIMEOUT_MESSAGE = '进程管理 IPC 无响应（主进程未接线或超时）';

/** process.send 缺失文案（非 fork 环境直跑工具单测的场景） */
const NO_SEND_MESSAGE = '进程管理 IPC 不可用（process.send 缺失：非 fork 子进程环境）';

/** op 超时档（主进程 lsof/ps 秒级；防主进程卡死） */
const BRIDGE_TIMEOUT_MS = 15_000;

/** list op 应答形状（与 RoundProcessInfo 对齐，桥层只做透传） */
export interface ProcessListPayload {
  groups: Array<{
    pgid: number;
    members: Array<{ pid: number; command: string }>;
    kept?: boolean;
    port?: number;
  }>;
}

/** kill op 应答形状 */
export interface ProcessKillPayload {
  killedGroups: number;
  refused: string[];
}

interface PendingEntry {
  readonly resolve: (payload: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** requestId → 在途请求（进程级单例） */
const pending = new Map<string, PendingEntry>();

/**
 * 发送一次 process-op 并等待应答。requestId 单点生成（randomUUID）沿线透传。
 */
function sendProcessOp(
  op: 'list' | 'kill' | 'keep',
  payload: { streamSessionId: string; workspaceId?: string; pgid?: number; pid?: number; port?: number },
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(new Error(NO_SEND_MESSAGE));
      return;
    }
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(TIMEOUT_MESSAGE));
    }, BRIDGE_TIMEOUT_MS);
    timer.unref?.();
    pending.set(requestId, { resolve, reject, timer });
    try {
      process.send({ type: 'process-op', requestId, op, ...payload });
    } catch (err) {
      const entry = pending.get(requestId);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(requestId);
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** process_list：本回合登记的进程组及存活成员（含同 workspace 保留组） */
export function requestProcessList(
  streamSessionId: string,
  workspaceId?: string,
): Promise<ProcessListPayload> {
  return sendProcessOp('list', { streamSessionId, workspaceId }) as Promise<ProcessListPayload>;
}

/** process_kill：按 pgid / pid / port（三选一）授权击杀（本回合组 + 同 workspace 保留组） */
export function requestProcessKill(
  streamSessionId: string,
  target: { pgid?: number; pid?: number; port?: number },
  workspaceId?: string,
): Promise<ProcessKillPayload> {
  return sendProcessOp('kill', { streamSessionId, workspaceId, ...target }) as Promise<ProcessKillPayload>;
}

/** process_keep 应答形状 */
export interface ProcessKeepPayload {
  pgid: number;
  port?: number;
}

/** process_keep：把本回合启动的服务标记为用户保留（跨回合存活） */
export function requestProcessKeep(
  streamSessionId: string,
  workspaceId: string,
  target: { pgid?: number; pid?: number; port?: number },
): Promise<ProcessKeepPayload> {
  return sendProcessOp('keep', { streamSessionId, workspaceId, ...target }) as Promise<ProcessKeepPayload>;
}

/**
 * 消费主进程应答（runtime-entry 的 taskMessageListener 分发到此）。按 requestId
 * 派发；未知 requestId（迟到 / 重复）静默忽略——不崩不误伤在途请求。
 */
export function handleProcessOpResult(msg: unknown): void {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as { type?: string; requestId?: unknown; ok?: boolean; payload?: unknown; error?: string };
  if (m.type !== 'process-op:result' || typeof m.requestId !== 'string') return;
  const entry = pending.get(m.requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(m.requestId);
  if (m.ok) {
    entry.resolve(m.payload);
  } else {
    entry.reject(new Error(typeof m.error === 'string' ? m.error : TIMEOUT_MESSAGE));
  }
}
