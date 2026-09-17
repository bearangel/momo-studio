// renderer/src/components/im/composer-segments.ts
//
// 内联 pill 富输入块的纯函数层（spec 2026-09-17 §3/§4.4）：
//   segments 类型 → 发送序列化（body/mentions/context）+ 会话草稿往返。
//   不含任何 DOM 依赖——RichComposer 负责 DOM↔segments，本层可独立单测。
import type { MessageContext } from '../../ipc/types';

/** pill 五类：agent / 文件 / 任务 / 技能 / 命令（spec §3 表） */
export type PillKind = 'agent' | 'file' | 'task' | 'skill' | 'command';

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
}

export type ComposerSegment = TextSeg | PillSeg;

/** 序列化产物：三参直接对应 sendMessage 契约（IPC 形状不变） */
export interface ComposerPayload {
  body: string;
  mentions?: string[];
  context?: MessageContext;
}

/**
 * 发送序列化（spec §3 规则表）：
 *   agent → body `@label` + mentions（按 instanceId 去重保序）
 *   file  → body `@path`   + context.files（按 path 去重）
 *   task  → body `#id`（conflict-detector 照旧解析正文）
 *   skill → 不进正文（展开块由主进程注入 <user-context>，防双重曝光）+ context.skills（按 slug 去重）
 *   command → body `/name`（纯命令 pill 时序列化恰为 `/name`——整串拦截语义由形态保持）
 *   重复 pill：body 保留全部出现（等价手敲两遍），结构化数组去重
 */
export function serializeSegments(segs: ComposerSegment[]): ComposerPayload {
  let body = '';
  const mentions: string[] = [];
  const skills: Array<{ slug: string; name: string }> = [];
  const files: Array<{ path: string }> = [];
  for (const seg of segs) {
    if (seg.type === 'text') {
      body += seg.text;
      continue;
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
      case 'skill':
        if (!skills.some((s) => s.slug === seg.id)) skills.push({ slug: seg.id, name: seg.label });
        break;
      case 'command':
        body += `/${seg.id}`;
        break;
    }
  }
  return {
    body,
    mentions: mentions.length > 0 ? mentions : undefined,
    context: skills.length > 0 || files.length > 0 ? { skills, files } : undefined,
  };
}

/** 草稿序列化：segments JSON（切会话 pill 不丢） */
export function segmentsToDraft(segs: ComposerSegment[]): string {
  return JSON.stringify(segs);
}

const PILL_KINDS: ReadonlyArray<PillKind> = ['agent', 'file', 'task', 'skill', 'command'];

/**
 * 草稿反序列化：null/undefined → 空；JSON 解析失败 / 非数组 / 元素形状非法 /
 * 旧版纯文本草稿 → 整体降级为单文本 segment（宽容恢复，绝不抛错）。
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
        segs.push({ type: 'pill', kind: o.kind as PillKind, id: o.id, label: o.label });
        continue;
      }
      return [{ type: 'text', text: raw }];
    }
    return segs;
  } catch {
    return [{ type: 'text', text: raw }];
  }
}