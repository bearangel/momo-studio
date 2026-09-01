// renderer/src/components/ui/Badge.tsx
// 状态徽标原子件：tint 底 + 语义前景，明暗双模式经 CSS 变量自动适配。
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'error' | 'violet';

export const BADGE_TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-3 text-secondary',
  accent: 'bg-surface-active text-accent-600 dark:text-accent-300',
  success: 'bg-status-success-tint text-status-success',
  warning: 'bg-status-warning-tint text-status-warning',
  error: 'bg-status-error-tint text-status-error',
  violet: 'bg-status-violet-tint text-status-violet',
};

interface Props {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', className, children }: Props) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded px-2 text-xs font-medium',
        BADGE_TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
