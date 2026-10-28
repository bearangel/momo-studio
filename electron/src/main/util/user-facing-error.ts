// electron/src/main/util/user-facing-error.ts
//
// IPC 出口文案归一（M2.4 D1）：主进程 handler 抛出的错误到达 renderer 时，
// Electron 会序列化成 `Error invoking remote method '<channel>': <err.name>: <message>`。
// 其中 `<err.name>: ` 段由主进程侧的 name 决定——自定义错误类（如
// HubCatalogStaleError）直接把类名印进用户可见通知（真机验收：资源库「更新」
// 失败横幅出现 `HubCatalogStaleError: 无法确认…`），违反 spec §4.2「IPC 层转人话」。
//
// 分层职责：
//   - 主进程（本文件）：剥掉本地错误类名前缀 + 兜底剥 Electron 包装前缀，抛**普通
//     Error**（name='Error'）——Electron 序列化时不再生成 `<Name>: ` 段。
//   - renderer（`renderer/src/lib/ipc-error.ts` 的 normalizeIpcError）：负责剥
//     `Error invoking remote method '<channel>': (Error: )?` 包装——该前缀由
//     Electron 在 invoke 侧追加，主进程不可见、也不该猜。
// 两处正则各自只处理自身可见的形态；本文件对包装前缀的剥离是「已是字符串形态的
// 复用/测试注入」兜底，幂等（重复调用结果不变）。
//
// 纪律：不吞信息——原文（message）逐字保留；未知错误不改成「未知错误」。

/** 错误类名前缀：`HubCatalogStaleError: ` / `TypeError: ` / `CustomException: ` */
const ERROR_NAME_PREFIX_RE = /^[A-Za-z_$][\w$]*(?:Error|Exception):\s*/;

/** Electron invoke 包装前缀（主进程通常看不到；防御字符串化的复用场景） */
const IPC_WRAPPER_RE =
  /^Error invoking remote method '[\w:.-]+':\s*(?:[A-Za-z_$][\w$]*(?:Error|Exception):\s*)?/;

/**
 * 把任意抛出物归一为「可安全上行到 renderer 的普通 Error」：
 * 剥离 Electron 包装前缀与错误类名前缀，只保留人话 message；其余未知错误保留
 * 原 message（不吞成「未知错误」），非 Error 抛出物走 String()。
 */
export function toUserFacingError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const cleaned = message.replace(IPC_WRAPPER_RE, '').replace(ERROR_NAME_PREFIX_RE, '');
  // name 恒为 'Error'：Electron 序列化只对非 'Error' 的 name 追加 `${name}: `
  return new Error(cleaned);
}
