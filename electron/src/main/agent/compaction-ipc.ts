// electron/src/main/agent/compaction-ipc.ts
//
// 压缩 IPC 桥子进程侧（spec §4.4，沿 task-reply pending 模式）。
// 自 runtime-entry.ts 迁出（压缩改造 Task 5）：requestCompaction 是 compact
// 工具/auto 阈值共用的 IPC 副作用边界——独立成模块后测试可经 vi.mock 在
// 该边界注入（momo-test-rules 铁律 5：只 mock 进程边界，业务逻辑走真实实现）。
//
// requestCompaction：把头部序列化对话发给主进程 CompactionService，等待按
// streamSessionId 配对的 compaction:result（10s 超时）。配对键在请求侧单点
// 生成（randomUUID）并由主进程原样回传——禁止任一跳回收再生成。

import { randomUUID } from 'node:crypto';

/** 单次压缩请求的等待超时（spec §9：IPC 超时 10s 视为失败） */
export const COMPACTION_REQUEST_TIMEOUT_MS = 10_000;

interface PendingCompaction {
  resolve: (summary: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** 等待中的压缩请求：streamSessionId → pending promise（compact 工具/auto 阈值消费） */
const pendingCompactions = new Map<string, PendingCompaction>();

/**
 * 请求主进程执行上下文压缩（消费方：compact 工具触发器与 auto 阈值路径）。
 * 防竞态：先注册 pending 再发送（dispatch-wait 同款——极快回执不得先于注册到达）。
 */
export function requestCompaction(
  sessionId: string,
  conversation: string,
  coveredUntil: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!process.send) {
      reject(new Error('压缩请求不可用：子进程未建立 IPC 通道'));
      return;
    }
    const streamSessionId = randomUUID();
    const timer = setTimeout(() => {
      pendingCompactions.delete(streamSessionId);
      reject(new Error(`压缩请求超时（${COMPACTION_REQUEST_TIMEOUT_MS / 1000}s），请重试`));
    }, COMPACTION_REQUEST_TIMEOUT_MS);
    pendingCompactions.set(streamSessionId, { resolve, reject, timer });
    process.send({ type: 'compaction:request', streamSessionId, sessionId, conversation, coveredUntil });
  });
}

/**
 * 消费主进程下发的 compaction:result（runtime-spawner.handleCompactionRequestMsg
 * 回写）：按 streamSessionId 配对 resolve/reject 对应 pending。迟到/未知 id 静默
 * 忽略（超时已 reject 过或并非本进程请求）。
 */
export function handleCompactionResultIpc(msg: unknown): void {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as { type?: string; streamSessionId?: unknown; ok?: unknown; summary?: unknown; error?: unknown };
  if (m.type !== 'compaction:result' || typeof m.streamSessionId !== 'string') return;
  const pending = pendingCompactions.get(m.streamSessionId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingCompactions.delete(m.streamSessionId);
  if (m.ok === true && typeof m.summary === 'string') {
    pending.resolve(m.summary);
  } else {
    // ok:false 或 ok:true 却缺 summary（线协议破坏）——统一显式报错，绝不静默成功
    pending.reject(new Error(
      typeof m.error === 'string' && m.error ? m.error : '压缩失败（主进程未返回错误信息）',
    ));
  }
}
