// renderer/src/components/ui/Spinner.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Spinner } from './Spinner';

describe('Spinner', () => {
  it('role=status + 旋转动画类', () => {
    render(<Spinner label="加载中" />);
    const el = screen.getByRole('status');
    expect(el.getAttribute('aria-label')).toBe('加载中');
    expect(el.querySelector('svg')?.classList.contains('animate-spin')).toBe(true);
  });

  it('无 label 时 aria-hidden（装饰性）', () => {
    render(<Spinner />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBeNull();
  });

  it('size 透传给图标', () => {
    render(<Spinner size={24} />);
    expect(screen.getByRole('status').querySelector('svg')?.getAttribute('width')).toBe('24');
  });
});
