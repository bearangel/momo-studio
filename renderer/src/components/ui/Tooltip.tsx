// renderer/src/components/ui/Tooltip.tsx
// 轻量悬浮提示：CSS group 机制实现（无定位库依赖），hover 与键盘 focus 均可触发。
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface Props {
  content: string;
  side?: 'top' | 'bottom';
  children: ReactNode;
}

export function Tooltip({ content, side = 'top', children }: Props) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded px-2 py-1 text-xs',
          'border border-subtle bg-surface-3 text-primary shadow-lg',
          'opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100',
          side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
        )}
      >
        {content}
      </span>
    </span>
  );
}
