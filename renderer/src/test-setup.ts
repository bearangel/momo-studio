// renderer/src/test-setup.ts
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

// jsdom 24 不提供 PointerEvent 构造函数：@testing-library/dom 的 fireEvent.pointer*
// 走 window.PointerEvent → window.Event 兜底，clientX/clientY/pointerId 等字段被
// 默默丢弃，组件依赖 e.clientX 的拖拽测试会拿到 undefined 产生 NaN。
// 用 MouseEvent 子类补一个最小 polyfill，仅承载 fireEvent 用得到的 clientX/Y/pointerId。
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    public readonly pointerId: number;
    public readonly pointerType: string;
    public readonly isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

// jsdom 不提供 ResizeObserver：被动 polyfill（observe/unobserve/disconnect no-op、
// 永不触发回调——需主动触发回调的测试自行覆写 globalThis.ResizeObserver，
// 见 BrowserSidebar.test.tsx）。MiddlePanel 经 BrowserSidebar 挂载后，任何
// 传递渲染 MiddlePanel 的测试都会走到 new ResizeObserver(...)。
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverPolyfill {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverPolyfill }).ResizeObserver =
    ResizeObserverPolyfill;
}
