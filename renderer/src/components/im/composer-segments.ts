// renderer/src/components/im/composer-segments.ts
//
// 内联 pill 富输入块的纯函数层（spec 2026-09-17 §3/§4.4）：
//   segments 类型 → 发送序列化（body/mentions/context）+ 会话草稿往返。
//   不含任何 DOM 依赖——RichComposer 负责 DOM↔segments，本层可独立单测。
import type { MessageContext } from '../../ipc/types';
// 单条消息图片上限：与输入拦截层共用同一常量（Task 9 fold-in c 统一——
// 此前的 IMAGE_PILL_LIMIT 双定义会漂移）。image-downscale 对本模块只有
// type-only 反向依赖（PillSeg），此处值导入不构成运行时环。
import { IMAGE_PER_MESSAGE_CAP } from '../../lib/image-downscale';

/** pill 七类：agent / 文件 / 任务 / 技能 / 命令 / 图片 / 会话（spec §3 表 + 2026-09-26 多模态 §10 + 2026-09-30 跨会话引用 §5） */
export type PillKind = 'agent' | 'file' | 'task' | 'skill' | 'command' | 'image' | 'session';

/** 文本段（连续文字，含用户手敲的一切） */
export interface TextSeg {
  type: 'text';
  text: string;
}

/** pill 段：id = instanceId / 文件路径 / 任务 id / slug / 命令名；label = 显示名 */
export interface PillSeg {
  type: 'pill';
  kind: PillKind;
  id: string;
  label: string;
  /** 图片宽 px（仅 kind='image'：降采样后尺寸，序列化进 context.images 供 token 估算） */
  w?: number;
  /** 图片高 px（仅 kind='image'） */
  h?: number;
}

export type ComposerSegment = TextSeg | PillSeg;

/** 序列化产物：三参直接对应 sendMessage 契约（IPC 形状不变） */
export interface ComposerPayload {
  body: string;
  mentions?: string[];
  context?: MessageContext;
}

/**
 * 发送序列化（spec §3 规则表 + 2026-09-26 多模态 §5/§10 + 2026-09-30 跨会话引用 §5）：
 *   agent → body `@label` + mentions（按 instanceId 去重保序）
 *   file  → body `@path`   + context.files（按 path 去重）
 *   task  → body `#id`（conflict-detector 照旧解析正文）
 *   skill → 不进正文（展开块由主进程注入 <user-context>，防双重曝光）+ context.skills（按 slug 去重）
 *   command → body `/name`（纯命令 pill 时序列化恰为 `/name`——整串拦截语义由形态保持）
 *   image → body 锚点 `[图片: label]` + context.images（按 path 去重保序、
 *           上限 6 张；w/h 非正整数不进 images——与主进程 sanitize 同规则防御）
 *   session → body @label + context.sessions（按 sessionId 去重——指针注入，正文锚点无双重曝光，spec 2026-09-30 §5）
 *   重复 pill：body 保留全部出现（等价手敲两遍），结构化数组去重
 *   标记分隔（spec §3「标记分隔」行）：标记前（body 非空且末字符非空白时）与
 *   标记后各保证一个空格——永不叠加双空格（后续内容自带首空白时尾随空格让
 *   位）。对齐 v2.11 insertMention 尾随空格语义，维持 conflict-detector 双向
 *   空白边界解析；收尾空格由 handleSend 端 trim 处理。
 */
