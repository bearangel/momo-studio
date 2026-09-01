// renderer/src/components/ui/EmptyState.tsx
// 空状态原子件：图标 + 标题 + 描述 + 可选动作。
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

interface Props {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: Props) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <Icon size={24} strokeWidth={1.5} aria-hidden className="text-disabled" />
      <h3 className="text-sm font-medium text-secondary">{title}</h3>
      {description ? (
        <div className="max-w-[280px] text-xs text-tertiary">{description}</div>
      ) : null}
      {action}
    </div>
  );
}
