// renderer/src/lib/use-clamped-menu-position.ts
// 光标定位浮层（右键菜单 / 轻量下拉）的视口钳制：fixed 定位 + 测量实际尺寸后回移。
// 2026-11-11 抽出——FileContextMenu / BoardCard / DelegatedTaskCard / WorkspaceTabs
// 四处此前各自裸用 clientX/clientY 定位，文件树底部右键实测溢出屏幕。
import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/** 浮层与视口边缘的最小留白（px） */
export const VIEWPORT_MARGIN = 8;

/**
 * @param x 期望的视口 left（通常传 contextmenu 的 clientX）
 * @param y 期望的视口 top
 * @returns ref 挂到浮层根节点；left/top 为钳制后的坐标
 *
 * jsdom 中 offsetWidth/offsetHeight 恒为 0——同逻辑不炸，钳制退化为留白边界。
 */
export function useClampedMenuPosition<T extends HTMLElement>(
  x: number,
  y: number,
): { ref: RefObject<T>; left: number; top: number } {
  const ref = useRef<T>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos({
      left: Math.max(0, Math.min(x, window.innerWidth - el.offsetWidth - VIEWPORT_MARGIN)),
      top: Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight - VIEWPORT_MARGIN)),
    });
  }, [x, y]);

  return { ref, left: pos.left, top: pos.top };
}
