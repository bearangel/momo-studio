// renderer/src/lib/ipc-error.ts
//
// IPC rejection 文案归一：Electron 会把 ipcMain.handle 的 throw 包成
// `Error invoking remote method '<channel>': Error: <原始消息>` 再 reject 到
// renderer——直接拼进 alert 会形成多层前缀（真机 D1）。
// 2026-10-12 D11：归一收敛到 ipc client 代理层（调用方拿到的 rejection 已剥
// 前缀）；ipcErrorMessage 保留给存量消费点与显式取文案场景，二者共用同一条
// 正则（单一真相源）。
/** 通道名允许字母数字与 : - _ .（惰性匹配，不吞正文） */
const IPC_WRAPPER_RE = /^Error invoking remote method '[\w:.-]+': (?:Error: )?/;

/** unknown rejection → 干净 message：剥 Electron IPC 包装，非 Error 走 String() */
export function ipcErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(IPC_WRAPPER_RE, '');
}

/**
 * 归一 Error（D11）：ipc client 代理层在每个方法 rejection / 同步 throw 上调用。
 * 命中 IPC 包装前缀时原地改写 message（保留原始 Error 身份与调用栈）后原样
 * 返回；非 Error 的 rejection 值原样返回（不吞不包——消费方语义不变）。
 */
export function normalizeIpcError(e: unknown): unknown {
  if (e instanceof Error) {
    const cleaned = e.message.replace(IPC_WRAPPER_RE, '');
    if (cleaned !== e.message) e.message = cleaned;
  }
  return e;
}
