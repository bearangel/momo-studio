// renderer/src/components/resource-library/ResourceRow.test.tsx
// ResourceRow 行为：渲染名称/描述 + 选中态 accent 边框；尾部操作槽按条件渲染
// 安装/启用/已启用/已安装/删除/编辑/配置；操作按钮点击 stopPropagation 不冒泡到行 onSelect。
// 用例 6 语义对齐 spec 2026-09-22 §6.1 与 ResourceDetail 现行条件（可用性不变）：
// custom agent →「编辑」（模型配置走 DefinitionEditor，无独立「配置」按钮）；
// marketplace 已装 agent →「配置」。二者不可能在同一 item 上同时命中，分两段断言。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResourceRow } from './ResourceRow';
import type { ResourceItem } from '../../ipc/types';

function mkItem(over: Partial<ResourceItem>): ResourceItem {
  return {
    id: 'custom-mcp-x', type: 'mcp', source: 'custom', slug: 'x', name: '服务器X',
    description: '一行描述', installed: true, installable: false, removable: true, ...over,
  } as ResourceItem;
}

const noop = (): void => undefined;

describe('ResourceRow', () => {
  it('渲染名称/描述，点行触发 onSelect', () => {
    const onSelect = vi.fn();
    render(<ResourceRow item={mkItem({})} selected={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('服务器X'));
    expect(onSelect).toHaveBeenCalledWith('custom-mcp-x');
  });

  it('选中态有 accent 边框类', () => {
    const { container } = render(<ResourceRow item={mkItem({})} selected={true} onSelect={noop} />);
    expect(container.firstChild).toHaveClass('border-accent-500');
  });

  it('可安装项显示安装按钮，点击不冒泡到行', () => {
    const onInstall = vi.fn();
    const onSelect = vi.fn();
    render(
      <ResourceRow
        item={mkItem({ installable: true, installed: false })}
        selected={false} onSelect={onSelect} onInstall={onInstall}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    expect(onInstall).toHaveBeenCalledWith('custom-mcp-x');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('p2p 可导入项按钮文案为「导入」（与详情面板口径一致，走查 A3）', () => {
    const onInstall = vi.fn();
    render(
      <ResourceRow
        item={mkItem({ source: 'p2p', installable: true, installed: false, removable: false })}
        selected={false} onSelect={noop} onInstall={onInstall}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    expect(onInstall).toHaveBeenCalledWith('custom-mcp-x');
    expect(screen.queryByRole('button', { name: '安装' })).toBeNull();
  });

  it('禁用的 mcp DB 行派生项显示「已禁用」（warning）替代「已安装」（组⑤）', () => {
    render(<ResourceRow item={mkItem({ removable: false, mcp: { enabled: false } })} selected={false} onSelect={noop} />);
    const mark = screen.getByText('已禁用');
    expect(mark.className).toContain('text-status-warning');
    expect(screen.queryByText('已安装')).toBeNull();
  });

  it('启用的 mcp DB 行派生项保持「已安装」（组⑤）', () => {
    render(<ResourceRow item={mkItem({ removable: false, mcp: { enabled: true } })} selected={false} onSelect={noop} />);
    expect(screen.getByText('已安装')).toBeTruthy();
    expect(screen.queryByText('已禁用')).toBeNull();
  });

  it('builtin agent 未启用显示启用按钮；已启用显示已启用标记', () => {
    const { rerender } = render(
      <ResourceRow
        item={mkItem({ type: 'agent', source: 'builtin', installed: true, removable: false, builtin: { agentEnabled: false } })}
        selected={false} onSelect={noop} onEnable={noop}
      />,
    );
    expect(screen.getByRole('button', { name: '启用' })).toBeTruthy();
    rerender(
      <ResourceRow
        item={mkItem({ type: 'agent', source: 'builtin', installed: true, removable: false, builtin: { agentEnabled: true } })}
        selected={false} onSelect={noop} onEnable={noop}
      />,
    );
    expect(screen.getByText('已启用')).toBeTruthy();
  });

  it('已安装且可删项显示删除按钮（aria-label 含名称；hover 行才浮现——组③ B9）', () => {
    const { container } = render(<ResourceRow item={mkItem({})} selected={false} onSelect={noop} onDelete={noop} />);
    const delBtn = screen.getByRole('button', { name: '删除 服务器X' });
    expect(delBtn).toBeTruthy();
    // 默认隐藏（opacity-0 + 不挡指针），hover 行（group）/键盘聚焦才显现
    expect(delBtn).toHaveClass('opacity-0', 'pointer-events-none');
    expect(delBtn).toHaveClass('group-hover:opacity-100', 'focus-visible:opacity-100');
    // 行本身带 group（hover 作用域）
    expect(container.firstChild).toHaveClass('group');
  });

  it('custom agent 显示编辑、marketplace 已装 agent 显示配置（传入回调时）', () => {
    const { unmount } = render(
      <ResourceRow
        item={mkItem({ type: 'agent', installed: true })}
        selected={false} onSelect={noop} onEdit={noop} onConfigure={noop}
      />,
    );
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy();
    // custom agent 模型配置走编辑弹窗（DefinitionEditor），不渲染独立「配置」按钮
    expect(screen.queryByRole('button', { name: '配置' })).toBeNull();
    unmount();
    render(
      <ResourceRow
        item={mkItem({ type: 'agent', source: 'marketplace' })}
        selected={false} onSelect={noop} onEdit={noop} onConfigure={noop}
      />,
    );
    expect(screen.getByRole('button', { name: '配置' })).toBeTruthy();
  });
});

// ── 组④ C11：行键盘可达 ──────────────────────────────────────────────────
describe('ResourceRow - 键盘可达（组④ C11）', () => {
  it('行 role=button、tabIndex=0、aria-label 含名称与描述', () => {
    render(<ResourceRow item={mkItem({})} selected={false} onSelect={noop} />);
    const row = screen.getByRole('button', { name: '服务器X，一行描述' });
    expect(row.getAttribute('tabindex')).toBe('0');
  });

  it('Enter / Space 触发 onSelect（div 无原生 Enter 语义，须显式处理）', () => {
    const onSelect = vi.fn();
    render(<ResourceRow item={mkItem({})} selected={false} onSelect={onSelect} />);
    const row = screen.getByRole('button', { name: '服务器X，一行描述' });
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('custom-mcp-x');
    fireEvent.keyDown(row, { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });
});
