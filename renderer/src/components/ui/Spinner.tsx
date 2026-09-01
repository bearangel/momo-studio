// renderer/src/components/ui/Spinner.tsx
// 装载指示原子件：lucide Loader2 + CSS 旋转，不新造动画系统。
import { Loader2 } from 'lucide-react';

interface Props {
  size?: number;
  /** 提供时作为可访问名称；缺省视为装饰性 */
  label?: string;
}

export function Spinner({ size = 16, label }: Props) {
  return (
    <span role="status" aria-label={label} className="inline-flex items-center text-tertiary">
      <Loader2 size={size} strokeWidth={1.75} className="animate-spin" aria-hidden />
    </span>
  );
}