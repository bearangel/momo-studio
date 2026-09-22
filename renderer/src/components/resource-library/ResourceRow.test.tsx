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

  it('已安装且可删项显示删除按钮（aria-label 含名称）', () => {
    render(<ResourceRow item={mkItem({})} selected={false} onSelect={noop} onDelete={noop} />);
    expect(screen.getByRole('button', { name: '删除 服务器X' })).toBeTruthy();
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
