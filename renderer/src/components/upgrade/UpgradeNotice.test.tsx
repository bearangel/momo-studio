// renderer/src/components/upgrade/UpgradeNotice.test.tsx
//
// P5 Task 2：首启升级提示组件测试。
//   - exportDir 为 null → 不渲染（return null）
//   - exportDir 有值 → 渲染标题 + 说明 + 路径 + 关闭按钮
//   - 点击关闭按钮 → 调 onDismiss
//   - 非模态卡片：fixed 右下角，无遮罩（无 fixed inset-0 元素）
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

  it('是非模态卡片（fixed 定位、非遮罩）', () => {
    const { container } = render(
      <UpgradeNotice exportDir="/tmp/export" onDismiss={() => {}} />,
    );
    const root = container.firstChild as HTMLElement;
    // fixed 定位类：表明非流式布局，绝对定位到视口
    expect(root.className).toMatch(/fixed/);
    // 无 inset-0：不是全屏遮罩
    expect(root.className).not.toMatch(/inset-0/);
    // 右下角（right- / bottom- 锚点）
    expect(root.className).toMatch(/right-/);
    expect(root.className).toMatch(/bottom-/);
  });

  it('路径展示用等宽字体（font-mono）', () => {
    render(
      <UpgradeNotice exportDir="/tmp/export" onDismiss={() => {}} />,
    );
    const pathEl = screen.getByText('/tmp/export');
    expect(pathEl.className).toMatch(/font-mono/);
  });
});