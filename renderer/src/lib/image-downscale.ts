// renderer/src/lib/image-downscale.ts
//
// 粘贴/拖入图片的降采样（2026-09-26 多模态 spec §5）：
//   长边 >2048 → 等比缩到 2048；有 alpha 保 PNG，否则 JPEG q0.85；
//   GIF 取首帧（canvas 自然行为）；原始文件 >20MB 拒绝（性能保护）。
// 计划逻辑收口在 computeDownscalePlan 纯函数（jsdom 可测）；
// downscaleImage 是浏览器 canvas 薄封装（createImageBitmap 优先，
// HTMLImageElement+objectURL 兜底），不进单测——真机验证。
import type { PillSeg } from '../components/im/composer-segments';

/** 长边上限（px） */
export const IMAGE_MAX_EDGE = 2048;
/** 原始文件大小上限（20MB——性能保护，超过直接拒绝） */
export const IMAGE_MAX_INPUT_BYTES = 20 * 1024 * 1024;
/** 单条消息图片上限（spec §6：renderer 拦截 + sanitize 双层） */
export const IMAGE_PER_MESSAGE_CAP = 6;

/** 降采样计划：目标尺寸 + 编码格式（mime 与扩展名成对） */
export interface DownscalePlan {
  targetW: number;
  targetH: number;
  mime: 'image/png' | 'image/jpeg';
  ext: 'png' | 'jpg';
}

/**
 * 降采样计划纯函数：长边 >2048 等比缩到 2048（round 取整、窄边钳 min 1
 * 保长宽为正）；hasAlpha → PNG 否则 JPEG。非正/非整数尺寸抛中文错误
 * （调用方直接透传给内联提示）。
 */
export function computeDownscalePlan(w: number, h: number, hasAlpha: boolean): DownscalePlan {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new Error('图片尺寸非法');
  }
  const long = Math.max(w, h);
  const scale = long > IMAGE_MAX_EDGE ? IMAGE_MAX_EDGE / long : 1;
  const targetW = Math.max(1, Math.round(w * scale));
  const targetH = Math.max(1, Math.round(h * scale));
  return hasAlpha
    ? { targetW, targetH, mime: 'image/png', ext: 'png' }
    : { targetW, targetH, mime: 'image/jpeg', ext: 'jpg' };
}

export interface DownscaleResult {
  data: Uint8Array;
  w: number;
  h: number;
  ext: 'png' | 'jpg';
}

/** ImageBitmap 或 HTMLImageElement 的统一尺寸读取面 */
interface DecodedImage {
  width: number;
  height: number;
  draw(ctx: CanvasRenderingContext2D, w: number, h: number): void;
  dispose(): void;
}

async function decodeImage(file: File): Promise<DecodedImage> {
  // createImageBitmap 优先（不触发 DOM 解码、可 close 释放）；
  // 老环境兜底 HTMLImageElement + objectURL（GIF 均取首帧）
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw(ctx, w, h) {
        ctx.drawImage(bitmap, 0, 0, w, h);
      },
      dispose() {
        bitmap.close();
      },
    };
  }
  const url = URL.createObjectURL(file);
  try {
    const el = document.createElement('img');
    await new Promise<void>((resolve, reject) => {
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('图片解码失败'));
      el.src = url;
    });
    return {
      width: el.naturalWidth,
      height: el.naturalHeight,
      draw(ctx, w, h) {
        ctx.drawImage(el, 0, 0, w, h);
      },
      dispose() {
        URL.revokeObjectURL(url);
      },
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/**
 * hasAlpha 判定用确定性规则（不采样像素、不解析容器字节）：输入 png / gif /
 * webp 视为含 alpha 保 PNG，其余一律 JPEG。
 *
 * webp 纳入 alpha 集（Task 9 fold-in a）的理由：webp 的 alpha 位在 RIFF
 * VP8X chunk 里，本分支只有 file.type 字符串、无字节读取面，mime 层无法
 * 区分有/无 alpha webp。误判代价不对称——alpha webp 走 JPEG 会把透明区
 * 压成黑色（不可逆内容破坏），不透明 webp 走 PNG 只是体积偏大（可接受的
 * 保真优先取舍）。jpeg/bmp 容器无 alpha 通道，JPEG 分支安全。
 */
export function imageMightHaveAlpha(mime: string): boolean {
  return mime === 'image/png' || mime === 'image/gif' || mime === 'image/webp';
}

/**
 * 浏览器端降采样入口：>20MB 拒绝 → 解码 → computeDownscalePlan →
 * canvas 重绘 → toBlob（JPEG q0.85；PNG 的 quality 参数被浏览器忽略）→
 * Uint8Array。hasAlpha 判定见 imageMightHaveAlpha（截图粘贴主流来源是
 * png；jpeg 有损输入转 png 体积膨胀，按无损优先取 jpeg）。
 */
export async function downscaleImage(file: File): Promise<DownscaleResult> {
  if (file.size > IMAGE_MAX_INPUT_BYTES) {
    throw new Error(`图片超过 20MB 上限，已忽略：${file.name || '未命名图片'}`);
  }
  const decoded = await decodeImage(file);
  try {
    const plan = computeDownscalePlan(decoded.width, decoded.height, imageMightHaveAlpha(file.type));
    const canvas = document.createElement('canvas');
    canvas.width = plan.targetW;
    canvas.height = plan.targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('图片解码失败');
    decoded.draw(ctx, plan.targetW, plan.targetH);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, plan.mime, plan.mime === 'image/jpeg' ? 0.85 : undefined),
    );
    if (!blob) throw new Error('图片编码失败');
    return {
      data: new Uint8Array(await blob.arrayBuffer()),
      w: plan.targetW,
      h: plan.targetH,
      ext: plan.ext,
    };
  } finally {
    decoded.dispose();
  }
}

/**
 * 图片 pill 构造辅助（MentionInput 粘贴管线与 @ 菜单图片分流共用）：
 * label 缺省取路径末段（saveImage 返回的 hash 文件名）。
 */
export function makeImagePill(path: string, w: number, h: number, label?: string): PillSeg {
  const fallback = path.split('/').pop() ?? path;
  return { type: 'pill', kind: 'image', id: path, label: label || fallback, w, h };
}
