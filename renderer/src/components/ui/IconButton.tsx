// renderer/src/components/ui/IconButton.tsx
// 图标按钮原子件：aria-label 在类型层面必填（纯图标按钮无可访问名称 = 可访问性缺陷）。
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** 纯图标按钮必须提供可访问名称 */
  'aria-label': string;
  variant?: 'ghost' | 'danger';
  size?: 'sm' | 'md';
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, Props>(
  ({ variant = 'ghost', size = 'md', className, type = 'button', children, ...rest }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          'inline-flex items-center justify-center rounded-md transition-colors',
          size === 'sm' ? 'h-6 w-6' : 'h-7 w-7',
          variant === 'ghost' && 'text-secondary hover:bg-surface-3 hover:text-primary',
          variant === 'danger' && 'text-status-error hover:bg-status-error-tint',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
IconButton.displayName = 'IconButton';
