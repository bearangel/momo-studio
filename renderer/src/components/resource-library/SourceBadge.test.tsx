// renderer/src/components/resource-library/SourceBadge.test.tsx
// SourceBadge 行为：4 种 source（builtin/custom/marketplace/p2p）各显示中文标签 + 对应
// Badge tone（v2.1 P3 裁定：builtin=accent / custom=neutral / marketplace=violet / p2p=success）。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SourceBadge } from './SourceBadge';

describe('SourceBadge', () => {
  it('builtin 显示"系统预置" + accent tone', () => {
    render(<SourceBadge source="builtin" />);
    const badge = screen.getByText('系统预置');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('bg-surface-active');
    expect(badge).toHaveClass('text-accent-600');
  });

  it('custom 显示"我的上传" + neutral tone', () => {
    render(<SourceBadge source="custom" />);
    expect(screen.getByText('我的上传')).toHaveClass('bg-surface-3');
  });

  it('marketplace 显示"网络资源" + violet tone', () => {
    render(<SourceBadge source="marketplace" />);
    expect(screen.getByText('网络资源')).toHaveClass('text-status-violet');
  });

  it('p2p 显示"P2P 共享" + success tone（v2 预留）', () => {
    render(<SourceBadge source="p2p" />);
    expect(screen.getByText('P2P 共享')).toHaveClass('text-status-success');
  });
});
