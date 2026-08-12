// renderer/src/components/resource-library/SourceBadge.test.tsx
// SourceBadge 行为：4 种 source（builtin/custom/marketplace/p2p）各显示中文标签 + 对应主题色。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SourceBadge } from './SourceBadge';

describe('SourceBadge', () => {
  it('builtin 显示"系统预置" + 蓝色', () => {
    render(<SourceBadge source="builtin" />);
    const badge = screen.getByText('系统预置');
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain('bg-accent-blue');
  });

  it('custom 显示"我的上传" + 紫色', () => {
    render(<SourceBadge source="custom" />);
    expect(screen.getByText('我的上传').className).toContain('text-purple');
  });

  it('marketplace 显示"网络资源" + 琥珀色', () => {
    render(<SourceBadge source="marketplace" />);
    expect(screen.getByText('网络资源').className).toContain('text-amber');
  });

  it('p2p 显示"P2P 共享" + 粉色（v2 预留）', () => {
    render(<SourceBadge source="p2p" />);
    expect(screen.getByText('P2P 共享').className).toContain('text-pink');
  });
});
