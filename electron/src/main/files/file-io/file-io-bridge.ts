// electron/src/main/files/file-io/file-io-bridge.ts
//
// 子进程侧文件 IO 桥（spec §5.4）——镜像 process-bridge.ts 结构。
// 线协议（两端同 commit 修改，momo-boundary-rules）：
//   child → main: { type: 'file-io:req', requestId, op: 'read'|'readMany'|'write',
//                   path?, paths?, dataBase64? }
//   main → child: { type: 'file-io:resp', requestId, ok,
//                   dataBase64? | items? | error?: { code, message } }
// 铁律：process.send 方法调用形式（2.0.0 P0-1 this 绑定教训）；非 fork 环境
// 立即 reject；超时清 pending 防泄漏。本模块禁止 import 'electron'。
import { randomUUID } from 'node:crypto';
import { FileIoError, type ContentIo, type FileIoErrorCode } from './types';

const BRIDGE_TIMEOUT_MS = 30_000;
const TIMEOUT_MESSAGE = '文件读写 IPC 无响应（主进程未接线或超时）';
const NO_SEND_MESSAGE = '文件读写 IPC 不可用（process.send 缺失：非 fork 子进程环境）';

interface FileIoRespPayload {
  ok: boolean;
  dataBase64?: string;
  items?: Array<{ ok: boolean; dataBase64?: string; error?: { code: string; message: string } }>;
  error?: { code: string; message: string };
}

interface PendingEntry {
  resolve: (r: FileIoRespPayload) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingEntry>();

function toFileIoError(err: { code?: string; message?: string } | undefined): FileIoError {
  const code = (err?.code ?? 'EREAD') as FileIoErrorCode;
  return new FileIoError(code, err?.message ?? '文件读写失败');
}

function sendFileIoOp(payload: Record<string, unknown>): Promise<FileIoRespPayload> {
  return new Promise<FileIoRespPayload>((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(new FileIoError('ECHILD', NO_SEND_MESSAGE));
      return;
    }
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new FileIoError('ETIMEOUT', TIMEOUT_MESSAGE));
    }, BRIDGE_TIMEOUT_MS);
    timer.unref?.();
    pending.set(requestId, { resolve, reject, timer });
    try {
      // 方法调用形式（不可解构）——真实 Node 读 this.connected
      process.send({ type: 'file-io:req', requestId, ...payload });
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

/** 主进程应答分发（runtime-entry 的 taskMessageListener 调，未知消息 no-op） */
export function handleFileIoResp(msg: unknown): void {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as { type?: string; requestId?: unknown } & FileIoRespPayload;
  if (m.type !== 'file-io:resp' || typeof m.requestId !== 'string') return;
  const entry = pending.get(m.requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(m.requestId);
  if (m.ok) entry.resolve(m);
  else entry.reject(toFileIoError(m.error));
}

export async function requestFileIoRead(p: string): Promise<Buffer> {
  const r = await sendFileIoOp({ op: 'read', path: p });
  if (r.dataBase64 === undefined) throw toFileIoError(r.error);
  return Buffer.from(r.dataBase64, 'base64');
}

export async function requestFileIoReadMany(paths: string[]): Promise<Buffer[]> {
  const r = await sendFileIoOp({ op: 'readMany', paths });
  if (!r.ok || !Array.isArray(r.items) || r.items.length !== paths.length) {
    throw toFileIoError(r.error);
  }
  return r.items.map((item) => {
    if (!item.ok || item.dataBase64 === undefined) throw toFileIoError(item.error);
    return Buffer.from(item.dataBase64, 'base64');
  });
}

export async function requestFileIoWrite(p: string, data: Buffer): Promise<void> {
  const r = await sendFileIoOp({ op: 'write', path: p, dataBase64: data.toString('base64') });
  if (!r.ok) throw toFileIoError(r.error);
}

/** 子进程侧 proxy 内容通道（runtime-entry 按 AGENT_CONFIG.fileIoMode 装配） */
export class BridgeContentIo implements ContentIo {
  readFile(p: string): Promise<Buffer> {
    return requestFileIoRead(p);
  }
  readFiles(p: string[]): Promise<Buffer[]> {
    return requestFileIoReadMany(p);
  }
  writeFile(p: string, data: Buffer): Promise<void> {
    return requestFileIoWrite(p, data);
  }
}
