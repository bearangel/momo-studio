// renderer/src/components/ui/Switch.tsx
// 原子开关（P1 预览 2026-10-21 确认 pill 形态）：语义 token 配色、role=switch
// 键盘可达（Space/Enter 原生 button 行为）。只做视觉与交互，不含业务语义。
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onChange: (next: boolean) => void;
}

export function Switch({ checked, onChange, disabled, className, ...rest }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cn(
        'relative w-[34px] h-[19px] rounded-full transition-colors shrink-0',
        checked ? 'bg-accent-500' : 'bg-border-strong',
        disabled && 'opacity-40 cursor-not-allowed',
        className,
      )}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange(!checked);
      }}
      {...rest}
    >
      <span
        aria-hidden
        className={cn(
          'absolute top-[2px] w-[15px] h-[15px] rounded-full bg-white transition-all',
          checked ? 'right-[2px]' : 'left-[2px]',
        )}
      />
    </button>
  );
}
