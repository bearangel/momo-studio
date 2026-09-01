// renderer/src/components/ui/Badge.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from './Badge';

describe('Badge', () => {
  it('默认 neutral tone', () => {
    render(<Badge>草稿</Badge>);
    expect(screen.getByText('草稿').className).toContain('bg-surface-3');
  });

  it.each([
    ['success', 'bg-status-success-tint', 'text-status-success'],
    ['warning', 'bg-status-warning-tint', 'text-status-warning'],
    ['error', 'bg-status-error-tint', 'text-status-error'],
    ['violet', 'bg-status-violet-tint', 'text-status-violet'],
    ['accent', 'bg-surface-active', 'text-accent-600'],
  ] as const)('tone=%s 映射 tint 底 + 语义前景', (tone, bg, fg) => {
    render(<Badge tone={tone}>X</Badge>);
    const cls = screen.getByText('X').className;
    expect(cls).toContain(bg);
    expect(cls).toContain(fg);
  });
});
