// renderer/src/lib/use-clamped-menu-position.test.tsx
//
// 视口钳制 hook 测试：初始钳制 / ResizeObserver 内容变高重钳制 / 卸载 disconnect。
// jsdom 布局恒零——元素尺寸经 ref 回调钉住（回调先于 useLayoutEffect 执行，初始
// 钳制即读到钉住值）；ResizeObserver 用可手动触发的桩（test-setup 的被动 polyfill
// 永不触发回调，需主动触发回调的测试自行覆写——BrowserSidebar.test 同款手法）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useClampedMenuPosition } from './use-clamped-menu-position';

/** 桩：捕获实例供测试手动触发 resize 回调（真实 ResizeObserver observe 后必发首帧回调） */
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  public readonly disconnect = vi.fn();
  public constructor(public readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this);
  }
  public observe(): void {}
  public trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

/** 钉住元素实测尺寸（jsdom offsetWidth/offsetHeight 恒 0，实例级覆写遮蔽原型 getter） */
function setSize(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
}

/**
 * 测试挂具：ref 回调合并钩子 ref 与尺寸钉子——回调在 commit 阶段先于
 * useLayoutEffect 执行，初始钳制即读到 w/h。
 */
function Harness({
  x,
  y,
  w = 0,
  h = 0,
}: {
  x: number;
  y: number;
  w?: number;
  h?: number;
}): React.ReactElement {
  const { ref, left, top } = useClampedMenuPosition<HTMLDivElement>(x, y);
  const attach = (el: HTMLDivElement | null): void => {
    (ref as { current: HTMLDivElement | null }).current = el;
    if (el) setSize(el, w, h);
  };
  return (
    <div>
      <div ref={attach} data-testid="menu" />
      <span data-testid="pos">{`${left},${top}`}</span>
    </div>
  );
}

beforeEach(() => {
  ResizeObserverStub.instances = [];
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  window.innerWidth = 800;
  window.innerHeight = 600;
});

describe('useClampedMenuPosition · 初始钳制', () => {
  it('期望坐标超出视口 → 按实测尺寸回移并留边（800x600 视口，200x100 浮层）', () => {
    render(<Harness x={700} y={550} w={200} h={100} />);
    expect(screen.getByTestId('pos').textContent).toBe('592,492');
  });

  it('视口内的坐标原样通过（不钳制）', () => {
    render(<Harness x={10} y={20} w={100} h={50} />);
    expect(screen.getByTestId('pos').textContent).toBe('10,20');
  });
});

describe('useClampedMenuPosition · ResizeObserver 内容变高重钳制（2026-11-13）', () => {
  it('尺寸变化 → 用当前 x/y 重算钳制（防异步内容展开后溢出视口）', () => {
    render(<Harness x={700} y={550} w={200} h={100} />);
    expect(screen.getByTestId('pos').textContent).toBe('592,492');
    // 内容异步展开（加载态→列表态）：高度 100 → 550，top 重钳到 600-550-8=42
    setSize(screen.getByTestId('menu'), 200, 550);
    act(() => ResizeObserverStub.instances.at(-1)!.trigger());
    expect(screen.getByTestId('pos').textContent).toBe('592,42');
  });

  it('卸载 → observer disconnect', () => {
    const view = render(<Harness x={10} y={10} />);
    const observer = ResizeObserverStub.instances.at(-1)!;
    expect(observer.disconnect).not.toHaveBeenCalled();
    view.unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it('坐标 x/y 变更 → 旧 observer disconnect、新 observer 按新坐标接管', () => {
    const view = render(<Harness x={10} y={10} w={200} h={100} />);
    const first = ResizeObserverStub.instances.at(-1)!;
    view.rerender(<Harness x={780} y={580} w={200} h={100} />);
    expect(first.disconnect).toHaveBeenCalledOnce();
    const second = ResizeObserverStub.instances.at(-1)!;
    expect(second).not.toBe(first);
    // 新坐标下的尺寸变化 → 用新 x/y 重钳（left 780 → 592）
    setSize(screen.getByTestId('menu'), 200, 100);
    act(() => second.trigger());
    expect(screen.getByTestId('pos').textContent).toBe('592,492');
  });
});