export function serializeSegments(segs: ComposerSegment[]): ComposerPayload {
  let body = '';
  // 上一个标记承诺的尾随空格：延迟到下一内容落盘，避免与文本段自带首空白叠成双空格
  let pendingSpace = false;
  const mentions: string[] = [];
  const skills: Array<{ slug: string; name: string }> = [];
  const files: Array<{ path: string }> = [];
  const images: Array<{ path: string; w: number; h: number }> = [];
  const sessions: Array<{ sessionId: string; title: string }> = [];
  const pushImage = (seg: PillSeg): void => {
    if (images.some((i) => i.path === seg.id)) return;
    if (images.length >= IMAGE_PER_MESSAGE_CAP) return;
    // w/h 与主进程 sanitizeMessageContext 同规则（正整数）——非法形状不进 IPC 载荷
    const dims = validImageDims(seg.w, seg.h);
    if (dims === null) return;
    images.push({ path: seg.id, w: dims.w, h: dims.h });
  };
  for (const seg of segs) {
    if (seg.type === 'text') {
      if (seg.text === '') continue;
      if (pendingSpace) {
        if (!/\s/.test(seg.text.charAt(0))) body += ' ';
        pendingSpace = false;
      }
      body += seg.text;
      continue;
    }
    // skill 不进正文、不参与标记分隔（对 body 完全透明）
    if (seg.kind === 'skill') {
      if (!skills.some((s) => s.slug === seg.id)) skills.push({ slug: seg.id, name: seg.label });
      continue;
    }
    // 标记前保证分隔：上一标记的待落空格优先，否则 body 非空且末字符非空白才补
    if (pendingSpace) {
      body += ' ';
      pendingSpace = false;
    } else if (body !== '' && !/\s/.test(body.charAt(body.length - 1))) {
      body += ' ';
    }
    switch (seg.kind) {
      case 'agent':
        body += `@${seg.label}`;
        if (!mentions.includes(seg.id)) mentions.push(seg.id);
        break;
      case 'file':
        body += `@${seg.id}`;
        if (!files.some((f) => f.path === seg.id)) files.push({ path: seg.id });
        break;
      case 'task':
        body += `#${seg.id}`;
        break;
      case 'command':
        body += `/${seg.id}`;
        break;
      case 'image':
        body += `[图片: ${seg.label}]`;
        pushImage(seg);
        break;
      case 'session':
        body += `@${seg.label}`;
        if (!sessions.some((s) => s.sessionId === seg.id)) sessions.push({ sessionId: seg.id, title: seg.label });
        break;
    }
    pendingSpace = true;
  }
  if (pendingSpace) body += ' ';
  return {
    body,
    mentions: mentions.length > 0 ? mentions : undefined,
    context:
      skills.length > 0 || files.length > 0 || images.length > 0 || sessions.length > 0
        ? {
            skills,
            files,
            ...(images.length > 0 ? { images } : {}),
            ...(sessions.length > 0 ? { sessions } : {}),
          }
        : undefined,
  };
}

/** 草稿序列化：segments JSON（切会话 pill 不丢） */
export function segmentsToDraft(segs: ComposerSegment[]): string {
  return JSON.stringify(segs);
}

const PILL_KINDS: ReadonlyArray<PillKind> = ['agent', 'file', 'task', 'skill', 'command', 'image', 'session'];

/** image pill 的 w/h 形状校验（正整数——与主进程 sanitizeMessageContext 同规则）；合法返回数值对，否则 null */
function validImageDims(w: unknown, h: unknown): { w: number; h: number } | null {
  if (typeof w !== 'number' || typeof h !== 'number') return null;
  if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) return null;
  return { w, h };
}

/**
 * 草稿反序列化：null/undefined → 空；JSON 解析失败 / 非数组 / 元素形状非法 /
 * 旧版纯文本草稿 → 整体降级为单文本 segment（宽容恢复，绝不抛错）。
 * image pill 额外要求 w/h 为正整数（缺失/非法 → 整份降级，与既有形状规则一致）。
 */
export function draftToSegments(raw: string | null | undefined): ComposerSegment[] {
  if (raw === null || raw === undefined) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [{ type: 'text', text: raw }];
    const segs: ComposerSegment[] = [];
    for (const item of v) {
      if (typeof item !== 'object' || item === null) return [{ type: 'text', text: raw }];
      const o = item as Record<string, unknown>;
      if (o.type === 'text' && typeof o.text === 'string') {
        segs.push({ type: 'text', text: o.text });
        continue;
      }
      if (
        o.type === 'pill' &&
        typeof o.kind === 'string' &&
        PILL_KINDS.includes(o.kind as PillKind) &&
        typeof o.id === 'string' &&
        typeof o.label === 'string'
      ) {
        const kind = o.kind as PillKind;
        const dims = validImageDims(o.w, o.h);
        if (kind === 'image' && dims === null) {
          return [{ type: 'text', text: raw }];
        }
        const seg: PillSeg = { type: 'pill', kind, id: o.id, label: o.label };
        if (kind === 'image' && dims !== null) {
          seg.w = dims.w;
          seg.h = dims.h;
        }
        segs.push(seg);
        continue;
      }
      return [{ type: 'text', text: raw }];
    }
    return segs;
  } catch {
    return [{ type: 'text', text: raw }];
  }
}
