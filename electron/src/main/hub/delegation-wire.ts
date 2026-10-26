// 委派私有 wire 常量与载荷（M2e T10/T11）——studio 侧本地镜像。
// 单源指针：momo-hub src/delegation.ts 的 TASK_WIRE / TaskReportPayload @
// v0.1.2（tag，commit 70ec124）——值逐字一致，hub 侧有测试锁。
// pin v0.1.2 dist 已含上述导出；本模块保留镜像（M2f T17 裁定，同 mirror-wire.ts
// 先例：切换 import 影响多文件收益低）。
// wire 语义（task-9-report）：method='task.report'，id=taskId（对账键），ok=true，
// 载荷 {status:'running'|'done'|'failed', sessionId?, reason?, progress?{lastSeq, excerpt}}；
// reason 约定值 'declined'（目标拒派，§5.3）/ 'local_session_lost'（续传时会话丢失）。

/** 委派链路私有方法名（信封 method 字段值）——与 hub src/delegation.ts TASK_WIRE 对齐。 */
export const TASK_WIRE = {
  /**
   * 目标节点 → hub：状态上报（res 信封，id=taskId）。running 态重复上报 = 进度拍
   * （500ms 合并节流在本侧完成，hub 只做直转）。
   */
  report: 'task.report',
} as const;

/** task.report 载荷——值形状与 hub 协议包 TaskReportPayload 逐字对齐。 */
export interface TaskReportPayload {
  status: 'running' | 'done' | 'failed';
  /** 委派会话 id（MC1 独立委派会话——首次 running 上报建立，hub 回填账本 session_id）。 */
  sessionId?: string;
  /** failed 附因（约定值：'declined'=目标拒派；'local_session_lost'=续传时本地会话已丢失）。 */
  reason?: string;
  /** 进度段（running 上报可携带）：lastSeq 单调不丢（RF#5），excerpt 恒非空。 */
  progress?: TaskReportProgress;
}

/** 进度拍：委派会话 message_events 尾部摘要（excerpt 为截断文本）。
 *  kind 可选标注（M2.1 T11）：'waiting-input' = worker 侧 agent 正等待用户
 *  确认（写授权卡等）——leader 看板卡据此切「等待节点确认」态（T12 消费）。
 *
 *  ⚠️ hub 侧透传现状（2026-10-26 实测，momo-hub @ 0.1.3 pin）：hub
 *  packages/hub/src/delegations.ts parseReportPayload 白名单重建
 *  out.progress = { lastSeq, excerpt }——kind 字段被剥离（同 T10b
 *  permissionTier 先例），task.progress 转发形状 TaskProgressEvent 亦为扁平
 *  四字段。leader 侧要消费 kind 需 hub 升级（parse 白名单 + TaskProgressEvent
 *  扩展 + 协议 pin 提升），已报裁定勿自行跨仓；本端按契约先行，hub 升级后
 *  直接生效零改动（permissionTier 同款路径）。 */
export interface TaskReportProgress {
  lastSeq: number;
  excerpt: string;
  kind?: 'waiting-input';
}
