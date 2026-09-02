// renderer/src/components/ui/Segmented.tsx
// 分段单选控件（v2.1 设计系统原子件）：主题切换器等三态/二态选择。
// v2.1 P1：补 WAI-ARIA radiogroup 键盘语义——方向键漫游 + roving tabindex。
import { useRef } from 'react';
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
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  /** 方向键漫游：焦点与选中同步移到相邻（循环）选项 */
  const moveFocus = (dir: 1 | -1): void => {
    const idx = options.findIndex((o) => o.value === value);
    const next = (idx + dir + options.length) % options.length;
    const nextOpt = options[next];
    if (!nextOpt) return;
    refs.current[next]?.focus();
    onChange(nextOpt.value);
  };

  return (
    <div
      role="radiogroup"
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
          e.preventDefault();
          moveFocus(1);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
          e.preventDefault();
          moveFocus(-1);
        }
      }}
      className={cn(
        'inline-flex rounded-md border border-subtle bg-surface-2 p-0.5',
        className,
      )}
      {...rest}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
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