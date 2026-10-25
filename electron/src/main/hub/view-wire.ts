// 查看私有 wire 契约（M2e T13/T14）——studio 侧本地镜像。
//
// Pin 缺口说明：hub 仓 src/remote-view.ts 自 e237d0f 起导出 VIEW_WIRE /
// ViewConsentPayload / ViewTailPayload，但 studio 的 protocol pin
// （github:bearangel/momo-hub#35035ce）早于该批——私有 wire 段尚未随 tag 发布
// （M2f 定版 v0.1.2 pin 升级时收敛）。在此之前按 MIRROR_WIRE / TASK_WIRE 同款
// 纪律本地镜像：值与 hub src/remote-view.ts 的 VIEW_WIRE 逐字对齐
// （两仓同步义务：hub 侧改值必须同步此处，hub 侧有测试锁）。
import type { ViewMessage } from './protocol';

/** 查看链路私有方法名（信封 method 字段值）——与 hub VIEW_WIRE 对齐。 */
export const VIEW_WIRE = {
  /**
   * 节点 → hub：查看同意开关上报（req 信封，hub 直接 res {ok:true} 确认）。
   * 节点 hello 后与开关变更时上行；hub 存内存态 per-nodeId，默认 true（§5.5）；
   * 断线清除回默认（RM2-9），重连由节点重报覆盖。
   */
  consent: 'view.consent',
  /**
   * 目标节点 → hub：已订阅会话的尾部增量（req 信封，hub 组装 view.appended
   * evt 定向推订阅端 leader，并 res {ok:true} 确认）。批 ≤200 条 / 500ms 合并。
   */
  tail: 'view.tail',
} as const;

/** view.consent 载荷：allowed=false 时 hub 对该节点的 view.* 请求一律 forbidden。 */
export interface ViewConsentPayload {
  allowed: boolean;
}

/** view.tail 载荷：该会话新 message_events 批（hub 原样组装进 view.appended）。 */
export interface ViewTailPayload {
  sessionId: string;
  events: ViewMessage[];
}
