// renderer/src/components/ui/Select.tsx
// 下拉选择原子件：原生 select 美化（appearance-none + 自绘 ChevronDown）。
// 暗黑模式原生弹层颜色由 globals.css 的 color-scheme 声明接管。
import { forwardRef, useId, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/cn';

interface Props extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
}

export const Select = forwardRef<HTMLSelectElement, Props>(
  ({ label, id, className, children, ...rest }, ref) => {
    const autoId = useId();
    const inputId = id ?? autoId;
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={inputId} className="text-sm text-secondary">
            {label}
          </label>
        )}
        <div className="relative">
          <select
            ref={ref}
            id={inputId}
            className={cn(
              'w-full appearance-none rounded-md border border-subtle bg-surface-2 py-2 pl-3 pr-8 text-[13px] text-primary',
              'focus:border-focus focus:outline-none',
              className,
            )}
            {...rest}
          >
            {children}
          </select>
          <ChevronDown
            size={14}
            strokeWidth={1.75}
            aria-hidden
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-tertiary"
          />
        </div>
      </div>
    );
  },
);
Select.displayName = 'Select';
