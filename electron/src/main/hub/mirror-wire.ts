// electron/src/main/hub/mirror-wire.ts
//
// 镜像私有 wire 契约（momo-hub M2 spec §3.1 两段式 + §5.2 目标端语义）——
// studio 侧单点定义。
//
// Pin 缺口说明：momo-hub 仓 src/groups.ts 自 142930a 起导出 MIRROR_WIRE /
// MirrorApplyPayload / MirrorReceiptOk / MirrorResultPayload，但 studio 的
// protocol pin（github:bearangel/momo-hub#35035ce）早于该批——私有 wire 段
// 尚未随 tag 发布（M2f 定版 v0.1.2 时 pin 升级收敛）。在此之前，本文件按
// 「协议引用经 hub/protocol 入口」的纪律补位：信封结构（RequestEnvelope /
// ResponseEnvelope / RpcErrorPayload）仍来自 protocol pin，仅方法名与载荷
// 类型在此镜像定义，值与 momo-hub src/groups.ts 的 MIRROR_WIRE 逐字对齐
// （两仓同步义务：hub 侧改值必须同步此处，hub 侧有测试锁）。
import type { MirrorStrategy, MirrorDiffSummary } from './protocol';

/** 镜像链路私有方法名（信封 method 字段值——与 momo-hub MIRROR_WIRE 对齐）。 */
export const MIRROR_WIRE = {
  /** hub → 目标节点：应用请求（req 信封，id=mirrorId——id 即对账键）。 */
  apply: 'mirror.apply',
  /** 目标节点 → hub：应用回执（res 信封，id=mirrorId；成功载荷 MirrorReceiptOk
   *  超集——含 unresolvedRefs 软失败清单，conflict 失败载荷 = RpcErrorPayload
   *  + diffSummary 超集）。 */
  receipt: 'mirror.receipt',
  /** hub → leader：两段式第二段结果（res 信封，id=mirrorId，定向投递）。 */
  result: 'mirror.result',
} as const;

/** mirror.apply 请求信封载荷（目标节点据此应用：快照经 HTTP 数据面取，配置整体替换）。 */
export interface MirrorApplyPayload {
  mirrorId: string;
  snapshotId: string;
  workspaceName: string;
  strategy: MirrorStrategy;
  /** 两段式确认（§5.2）：目标工作空间已存在且未 confirm → 回执 conflict + 差异摘要。 */
  confirm?: boolean;
}

/** mirror.receipt 成功回执载荷（目标节点已应用完毕）。
 *  unresolvedRefs：目标无法解析的引用（custom stdio MCP 名 / name≠slug 类）——
 *  不阻断镜像、软失败入清单（T7 硬交接语义），leader 结果面分列展示。 */
export interface MirrorReceiptOk {
  appliedResources: string[];
  unresolvedRefs?: string[];
}

/** 应用器产出（responder 据此组 mirror.receipt res 信封）。 */
export type MirrorApplyOutcome =
  | { ok: true; appliedResources: string[]; unresolvedRefs?: string[] }
  | {
      ok: false;
      code: 'conflict' | 'bad_request' | 'not_found' | 'internal';
      message: string;
      /** code=conflict 时必带：目标实况 vs 快照七子段计数。 */
      diffSummary?: MirrorDiffSummary;
    };
