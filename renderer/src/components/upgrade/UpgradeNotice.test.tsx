// renderer/src/components/upgrade/UpgradeNotice.test.tsx
//
// P5 Task 2：首启升级提示组件测试。
//   - exportDir 为 null → 不渲染（return null）
//   - exportDir 有值 → 渲染标题 + 说明 + 路径 + 关闭按钮
//   - 点击关闭按钮 → 调 onDismiss
//   - NoticeStack 条目形态（spec 2026-09-15）：无 fixed 定位（容器锚定）、无遮罩、
//     pointer-events-auto（容器 pointer-events-none，条目不自宣则真实浏览器按钮死点击）
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UpgradeNotice } from './UpgradeNotice';

describe('UpgradeNotice（P5 Task 2）', () => {
  it('exportDir 为 null 时不渲染任何东西', () => {
    const { container } = render(<UpgradeNotice exportDir={null} onDismiss={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('exportDir 有值时渲染标题 + 路径 + 关闭按钮', () => {
    render(
      <UpgradeNotice
        exportDir="/tmp/upgrade-export-20260824-101530"
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText('已升级到 Momo Studio 2.0')).toBeInTheDocument();
    expect(
      screen.getByText('/tmp/upgrade-export-20260824-101530'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '知道了' })).toBeInTheDocument();
  });

  it('说明文案提及自动导出', () => {
    render(
      <UpgradeNotice exportDir="/tmp/export" onDismiss={() => {}} />,
    );
    // 说明文字涵盖：全新架构 / 未迁移 / 已自动导出（brief 要求）
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/全新架构|历史数据|自动导出/);
  });

  it('点击「知道了」触发 onDismiss', () => {
    const onDismiss = vi.fn();
    render(<UpgradeNotice exportDir="/tmp/export" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('是 NoticeStack 条目形态（无 fixed 定位、非遮罩、可交互）', () => {
    const { container } = render(
      <UpgradeNotice exportDir="/tmp/export" onDismiss={() => {}} />,
    );
    const root = container.firstChild as HTMLElement;
    // 定位职责移交 NoticeStack 容器（安全区右下锚定）——条目自身不得再 fixed
    expect(root.className).not.toMatch(/fixed/);
    // 无 inset-0：不是全屏遮罩
    expect(root.className).not.toMatch(/inset-0/);
    // 容器 pointer-events-none，条目必须自宣 pointer-events-auto（jsdom 不做
    // hit-testing，此断言是真实浏览器可点击性的唯一回归锁）
    expect(root.className).toMatch(/pointer-events-auto/);
  });

  it('路径展示用等宽字体（font-mono）', () => {
    render(
      <UpgradeNotice exportDir="/tmp/export" onDismiss={() => {}} />,
    );
    const pathEl = screen.getByText('/tmp/export');
    expect(pathEl.className).toMatch(/font-mono/);
  });
});
