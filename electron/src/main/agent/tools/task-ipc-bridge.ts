// electron/src/main/agent/tools/task-ipc-bridge.ts
//
// 任务工具 hub 侧操作子进程 IPC 桥（2026-11-09——agent 工作组路由面补丁）。
// 背景：create_task 的 routing 分支与 list_workgroups 需要触达 hub 连接
// （listGroups/delegate——HubClient 只活在主进程），而 agent 工具在 runtime
// 子进程执行——子进程侧直调必得「hub 未连接」（实测会话 08:31 两次同错）。
// 本桥把两操作代理为主进程侧执行（镜像 process-bridge.ts 结构）。
//
// 线协议（两端同 commit 修改——momo-boundary-rules 生产者消费者成对）：
//   child → main: { type: 'task-op', requestId, op: 'list_workgroups' | 'create_routed',
//                   input? }
//   main → child: { type: 'task-op:result', requestId, ok, payload? | error }
//
// 错误路径铁律（照抄 process-bridge）：
//   - 超时 reject 中文文案并清 pending（防泄漏 + 迟到结果安全 no-op）
//   - process.send 不可用（非 fork 环境）立即 reject，绝不挂等超时
//   - process.send 必须以方法调用形式发送（真实 Node 读 this.connected）
import { randomUUID } from 'node:crypto';
import type { TaskRow } from '../../storage/tasks/repo';
import type { CreateTaskInput } from './task-tools';

/** 超时中文文案（同时覆盖「主进程未接线」情形——含 hub RPC 慢的场景） */
const TIMEOUT_MESSAGE = '任务 IPC 无响应（主进程未接线或超时）';

/** process.send 缺失文案（非 fork 环境直跑工具单测的场景） */
const NO_SEND_MESSAGE = '任务 IPC 不可用（process.send 缺失：非 fork 子进程环境）';

/** op 超时档（hub RPC 往返 + 主进程落库；慢网络裕量） */
export const TASK_OP_BRIDGE_TIMEOUT_MS = 30_000;

/** list_workgroups 应答载荷（与 task-tools.listWorkgroups 返回同形） */
export type TaskWorkgroupsPayload = Array<{
  groupId: string;
  groupName: string;
  mode: 'leader-follower' | 'peer';
  modeLabel: string;
  isLeader: boolean;
  members: Array<{
    nodeId: string;
    name: string;
    online: boolean;
    bound: boolean;
    boundWorkspaceName?: string;
  }>;
}>;

/** create_routed 应答载荷（TaskRow + 派发去向） */
export type TaskCreateRoutedPayload = TaskRow & { dispatched?: boolean; nodeId?: string | null };

/** create_routed 请求载荷（CreateTaskInput 全量透传——含工具上下文注入的
 *  workspaceId/creatorUserId，主进程侧落库需要；互斥键校验在主进程侧同源执行） */
export type TaskCreateRoutedInput = CreateTaskInput;

interface PendingEntry {
  readonly resolve: (payload: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** requestId → 在途请求（进程级单例） */
const pending = new Map<string, PendingEntry>();

function sendTaskOp(op: 'list_workgroups' | 'create_routed', input?: TaskCreateRoutedInput): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(new Error(NO_SEND_MESSAGE));
      return;
    }
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(TIMEOUT_MESSAGE));
    }, TASK_OP_BRIDGE_TIMEOUT_MS);
    timer.unref?.();
    pending.set(requestId, { resolve, reject, timer });
    try {
      process.send({ type: 'task-op', requestId, op, ...(input !== undefined ? { input } : {}) });
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

/** list_workgroups：主进程侧查组（hub 连接 + 身份判定都在主进程） */
export function requestListWorkgroups(): Promise<TaskWorkgroupsPayload> {
  return sendTaskOp('list_workgroups') as Promise<TaskWorkgroupsPayload>;
}

/** create_routed：主进程侧走 submitRoutedTask 全链 */
export function requestCreateRouted(input: TaskCreateRoutedInput): Promise<TaskCreateRoutedPayload> {
  return sendTaskOp('create_routed', input) as Promise<TaskCreateRoutedPayload>;
}

/**
 * 消费主进程应答（runtime-entry 的消息分发到此）。按 requestId 派发；
 * 未知 requestId（迟到 / 重复）静默忽略——不崩不误伤在途请求。
 */
export function handleTaskOpResult(msg: unknown): void {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as { type?: string; requestId?: unknown; ok?: boolean; payload?: unknown; error?: string };
  if (m.type !== 'task-op:result' || typeof m.requestId !== 'string') return;
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
