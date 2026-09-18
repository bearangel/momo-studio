// renderer/src/lib/text-hygiene.ts
//
// electron/src/main/storage/messages/text-hygiene.ts 的镜像实现（F3）。
// 主进程无法 import renderer 源码（electron tsconfig rootDir 封死），故镜像 +
// 双侧单测锁语义——改任意一侧必须同步另一侧（momo-boundary-rules 镜像纪律，
// 同 stream-aggregator ↔ export-aggregator 先例）。

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
