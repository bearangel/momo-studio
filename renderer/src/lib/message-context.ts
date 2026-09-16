// renderer/src/lib/message-context.ts
//
// context_json → MessageContext 防御性解析：null / 损坏 / 非法形状 → null。
// 消费点：MessageBubble chip 渲染。wire 是 MessageRow 直通（contextJson 字符串），
// 解析收口在本模块单点，杜绝各组件手写 try/JSON.parse 漂移。
//
// 形状合法条件：JSON.parse 成功 + 顶层含 skills / files 两个数组字段。
// 单字段缺失或类型错误（非数组）→ null（按"无上下文"兜底渲染）。
import type { MessageContext } from '../ipc/types';

/**
 * 把 messages.context_json 原始字符串解析为 MessageContext。
 * 任意解析失败 / 形状非法 → null（让消费方按"无上下文"渲染）。
 */
export function parseMessageContext(raw: string | null): MessageContext | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as { skills?: unknown; files?: unknown };
    if (!Array.isArray(v.skills) || !Array.isArray(v.files)) return null;
    return { skills: v.skills, files: v.files };
  } catch {
    return null;
  }
}
