// 委派私有 wire 常量与载荷（M2e T10/T11）——studio 侧本地镜像。
// pin 缺口声明：studio protocol pin #35035ce 早于 hub ac381ce 的委派 wire 批
// （TASK_WIRE/TaskReportPayload 未随 tag 发布），故本地镜像定义、值与 hub
// src/delegation.ts 逐字对齐（MIRROR_WIRE 同款纪律，T8b 先例）；
// M2f 定版 v0.1.2 pin 升级时收敛回 protocol 入口。
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

/** 进度拍：委派会话 message_events 尾部摘要（excerpt 为截断文本）。 */
export interface TaskReportProgress {
  lastSeq: number;
  excerpt: string;
}
