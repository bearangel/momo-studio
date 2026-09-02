// renderer/src/components/ui/Input.tsx
// v2.1 设计系统原子件：样式全 token 化。
import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export const Input = forwardRef<HTMLInputElement, Props>(
  ({ label, className, id, ...rest }, ref) => {
    const autoId = useId();
    const inputId = id ?? autoId;
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={inputId} className="text-sm text-secondary">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            'rounded-md border border-subtle bg-surface-2 px-3 py-2 text-[13px] text-primary',
            'placeholder:text-disabled',
            'focus:border-focus focus:outline-none',
            className,
          )}
          {...rest}
        />
      </div>
    );
  },
);
Input.displayName = 'Input';
