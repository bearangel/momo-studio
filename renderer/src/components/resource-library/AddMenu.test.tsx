// renderer/src/components/resource-library/AddMenu.test.tsx
// AddMenu 行为：初始不显示菜单，点按钮展开并渲染标题+副文案；
// 点菜单项触发 onSelect 并收起；点击外部（document mousedown）收起。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
