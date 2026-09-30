// renderer/src/lib/message-context.ts
//
// context_json → MessageContext 防御性解析：null / 损坏 / 非法形状 → null。
// 消费点：MessageBubble chip 渲染。wire 是 MessageRow 直通（contextJson 字符串），
// 解析收口在本模块单点，杜绝各组件手写 try/JSON.parse 漂移。
//
// 形状合法条件：JSON.parse 成功 + 顶层含 skills / files 两个数组字段。
// 单字段缺失或类型错误（非数组）→ null（按"无上下文"兜底渲染）。
// images（多模态 Task 5）与 sessions（跨会话引用）可选：存在且整体形状合法才带上；
// 缺省 / 非法 → 各自视为无图 / 无引用——绝不让可选字段畸形 null 化整个 context
// （skills/files 仍有效时 context 照常返回）。
import type { MessageContext } from '../ipc/types';

/**
 * 把 messages.context_json 原始字符串解析为 MessageContext。
 * 任意解析失败 / 形状非法 → null（让消费方按"无上下文"渲染）。
 */
export function parseMessageContext(raw: string | null): MessageContext | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as {
      skills?: unknown;
      files?: unknown;
      images?: unknown;
      sessions?: unknown;
    };
    if (!Array.isArray(v.skills) || !Array.isArray(v.files)) return null;
    const images = shapeValidImages(v.images);
    const sessions = shapeValidSessions(v.sessions);
    // 逐字段独立组装：images / sessions 各自合法才携带，互不牵连
    return {
      skills: v.skills,
      files: v.files,
      ...(images !== null ? { images } : {}),
      ...(sessions !== null ? { sessions } : {}),
    };
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

/** sessions 字段形状校验：合法数组原样返回；缺省 / 非数组 / 含畸形元素 → null（视为无会话引用） */
function shapeValidSessions(v: unknown): MessageContext['sessions'] | null {
  if (!Array.isArray(v)) return null;
  const ok = v.every(
    (s) =>
      typeof s === 'object' &&
      s !== null &&
      typeof (s as { sessionId: unknown }).sessionId === 'string' &&
      typeof (s as { title: unknown }).title === 'string',
  );
  return ok ? (v as MessageContext['sessions']) : null;
}
