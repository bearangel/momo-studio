// renderer/src/components/ui/Button.tsx
// v2.1 设计系统原子件：四变体全部走语义 token。
// v2.2 bug 修复：基础类补 inline-flex items-center justify-center gap-1——此前
// 图标+文本混排走 svg 基线对齐且无间距（会话「停止」/记忆「导出/导入/新增」等
// 错位）；多个调用点曾各自补 className 打补丁，现收敛到原子件单点保证。
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
}

const VARIANT_CLASSES: Record<NonNullable<Props['variant']>, string> = {
  primary: 'bg-accent-500 text-inverse hover:bg-accent-500/90',
  secondary:
    'border border-accent-500 text-accent-600 dark:text-accent-300 hover:bg-surface-active',
  ghost: 'text-secondary hover:bg-surface-3 hover:text-primary',
  danger: 'bg-status-error text-inverse hover:bg-status-error/90',
};

export const Button = forwardRef<HTMLButtonElement, Props>(
  ({ variant = 'primary', size = 'md', className, type = 'button', ...rest }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          'inline-flex items-center justify-center gap-1 rounded-md font-medium transition-colors',
          size === 'sm' && 'h-7 px-3 text-[13px]',
          size === 'md' && 'px-4 py-2 text-[13px]',
          size === 'lg' && 'px-6 py-3 text-base',
          VARIANT_CLASSES[variant],
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...rest}
      />
    );
  },
);
Button.displayName = 'Button';
