// 查看私有 wire 契约（M2e T13/T14）——studio 侧本地镜像。
//
// 单源指针：momo-hub src/remote-view.ts 的 VIEW_WIRE / ViewConsentPayload /
// ViewTailPayload @ v0.1.2（tag，commit 70ec124）——值逐字一致，hub 侧有测试锁。
// pin v0.1.2 dist 已含上述导出；本模块保留镜像（M2f T17 裁定，同 mirror-wire.ts
// 先例：切换 import 影响多文件收益低）。
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
