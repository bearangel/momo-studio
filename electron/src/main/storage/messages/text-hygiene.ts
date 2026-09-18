// electron/src/main/storage/messages/text-hygiene.ts
//
// 正文隐藏上下文剥离（F3：2026-09-18 实测会话中模型把私有规划写进
// <secrecy>…</secrecy> 块并原样出现在用户可见消息与导出里——内部策略文本
// （工具预算、省钱决策）不应暴露给用户）。
//
// 三个消费点（electron 侧两处 + renderer 镜像一处）：
//   1. events-repo.aggregateTextDeltas —— messages.body 回写（单一真相源落库视图）
//   2. im/export-aggregator 文本段 —— 会话导出渲染
//   3. renderer stream-aggregator（镜像本函数，见 renderer/src/lib/text-hygiene.ts）
//      —— 实时 UI 与重载还原
//
// 设计取舍：事件库（message_events.text_delta 原文）不清洗——保真优先，
// 断点续跑/审计仍可看到原始流；只在与用户相交的「聚合呈现面」剥离。
// 未闭合尾段（流式进行中，模型正在写 secrecy 块）也剥离——从开标签起隐藏，
// 闭标签到达后由完整块规则接管。

/** 完整 secrecy 块（非贪婪，跨行） */
const SECRECY_BLOCK_RE = /<secrecy>[\s\S]*?<\/secrecy>/g;
/** 未闭合尾段（流式中途——开标签之后全部隐藏，闭标签到达即转为完整块规则） */
const SECRECY_UNCLOSED_RE = /<secrecy>[\s\S]*$/;

/**
 * 剥离正文中的 <secrecy> 隐藏上下文块（完整块 + 未闭合尾段）。
 * 不含标签的文本原样返回（快速路径，避免对每条增量聚合跑正则）。
 */
export function stripHiddenContext(text: string): string {
  if (!text.includes('<secrecy>')) return text;
  return text.replace(SECRECY_BLOCK_RE, '').replace(SECRECY_UNCLOSED_RE, '');
}
