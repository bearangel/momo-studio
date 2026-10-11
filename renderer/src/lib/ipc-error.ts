// renderer/src/lib/ipc-error.ts
//
// IPC rejection 文案归一：Electron 会把 ipcMain.handle 的 throw 包成
// `Error invoking remote method '<channel>': Error: <原始消息>` 再 reject 到
// renderer——直接拼进 alert 会形成多层前缀（真机 D1）。所有面向用户的
// IPC 错误提示统一经 ipcErrorMessage 取干净正文。
/** 通道名允许字母数字与 : - _ .（惰性匹配，不吞正文） */
const IPC_WRAPPER_RE = /^Error invoking remote method '[\w:.-]+': (?:Error: )?/;

/** unknown rejection → 干净 message：剥 Electron IPC 包装，非 Error 走 String() */
export function ipcErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(IPC_WRAPPER_RE, '');
}
