// renderer/src/components/ui/Input.tsx
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
          <label htmlFor={inputId} className="text-sm text-neutral-300">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            'px-3 py-2 rounded-md bg-bg-tertiary border border-border-subtle text-neutral-100',
            'focus:border-accent-blue focus:outline-none',
            className,
          )}
          {...rest}
        />
      </div>
    );
  },
);
Input.displayName = 'Input';