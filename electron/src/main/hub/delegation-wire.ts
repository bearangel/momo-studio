// 委派私有 wire 常量与载荷（M2e T10/T11）——studio 侧本地镜像。
// 单源指针：momo-hub src/delegation.ts 的 TASK_WIRE / TaskReportPayload @
// v0.1.4（tag）——值逐字一致，hub 侧有测试锁。
// pin v0.1.4 dist 已含上述导出；本模块保留镜像（M2f T17 裁定，同 mirror-wire.ts
// 先例：切换 import 影响多文件收益低）。
// wire 语义（task-9-report）：method='task.report'，id=taskId（对账键），ok=true，
// 载荷 {status:'running'|'done'|'failed', sessionId?, reason?, progress?{lastSeq, excerpt, kind?}}；
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
 *  ✅ hub 侧透传已落地（momo-hub v0.1.4，2026-10-26——T11b）：parseReportPayload
 *  白名单收 progress.kind + 单值枚举校验（非法剥除不抛，先例 permissionTier），
 *  task.progress 转发形状 TaskProgressEvent 同步扩展 kind?。本端上行经
 *  delegation-runner.test.ts「kind 全链」用例与 hub delegations.test.ts
 *  「task.report kind 透传（T11b）」两用例跨仓对齐锁定。 */
export interface TaskReportProgress {
  lastSeq: number;
  excerpt: string;
  kind?: 'waiting-input';
}
