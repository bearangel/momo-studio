// renderer/src/components/resource-library/ResourceCard.test.tsx
// ResourceCard 行为：展示 name/description/SourceBadge；按 installed/installable/removable
// 三态切换安装/删除/已安装；点击卡片触发 onSelect；按钮点击 stopPropagation。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResourceCard } from './ResourceCard';
import type { ResourceItem } from '../../ipc/types';

const baseItem = (overrides: Partial<ResourceItem> = {}): ResourceItem => ({
  id: 'builtin-agent-pm', type: 'agent', source: 'builtin',
  slug: 'pm', name: '项目经理', description: '协调',
  installed: true, installable: false, removable: false,
  ...overrides,
});

describe('ResourceCard', () => {
  it('显示名称 + 描述 + source 徽章', () => {
    render(<ResourceCard item={baseItem()} selected={false} onSelect={() => {}} />);
    expect(screen.getByText('项目经理')).toBeInTheDocument();
    expect(screen.getByText('协调')).toBeInTheDocument();
    expect(screen.getByText('系统预置')).toBeInTheDocument();
  });

  it('builtin 项显示"✓ 已安装"无删除按钮', () => {
    render(<ResourceCard item={baseItem()} selected={false} onSelect={() => {}} />);
    expect(screen.getByText(/已安装/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/删除/)).not.toBeInTheDocument();
  });

  it('custom 项显示删除按钮', () => {
    const onDelete = vi.fn();
    render(
      <ResourceCard
        item={baseItem({ id: 'custom-mcp-github', source: 'custom', removable: true })}
        selected={false}
        onSelect={() => {}}
        onDelete={onDelete}
      />,
    );
    const delBtn = screen.getByLabelText(/删除/);
    fireEvent.click(delBtn);
    expect(onDelete).toHaveBeenCalledWith('custom-mcp-github');
  });

  it('marketplace 未装项显示安装按钮', () => {
    const onInstall = vi.fn();
    render(
      <ResourceCard
        item={baseItem({
          id: 'marketplace-skill-x', source: 'marketplace',
          installed: false, installable: true,
        })}
        selected={false}
        onSelect={() => {}}
        onInstall={onInstall}
      />,
    );
    const installBtn = screen.getByRole('button', { name: /安装/ });
    fireEvent.click(installBtn);
    expect(onInstall).toHaveBeenCalledWith('marketplace-skill-x');
  });

  it('点击卡片触发 onSelect（不是按钮）', () => {
    const onSelect = vi.fn();
    render(<ResourceCard item={baseItem()} selected={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('项目经理'));
    expect(onSelect).toHaveBeenCalledWith('builtin-agent-pm');
  });

  it('selected=true 时卡片边框高亮', () => {
    const { container } = render(<ResourceCard item={baseItem()} selected={true} onSelect={() => {}} />);
    expect(container.firstChild).toHaveClass('border-accent-blue');
  });
});
