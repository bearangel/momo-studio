// renderer/src/components/ui/Segmented.tsx
// 分段单选控件（v2.1 设计系统原子件）：主题切换器等三态/二态选择。
import { cn } from '../../lib/cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  'aria-label'?: string;
  className?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  ...rest
}: Props<T>) {
  return (
    <div
      role="radiogroup"
      className={cn(
        'inline-flex rounded-md border border-subtle bg-surface-2 p-0.5',
        className,
      )}
      {...rest}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-7 rounded px-3 text-[13px] font-medium transition-colors',
              active
                ? 'bg-surface-active text-accent-600 dark:text-accent-300'
                : 'text-secondary hover:text-primary',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}