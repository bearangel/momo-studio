// electron/src/main/sandbox/network-trust.ts
//
// 沙箱网络出站策略——子进程 IPC 查询的主进程对端（2026-09-13 修订 B）。
// 三态时代的 ask 信任门机制（sessionGrants / 阻塞等待表 / 三值应答 / 超时
// 收敛 / 信任卡推送）已全链下线：真机体验存在结构性天花板——事后文本鉴定
// 永远漏检（用户 echo 的任意格式不可枚举），阻塞等待卡在无人值守场景必然
// 超时按拒绝收敛，等效于变相 deny。现行有效网络态 = settings kv 双态策略
// 单点判定：netOn = (networkPolicy === 'allow')。
//
// 本模块保留 effective 单 op 的子进程桥对端（线协议名与 op 名不变，payload
// 仅 netOn 字段——向后兼容旧消费者）：ShellTools 在 runtime 子进程执行，策略
// 读取必须代理回主进程（子进程不可见 DB 单例）。
import { getSandboxSettings } from './settings';

export type { NetworkPolicy } from './settings';

interface NetTrustOpMsg {
  type: 'net-trust-op';
  requestId: string;
  op: 'effective';
  streamSessionId: string;
}

export type NetTrustOpResult =
  | { ok: true; payload: { netOn: boolean } }
  | { ok: false; error: string };

function parseNetTrustOpMsg(msg: unknown): NetTrustOpMsg | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Partial<NetTrustOpMsg>;
  if (m.type !== 'net-trust-op') return null;
  if (typeof m.requestId !== 'string' || m.requestId === '') return null;
  if (m.op !== 'effective') return null;
  if (typeof m.streamSessionId !== 'string' || m.streamSessionId === '') return null;
  return m as NetTrustOpMsg;
}

/**
 * 子进程 op 统一路由（永不抛异常——失败统一 { ok:false, error } 序列化回子进程）。
 * effective：spawn 前有效网络态查询，双态策略单点判定（allow → net-on）。
 * 设置读取失败（DB 异常等）降级 ok:false——子进程 shell-tools 自有回退路径，
 * 绝不因策略查询挂死 bash 主路径。
 */
export async function handleNetTrustOp(msg: unknown): Promise<NetTrustOpResult> {
  const parsed = parseNetTrustOpMsg(msg);
  if (parsed === null) {
    return { ok: false, error: 'net-trust-op 载荷形状非法（需 type/requestId/op=effective/streamSessionId）' };
  }
  try {
    const netOn = getSandboxSettings().networkPolicy === 'allow';
    return { ok: true, payload: { netOn } };
  } catch (err) {
    return { ok: false, error: `网络策略读取失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}
