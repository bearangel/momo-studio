// electron/src/main/hub/delegation-answer.ts
//
// M3.1 HITL L2 远程代答 worker 侧处理器（spec 2026-10-28 §3.3）：hub 转发的
// task.answer req → 复用本机代答原语（sandbox:grantWrite / sandbox:denyWrite 同一
// API 面，零新机制）解除写授权等待 → res {ok, disposition, sessionId}。
//
//   - approve：聚合该会话全部未决条目的 dirs（去重）→ grantWriteDirs('session')
//     一次 + 逐条 clearPendingOnGrant——子进程经 covered 轮询（≤2s）原地重执行。
//   - deny：broadcastWriteGrantDenied（聚合 dirs——子进程侧按目录相交匹配等待
//     登记）+ clearPendingOnDeny(sessionId, [])（空 dirs=整会话拒绝）。
//   - stale（幂等口径）：本地无此委派 / 无 sessionId / 未决登记为空（已处置或
//     TTL 清扫）——不报错，hub 侧决策列仍记最新。
//   - message 仅留痕（审计日志），不上报子进程——approve 走 covered 轮询原地
//     重执行、deny 走标准拒绝文本，两条既有路径均无注入点（一义一名不扩义）。
//
// 纯端口注入（momo-test-rules #5）：DB / 登记面 / 广播 / 日志全经 ports，
// 生产接线在 hub/index.ts（taskAnswerPorts），tests/hub 注入 fake。
import type { RpcErrorPayload } from './protocol';
import type { TaskAnswerForward } from './delegation-wire';

/** 代答备注上限（与 hub v0.1.7 TaskAnswerReq.message 同界） */
const ANSWER_MESSAGE_MAX = 512;

/** 未决写授权登记的最小消费面（write-blocked-emit WriteBlockedSignal 的 dirs 投影） */
export interface TaskAnswerPendingSignal {
  dirs: string[];
}

/** 进程/DB 边界端口（唯一 mock 面；生产接线 hub/index.ts） */
export interface TaskAnswerPorts {
  /** taskId → 委派会话 id（delegationStore.get(taskId)?.sessionId ?? null） */
  findDelegationSession(taskId: string): string | null;
  /** 会话未决写授权登记（write-blocked-emit listPendingWriteBlocked） */
  listPending(sessionId: string): TaskAnswerPendingSignal[];
  /** 会话级写授权授予（write-grant grantWriteDirs——与 sandbox:grantWrite 同一原语） */
  grantDirs(sessionId: string, dirs: string[]): void;
  /** grant 处置清除登记（clearPendingOnGrant——dirs 相交匹配） */
  clearGranted(sessionId: string, dirs: string[]): void;
  /** deny 处置清除登记（clearPendingOnDeny——整会话） */
  clearDenied(sessionId: string): void;
  /** deny 广播解除子进程等待（broadcastWriteGrantDenied——与 sandbox:denyWrite 同一原语） */
  broadcastDenied(dirs: string[]): void;
  /** 审计留痕（hub 侧决策列之外的本机视角；message 仅在此留痕） */
  logAnswered(info: {
    taskId: string;
    decision: 'approve' | 'deny';
    disposition: 'granted' | 'denied' | 'stale';
    sessionId: string | null;
    message?: string;
  }): void;
}

/** 应答结果（client HubResponderResult 的 ok 分支载荷特化——payload 直接作 res 信封载荷） */
export type TaskAnswerResult =
  | { ok: true; payload: { disposition: 'granted' | 'denied' | 'stale'; sessionId?: string } }
  | { ok: false; payload: RpcErrorPayload };

function badRequest(message: string): { ok: false; payload: RpcErrorPayload } {
  return { ok: false, payload: { code: 'bad_request', message } };
}

/**
 * task.answer 转发处理（同步——全部原语为进程内同步调用）。
 * 载荷校验不过 → bad_request（hub 侧已校验，此处防御转发链异形——双校验先例
 * remote-view）；委派/等待缺失 → stale 不报错（幂等）。
 */
export function handleTaskAnswerRequest(payload: unknown, ports: TaskAnswerPorts): TaskAnswerResult {
  if (typeof payload !== 'object' || payload === null) return badRequest('载荷非对象');
  const p = payload as { taskId?: unknown; decision?: unknown; message?: unknown };
  if (typeof p.taskId !== 'string' || p.taskId === '') return badRequest('taskId 缺失');
  if (p.decision !== 'approve' && p.decision !== 'deny') return badRequest('decision 非法（approve|deny）');
  let message: string | undefined;
  if (p.message !== undefined) {
    if (typeof p.message !== 'string' || p.message.length === 0 || p.message.length > ANSWER_MESSAGE_MAX) {
      return badRequest(`message 非法（1-${ANSWER_MESSAGE_MAX} 字符）`);
    }
    message = p.message;
  }
  const forward = p as TaskAnswerForward;

  const sessionId = ports.findDelegationSession(forward.taskId);
  const audit = (disposition: 'granted' | 'denied' | 'stale'): void => {
    ports.logAnswered({ taskId: forward.taskId, decision: forward.decision, disposition, sessionId, ...(message !== undefined ? { message } : {}) });
  };
  if (sessionId === null) {
    audit('stale');
    return { ok: true, payload: { disposition: 'stale' } };
  }
  const pending = ports.listPending(sessionId);
  if (pending.length === 0) {
    audit('stale');
    return { ok: true, payload: { disposition: 'stale', sessionId } };
  }
  // 聚合全部未决条目 dirs（去重）：approve 一次授予全部；deny 广播同集（子进程
  // 等待登记按目录相交匹配——广播全集必命中各条等待）
  const allDirs = [...new Set(pending.flatMap((s) => s.dirs))];
  if (forward.decision === 'approve') {
    ports.grantDirs(sessionId, allDirs);
    for (const entry of pending) ports.clearGranted(sessionId, entry.dirs);
    audit('granted');
    return { ok: true, payload: { disposition: 'granted', sessionId } };
  }
  ports.broadcastDenied(allDirs);
  ports.clearDenied(sessionId);
  audit('denied');
  return { ok: true, payload: { disposition: 'denied', sessionId } };
}
