// renderer/src/lib/rpc-error.ts
//
// M4.1 错误契约统一：主进程 hub 通道（ipc.handlers.ts coded）把 RpcRemoteError
// 的协议错误码编入 rejection message 前缀 `[code] 原文`（Electron IPC rejection
// 只保 message，Electron #24427）。本模块是该前缀的 renderer 侧单源解析——
// 消费方不得各自持有 regex（原 DelegatedTaskCard 内联正则已上提至此）。
// 前置约定：ipc client 代理层（lib/ipc-error.ts normalizeIpcError）已剥
// Electron 包装前缀，此处拿到的 message 以 `[code]` 开头即契约命中。
//
// 与 electron 侧的等值关系由双侧契约测试锁定（error-prefix 双侧模式，
// hub-capability-contract.test.ts 同款）：electron/tests/hub/ipc.test.ts 用
// 下方 fixture 断言 coded 产出 → parseRpcErrorCode 还原逐字段等值。

/** 前缀解析产物：code = hub 协议错误码（RpcErrorCode，如 node_offline） */
export interface RpcErrorCodeParts {
  code: string;
  message: string;
}

/** `[code] message` 前缀（与 electron 侧 coded 逐字对齐；code 仅小写字母与下划线） */
const RPC_ERROR_PREFIX_RE = /^\[([a-z_]+)\] ([\s\S]*)$/;

/**
 * 双侧契约 fixture（M4.1）：renderer 测试与 electron 契约测试
 * （tests/hub/ipc.test.ts）共用——coded 编码 → parseRpcErrorCode 解码必须
 * 逐字段往返等值，改动须两侧同 commit。
 */
export const RPC_ERROR_ROUNDTRIP_FIXTURES: ReadonlyArray<{ code: string; message: string }> = [
  { code: 'node_offline', message: '目标节点不在线' },
  { code: 'forbidden', message: '目标节点已关闭本组查看' },
  { code: 'not_waiting', message: '任务当前状态为 running，非等待态不可代答' },
];

/**
 * 解析 IPC rejection 的 `[code] message` 前缀。命中返回 {code, message}（message
 * 为剥前缀后的 hub 人话原文）；非该契约形态（本地错误 / 旧 hub 无前缀）返回 null。
 */
export function parseRpcErrorCode(err: unknown): RpcErrorCodeParts | null {
  const raw = err instanceof Error ? err.message : String(err);
  const coded = RPC_ERROR_PREFIX_RE.exec(raw);
  return coded === null ? null : { code: coded[1]!, message: coded[2]! };
}

/**
 * hub 通道错误的展示文案：有 `[code]` 前缀则剥前缀回原文（前缀是传输编码，
 * 非用户可读信息），否则原样。供各消费面（toast / 表单错误 / store error）
 * 统一替换 `err.message` 直出。
 */
export function rpcErrorMessage(err: unknown): string {
  const coded = parseRpcErrorCode(err);
  if (coded !== null) return coded.message;
  return err instanceof Error ? err.message : String(err);
}
