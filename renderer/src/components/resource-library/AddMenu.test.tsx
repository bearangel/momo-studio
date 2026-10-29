// renderer/src/components/resource-library/AddMenu.test.tsx
// AddMenu 行为：初始不显示菜单，点按钮展开并渲染标题+副文案；
// 点菜单项触发 onSelect 并收起；点击外部（document mousedown）收起。
// P2.3 Task 4：AddMenuItem 支持可选 lucide 前导图标。
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

  it('Esc 收起（组③补齐）', () => {
    render(<AddMenu label="添加服务器" items={items} />);
    fireEvent.click(screen.getByRole('button', { name: '添加服务器' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('手动配置…')).toBeNull();
  });
});

describe('AddMenu - 菜单项图标（P2.3 Task 4）', () => {
  it('带 icon 的菜单项渲染 lucide 图标（15px / stroke 1.75），无 icon 项不受影响', () => {
    const mixedItems = [
      { key: 'wizard', title: '新建智能体…', onSelect: vi.fn() },
      { key: 'template', title: '从模板创建…', icon: Sparkles, onSelect: vi.fn() },
    ];
    render(<AddMenu label="新建 / 导入" items={mixedItems} />);
    fireEvent.click(screen.getByRole('button', { name: '新建 / 导入' }));
    // 带 icon 项：lucide svg（class lucide-sparkles）随项渲染，尺寸 15
    const iconItem = screen.getByText('从模板创建…').closest('button');
    const svg = iconItem?.querySelector('svg.lucide-sparkles');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('width')).toBe('15');
    expect(svg?.getAttribute('stroke-width')).toBe('1.75');
    // 无 icon 项：项内无 svg
    const plainItem = screen.getByText('新建智能体…').closest('button');
    expect(plainItem?.querySelector('svg')).toBeNull();
    // 图标不改变点击语义
    fireEvent.click(screen.getByText('从模板创建…'));
    expect(mixedItems[1]!.onSelect).toHaveBeenCalled();
  });
});

describe('AddMenu - 分组分隔线（library-store-split §B）', () => {
  it('separatorBefore 项之前渲染 1px 分隔线；未标记项不渲染', () => {
    const items = [
      { key: 'local', title: '本地项', onSelect: vi.fn() },
      { key: 'remote', title: '远端项', separatorBefore: true, onSelect: vi.fn() },
    ];
    const { container } = render(<AddMenu label="添加服务器" items={items} />);
    fireEvent.click(screen.getByRole('button', { name: '添加服务器' }));
    const menu = container.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const separators = menu!.querySelectorAll(':scope > div > .h-px.bg-border-subtle');
    expect(separators).toHaveLength(1);
  });
});
