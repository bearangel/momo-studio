// electron/src/main/task/human-answer-shared.ts
//
// 人工答复纯函数叶子（任务生命周期 v2）：HumanAnswerInput 载荷类型 + 【人工答复】
// 正文构造。从 human-answer-inject.ts 拆出（Task 14 循环依赖修复）——inject 模块
// 顶层依赖 router-bootstrap / stream-relay（重运行时网），而 lifecycle-runs 需要
// humanAnswerBody 构造正文：静态引 inject 会把重网拖进 starter→lifecycle-runs 链，
// 与 tools/catalog 顶层求值相遇即回指 task-tools 模块环（tests/agent/tools 全目录
// 加载即炸，2026-11-13 T11 引入）。本叶子零重依赖，两侧（lifecycle-runs 的
// setHumanAnswerKickoff 回调 / inject 模块自身）安全共用语汇。
/** 答复消息正文上限（超长截尾——防把大段附言灌进会话历史） */
const BODY_MAX_CHARS = 500;

/** 人工答复载荷（Task 13 tool_gate / Task 14 request_human / Task 16 IPC 共用） */
export interface HumanAnswerInput {
  decision?: 'approve' | 'deny' | 'accept' | 'reject';
  text?: string;
  selected?: string[];
  completed?: boolean;
  reason?: string;
}

const DECISION_TEXT: Record<NonNullable<HumanAnswerInput['decision']>, string> = {
  approve: '批准',
  deny: '拒绝',
  accept: '接受',
  reject: '驳回',
};

/** 构造【人工答复】正文：结构化摘要（决定/已选/附言/操作结果/理由），中文，≤500 字截尾 */
export function humanAnswerBody(title: string, answer: HumanAnswerInput): string {
  const parts: string[] = [`【人工答复】「${title}」`];
  if (answer.decision !== undefined) parts.push(`决定：${DECISION_TEXT[answer.decision]}`);
  if (answer.selected?.length) parts.push(`已选：${answer.selected.join('、')}`);
  if (answer.text) parts.push(`附言：${answer.text}`);
  if (answer.completed !== undefined) parts.push(`操作结果：${answer.completed ? '已完成' : '未完成'}`);
  if (answer.reason) parts.push(`理由：${answer.reason}`);
  const body = parts.join('\n');
  return body.length > BODY_MAX_CHARS ? body.slice(0, BODY_MAX_CHARS) : body;
}
