// renderer/src/components/ui/Checkbox.tsx
// 复选框原子件：appearance-none 自绘（peer 机制），选中打勾用 lucide Check。
import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/cn';

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, Props>(
  ({ label, id, className, ...rest }, ref) => {
    const autoId = useId();
    const inputId = id ?? autoId;
    const box = (
      <span className="relative inline-flex">
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          className={cn(
            'peer h-4 w-4 appearance-none rounded border border-strong bg-surface-2 transition-colors checked:border-accent-500 checked:bg-accent-500',
            className,
          )}
          {...rest}
        />
        <Check
          size={12}
          strokeWidth={2.5}
          aria-hidden
          className="pointer-events-none absolute inset-0 m-auto text-inverse opacity-0 peer-checked:opacity-100"
        />
      </span>
    );
    if (!label) return box;
    return (
      <label htmlFor={inputId} className="inline-flex cursor-pointer select-none items-center gap-2 text-[13px] text-primary">
        {box}
        {label}
      </label>
    );
  },
);
Checkbox.displayName = 'Checkbox';