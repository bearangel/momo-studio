// renderer/src/components/notices/CenterPromptLayer.test.tsx
//
// Tier A 居中层测试（spec 2026-09-15 §4.2，M2）：
//   - children 渲染于层内（层 pointer-events-none 不挡其余 UI；锚点 pointer-events-auto）
//   - 居中锚避让侧栏：rect.x=800 → 锚点 left = 800/2（安全区中点）
//   - 无 children 也常驻渲染（App 常挂载，卡自管显隐）
//   - 结构回归锁：锚点与层都不得带 transform——transform 祖先会成为 position:fixed
//     后代的 containing block，信任卡遮罩（fixed inset-0）会被困在 400px 锚点盒内
//     而非盖满视口（jsdom 无布局测不出，真机必炸——2026-09-15 M2 实现时发现）
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { CenterPromptLayer } from './CenterPromptLayer';
import { useBrowserSidebarRectStore } from '../../stores/browser-sidebar-rect.store';

beforeEach(() => useBrowserSidebarRectStore.getState().setRect(null));

describe('CenterPromptLayer（Tier A 居中层）', () => {
  it('渲染 children 于层内（pointer-events-none 层 + auto 卡）', () => {
    render(
      <CenterPromptLayer>
        <div data-testid="tier-a-child">卡</div>
      </CenterPromptLayer>,
    );
    const layer = screen.getByTestId('center-prompt-layer');
    expect(layer).toBeInTheDocument();
    expect(layer.className).toContain('pointer-events-none');
    expect(layer.contains(screen.getByTestId('tier-a-child'))).toBe(true);
    expect(screen.getByTestId('tier-a-child').parentElement!.className).toContain('pointer-events-auto');
  });

  it('居中锚避让侧栏：rect.x=800 → 锚点 left = 800/2（安全区中点）', () => {
    render(
      <CenterPromptLayer>
        <div>卡</div>
      </CenterPromptLayer>,
    );
    act(() => {
      useBrowserSidebarRectStore.getState().setRect({ x: 800, y: 40, width: 224, height: 700 });
    });
    const anchor = screen.getByTestId('center-prompt-anchor');
    expect(anchor.style.left).toBe('400px');
  });

  it('无 children 也常驻渲染（App 常挂载——卡自管显隐，层不随卡消散）', () => {
    render(<CenterPromptLayer />);
    expect(screen.getByTestId('center-prompt-layer')).toBeInTheDocument();
    expect(screen.getByTestId('center-prompt-anchor')).toBeInTheDocument();
  });

  it('结构回归锁：锚点与层均无 transform（信任卡遮罩 fixed inset-0 须相对视口盖满）', () => {
    render(
      <CenterPromptLayer>
        <div>卡</div>
      </CenterPromptLayer>,
    );
    // WHY：transform/translate/scale/rotate 祖先 = fixed 后代的 containing block——
    // 遮罩会被锚点盒截断成 400px 卡区大小，阻断压暗全 UI 的语义彻底失效。
    // 居中位移由各卡自带 -translate-x/y-1/2（卡自身 transform 不影响兄弟遮罩）。
    const layer = screen.getByTestId('center-prompt-layer');
    const anchor = screen.getByTestId('center-prompt-anchor');
    for (const cls of [layer.className, anchor.className]) {
      expect(cls).not.toMatch(/translate|scale|rotate|transform/);
    }
  });
});
