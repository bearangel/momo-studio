// renderer/src/stores/browser-sidebar-rect.store.ts
//
// 浏览器侧栏容器 rect——安全区（SafeArea）唯一真相源。
// 写入者唯一：BrowserSidebar 的 ResizeObserver 回调（与 setSidebarBounds 同一观察者，
// 零新增观察者）。消费者：CenterPromptLayer（Tier A 居中）/ NoticeStack（Tier B 右下）。
// 存在动机：原生 WebContentsView 按占位区 rect 在 OS 合成层盖住一切 renderer DOM，
// 按窗口裸坐标定位的提示可能被盖死（两次先例：拖拽手柄 bug 1、释放卡遮挡 bug）。
import { useEffect, useState } from 'react';
import { create } from 'zustand';

export interface SidebarRectLite {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BrowserSidebarRectState {
  rect: SidebarRectLite | null;
  setRect: (rect: SidebarRectLite | null) => void;
}

export const useBrowserSidebarRectStore = create<BrowserSidebarRectState>((set) => ({
  rect: null,
  setRect: (rect) => set({ rect }),
}));

export interface SafeArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 安全区推导：rect null 或折叠竖条（≤40px，不构成遮挡）→ 全窗口；
 * 否则取侧栏左侧区域（侧栏右停靠）。窗口尺寸经 resize 订阅保持实时。
 */
export function useSafeArea(): SafeArea {
  const rect = useBrowserSidebarRectStore((s) => s.rect);
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = (): void => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  if (!rect || rect.width <= 40) return { left: 0, top: 0, right: vp.w, bottom: vp.h };
  return { left: 0, top: 0, right: rect.x, bottom: vp.h };
}
