// electron/src/main/sandbox/network-trust.ts
//
// 沙箱网络出站策略——子进程 IPC 查询的主进程对端（2026-09-13 修订 B + 2026-10-01 v2.5）。
// 三态时代的 ask 信任门机制（sessionGrants / 阻塞等待表 / 三值应答 / 超时
// 收敛 / 信任卡推送）已全链下线：真机体验存在结构性天花板——事后文本鉴定
// 永远漏检（用户 echo 的任意格式不可枚举），阻塞等待卡在无人值守场景必然
// 超时按拒绝收敛，等效于变相 deny。现行有效网络态 = settings kv 双态策略
// 单点判定：netOn = (networkPolicy === 'allow')。
//
// v2.5 工具链授权已移除（2026-10-04，机制随硬门控授权卡下线）；2026-10-03
// 通用写授权（spec §6.1）：effective payload 为 { netOn, extraDirs } 两字段。
// extraDirs = 会话 ∪ 工作空间 两层授权目录（write-grant KV），sessionId
// 由主进程从请求载荷 streamSessionId 经 messages 表映射（子进程请求零改动）；
// 旧子进程不传 workspaceId 时 extraDirs 恒空数组（向后兼容）。
//
// 本模块保留 effective 单 op 的子进程桥对端（线协议名与 op 名不变——线协议
// 铁律：只删字段需两端同 commit，本仓库单仓双端同发）：ShellTools 在 runtime
// 子进程执行，策略读取必须代理回主进程（子进程不可见 DB 单例）。
import { getSandboxSettings } from './settings';
import { getGrantedDirs } from './write-grant';
import { getLatestMessageByStreamSessionId } from '../storage/messages/repo';

export type { NetworkPolicy } from './settings';

interface NetTrustOpMsg {
  type: 'net-trust-op';
  requestId: string;
  op: 'effective';
  streamSessionId: string;
  /** v2.5：可选 workspaceId——动态授权按该键查表；缺省按空（向后兼容旧子进程） */
  workspaceId?: string;
}

export type NetTrustOpResult =
  | { ok: true; payload: { netOn: boolean; extraDirs: string[] } }
  | { ok: false; error: string };

function parseNetTrustOpMsg(msg: unknown): NetTrustOpMsg | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Partial<NetTrustOpMsg>;
  if (m.type !== 'net-trust-op') return null;
  if (typeof m.requestId !== 'string' || m.requestId === '') return null;
  if (m.op !== 'effective') return null;
  if (typeof m.streamSessionId !== 'string' || m.streamSessionId === '') return null;
  // workspaceId 可选——缺省/非字符串一律视为未传（向后兼容旧子进程载荷）
  if (m.workspaceId !== undefined && typeof m.workspaceId !== 'string') return null;
  return m as NetTrustOpMsg;
}

/**
 * 子进程 op 统一路由（永不抛异常——失败统一 { ok:false, error } 序列化回子进程）。
 * effective：spawn 前有效态查询，单点判定 netOn = (networkPolicy === 'allow')，
 * extraDirs = 会话 ∪ 工作空间 两层授权目录合成。
 * 设置读取失败（DB 异常等）降级 ok:false——子进程 shell-tools 自有回退路径，
 * 绝不因策略查询挂死 bash 主路径。
 */
export async function handleNetTrustOp(msg: unknown): Promise<NetTrustOpResult> {
  const parsed = parseNetTrustOpMsg(msg);
  if (parsed === null) {
    return { ok: false, error: 'net-trust-op 载荷形状非法（需 type/requestId/op=effective/streamSessionId）' };
  }
  try {
    const settings = getSandboxSettings();
    const netOn = settings.networkPolicy === 'allow';
    // extraDirs（spec §6.1）：streamSessionId → 聊天会话映射在主进程单点解析
    //（子进程请求载荷零改动）。roll 语义（终审 I1）：流轮转时消息行的
    // stream_session_id 被改写为 #roll{n} 后缀——用「流族 = base + #roll 取
    // 最新行」（getLatestMessageByStreamSessionId），否则 rename 后授权失效。
    let sessionId: string | null = null;
    try {
      sessionId = getLatestMessageByStreamSessionId(parsed.streamSessionId)?.sessionId ?? null;
    } catch {
      sessionId = null;
    }
    // extraDirs 两层合成（2026-10-04 修订：v2.5 预置层随工具链机制移除，自
    // hard-gate §4.1 的三层合成回退两层——会话 ∪ 工作空间。授权卡按实际
    // 被拦目录授权，预置机制无存在必要）。字段形状不变。
    const extraDirs = getGrantedDirs(sessionId, parsed.workspaceId ?? null);
    return { ok: true, payload: { netOn, extraDirs } };
  } catch (err) {
    return { ok: false, error: `网络策略读取失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}
