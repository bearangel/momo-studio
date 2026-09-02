// renderer/src/components/ui/Avatar.tsx
// 头像原子件：名称首字母 + 稳定色相派生（同名同色）；bot 变体渲染 Bot 图标。
// 色相用 hsl 模板字符串生成（动态值，非硬编码 hex——lint 白名单语义见 design-system.md）。
import { Bot } from 'lucide-react';

const SIZE_PX = { sm: 20, md: 28 } as const;

/** 名称 → 稳定色相（0-359）：同名恒定，异名尽量分散 */
function nameHue(name: string): number {
  let h = 0;
  for (const ch of name) {
    h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  }
  return h;
}

interface Props {
  name: string;
  /** agent 成员用 Bot 图标变体 */
  bot?: boolean;
  size?: 'sm' | 'md';
}

export function Avatar({ name, bot = false, size = 'md' }: Props) {
  const px = SIZE_PX[size];
  if (bot) {
    return (
      <span
        title={name}
        aria-hidden
        className="inline-flex items-center justify-center rounded-full bg-surface-active text-accent-600 dark:text-accent-300"
        style={{ width: px, height: px }}
      >
        <Bot size={Math.round(px * 0.6)} strokeWidth={1.75} />
      </span>
    );
  }
  return (
    <span
      title={name}
      aria-hidden
      className="inline-flex items-center justify-center rounded-full font-medium text-inverse"
      style={{
        width: px,
        height: px,
        fontSize: Math.round(px * 0.4),
        backgroundColor: `hsl(${nameHue(name)} 42% 46%)`,
      }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
