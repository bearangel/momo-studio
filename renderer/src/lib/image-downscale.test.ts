// renderer/src/lib/image-downscale.test.ts
//
// computeDownscalePlan 纯函数全覆盖（spec 2026-09-26 多模态 §5「降采样」）：
//   长边 >2048 → 等比缩到 2048（round，min 1）；恰好 2048 / 小图不动；
//   hasAlpha → PNG 否则 JPEG。downscaleImage 是浏览器 canvas 路径
//   （createImageBitmap / canvas.toBlob 均超出 jsdom 能力），不在单测范围——
//   逻辑全部收口在 computeDownscalePlan，canvas 层保持薄。
import { describe, it, expect } from 'vitest';
import { computeDownscalePlan, imageMightHaveAlpha } from './image-downscale';

describe('computeDownscalePlan（降采样计划纯函数）', () => {
  it('横向长图 3000×2000 → 2048×1365，保 aspect', () => {
    // 3000/2000 = 1.5；2048/1.5 = 1365.33 → round 1365
    expect(computeDownscalePlan(3000, 2000, false)).toEqual({
      targetW: 2048,
      targetH: 1365,
      mime: 'image/jpeg',
      ext: 'jpg',
    });
  });

  it('纵向长图 2000×3000 → 1365×2048（长边判定与方向无关）', () => {
    expect(computeDownscalePlan(2000, 3000, false)).toEqual({
      targetW: 1365,
      targetH: 2048,
      mime: 'image/jpeg',
      ext: 'jpg',
    });
  });

  it('hasAlpha=true → PNG 分支（长边超限与未超限各一）', () => {
    expect(computeDownscalePlan(3000, 2000, true)).toEqual({
      targetW: 2048,
      targetH: 1365,
      mime: 'image/png',
      ext: 'png',
    });
    expect(computeDownscalePlan(100, 50, true)).toEqual({
      targetW: 100,
      targetH: 50,
      mime: 'image/png',
      ext: 'png',
    });
  });

  it('hasAlpha=false → JPEG 分支（小图不动）', () => {
    expect(computeDownscalePlan(100, 50, false)).toEqual({
      targetW: 100,
      targetH: 50,
      mime: 'image/jpeg',
      ext: 'jpg',
    });
  });

  it('恰好 2048 长边 → 不缩放（>2048 才触发）', () => {
    expect(computeDownscalePlan(2048, 1536, false)).toEqual({
      targetW: 2048,
      targetH: 1536,
      mime: 'image/jpeg',
      ext: 'jpg',
    });
    expect(computeDownscalePlan(1536, 2048, false)).toEqual({
      targetW: 1536,
      targetH: 2048,
      mime: 'image/jpeg',
      ext: 'jpg',
    });
  });

  it('极端窄边缩放后 round 到 0 → 钳到 min 1（5000×1 → 2048×1）', () => {
    // 1 × (2048/5000) = 0.4096 → round 0 → min 1
    expect(computeDownscalePlan(5000, 1, true)).toEqual({
      targetW: 2048,
      targetH: 1,
      mime: 'image/png',
      ext: 'png',
    });
    expect(computeDownscalePlan(1, 5000, true)).toEqual({
      targetW: 1,
      targetH: 2048,
      mime: 'image/png',
      ext: 'png',
    });
  });

  it('非正尺寸（0 / 负数 / 非整数）→ 抛中文错误（错误路径专项）', () => {
    expect(() => computeDownscalePlan(0, 100, false)).toThrow('图片尺寸非法');
    expect(() => computeDownscalePlan(100, -1, false)).toThrow('图片尺寸非法');
    expect(() => computeDownscalePlan(100.5, 100, false)).toThrow('图片尺寸非法');
  });
});

// === alpha 判定规则（Task 9 fold-in a）：webp 含 alpha 时 JPEG 编码会把透明区
//     压成黑色（不可逆破坏）——webp 一律走 PNG（保真优先于体积，见实现注释）
describe('imageMightHaveAlpha（按 mime 的确定性 alpha 判定）', () => {
  it('png / gif / webp → true（保 PNG 分支，透明不丢）', () => {
    expect(imageMightHaveAlpha('image/png')).toBe(true);
    expect(imageMightHaveAlpha('image/gif')).toBe(true);
    expect(imageMightHaveAlpha('image/webp')).toBe(true);
  });

  it('jpeg / bmp / 未知 mime → false（JPEG 分支）', () => {
    expect(imageMightHaveAlpha('image/jpeg')).toBe(false);
    expect(imageMightHaveAlpha('image/bmp')).toBe(false);
    expect(imageMightHaveAlpha('')).toBe(false);
  });
});
