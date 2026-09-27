// renderer/src/lib/message-context.ts
//
// context_json → MessageContext 防御性解析：null / 损坏 / 非法形状 → null。
// 消费点：MessageBubble chip 渲染。wire 是 MessageRow 直通（contextJson 字符串），
// 解析收口在本模块单点，杜绝各组件手写 try/JSON.parse 漂移。
//
// 形状合法条件：JSON.parse 成功 + 顶层含 skills / files 两个数组字段。
// 单字段缺失或类型错误（非数组）→ null（按"无上下文"兜底渲染）。
// images（多模态 Task 5）可选：存在且整体形状合法（元素均 {path:string,
// w/h 正数}）才带上；缺省 / 非法 → 视为无图——绝不让 images 新 null 化
// 旧消息（skills/files 仍有效时 context 照常返回）。
import type { MessageContext } from '../ipc/types';

/**
 * 把 messages.context_json 原始字符串解析为 MessageContext。
 * 任意解析失败 / 形状非法 → null（让消费方按"无上下文"渲染）。
 */
export function parseMessageContext(raw: string | null): MessageContext | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as { skills?: unknown; files?: unknown; images?: unknown };
    if (!Array.isArray(v.skills) || !Array.isArray(v.files)) return null;
    const images = shapeValidImages(v.images);
    return images !== null ? { skills: v.skills, files: v.files, images } : { skills: v.skills, files: v.files };
  } catch {
    return null;
  }
}

/** images 字段形状校验：合法数组原样返回；缺省 / 非数组 / 含畸形元素 → null（视为无图） */
function shapeValidImages(v: unknown): MessageContext['images'] | null {
  if (!Array.isArray(v)) return null;
  const ok = v.every(
    (i) =>
      typeof i === 'object' &&
      i !== null &&
      typeof (i as { path: unknown }).path === 'string' &&
      typeof (i as { w: unknown }).w === 'number' &&
      (i as { w: number }).w > 0 &&
      typeof (i as { h: unknown }).h === 'number' &&
      (i as { h: number }).h > 0,
  );
  return ok ? (v as MessageContext['images']) : null;
}
