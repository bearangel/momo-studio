// renderer/src/components/resource-library/AddMenu.test.tsx
// AddMenu 行为：初始不显示菜单，点按钮展开并渲染标题+副文案；
// 点菜单项触发 onSelect 并收起；点击外部（document mousedown）收起。
// P2.3 Task 4：AddMenuItem 支持可选 lucide 前导图标（「启用预置库」项 Sparkles）。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sparkles } from 'lucide-react';
import { AddMenu } from './AddMenu';

const items = [
  { key: 'form', title: '手动配置…', hint: '名称 / 命令 / 参数', onSelect: vi.fn() },
  { key: 'json', title: '粘贴 JSON…', onSelect: vi.fn() },
];

describe('AddMenu', () => {
  it('初始不显示菜单，点按钮展开并渲染标题+副文案', () => {
    render(<AddMenu label="添加服务器" items={items} />);
    fireEvent.click(screen.getByRole('button', { name: '添加服务器' }));
    expect(screen.getByText('手动配置…')).toBeTruthy();
    expect(screen.getByText('名称 / 命令 / 参数')).toBeTruthy();
  });

  it('点菜单项触发 onSelect 并收起菜单', () => {
    render(<AddMenu label="添加服务器" items={items} />);
    fireEvent.click(screen.getByRole('button', { name: '添加服务器' }));
    fireEvent.click(screen.getByText('粘贴 JSON…'));
    expect(items[1]!.onSelect).toHaveBeenCalled();
    expect(screen.queryByText('粘贴 JSON…')).toBeNull();
  });

  it('点击菜单外部收起（document mousedown）', () => {
    render(<AddMenu label="添加服务器" items={items} />);
    fireEvent.click(screen.getByRole('button', { name: '添加服务器' }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('手动配置…')).toBeNull();
  });
});

describe('AddMenu - 菜单项图标（P2.3 Task 4）', () => {
  it('带 icon 的菜单项渲染 lucide 图标（16px / stroke 1.75），无 icon 项不受影响', () => {
    const mixedItems = [
      { key: 'wizard', title: '新建智能体…', onSelect: vi.fn() },
      { key: 'preset-library', title: '启用预置库', icon: Sparkles, onSelect: vi.fn() },
    ];
    render(<AddMenu label="新建 / 导入" items={mixedItems} />);
    fireEvent.click(screen.getByRole('button', { name: '新建 / 导入' }));
    // 带 icon 项：lucide svg（class lucide-sparkles）随项渲染，尺寸 16
    const presetItem = screen.getByText('启用预置库').closest('button');
    const svg = presetItem?.querySelector('svg.lucide-sparkles');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('width')).toBe('16');
    expect(svg?.getAttribute('stroke-width')).toBe('1.75');
    // 无 icon 项：项内无 svg
    const plainItem = screen.getByText('新建智能体…').closest('button');
    expect(plainItem?.querySelector('svg')).toBeNull();
    // 图标不改变点击语义
    fireEvent.click(screen.getByText('启用预置库'));
    expect(mixedItems[1]!.onSelect).toHaveBeenCalled();
  });
});
