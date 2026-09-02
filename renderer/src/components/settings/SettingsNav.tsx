// renderer/src/components/settings/SettingsNav.tsx
// 设置左侧分类导航：宽度 190px（inline style 规避 Tailwind 任意值 class 失效问题）。
// v2.1：图标 lucide 化（emoji 禁用），新增「外观」分类。
import type { LucideIcon } from 'lucide-react';
import { Building2, Target, MessageSquare, SunMoon, GitBranch, ScrollText, Globe, Info } from 'lucide-react';
import { useSettingsStore, type SettingsCategory } from '../../stores/settings.store';
import { cn } from '../../lib/cn';

// 注：icon 用 lucide 官方导出的 LucideIcon 类型——图标组件是 ForwardRefExoticComponent，
// 手写 ComponentType<...> 结构注解在 strict 下因 propTypes 协变不兼容无法通过 tsc。
const CATEGORIES: { key: SettingsCategory; label: string; icon: LucideIcon }[] = [
  { key: 'model_provider', label: '模型服务', icon: Building2 },
  { key: 'default_model', label: '默认模型', icon: Target },
  { key: 'conversation', label: '会话设置', icon: MessageSquare },
  { key: 'appearance', label: '外观', icon: SunMoon },
  { key: 'git_policy', label: 'Git 策略', icon: GitBranch },
  { key: 'audit_log', label: '审计日志', icon: ScrollText },
  { key: 'p2p', label: '节点互联', icon: Globe },
  { key: 'about', label: '关于', icon: Info },
];

export function SettingsNav() {
  const active = useSettingsStore((s) => s.activeCategory);
  const setCategory = useSettingsStore((s) => s.setCategory);
  return (
    <nav
      aria-label="设置分类"
      className="shrink-0 border-r border-subtle bg-surface-1 p-2 flex flex-col gap-1"
      style={{ width: 190 }}
    >
      <div className="px-2 py-1 text-xs text-tertiary">设置</div>
      {CATEGORIES.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => setCategory(c.key)}
          className={cn(
            'w-full text-left px-3 py-2 text-sm rounded transition-colors flex items-center gap-2',
            active === c.key
              ? 'bg-surface-active text-accent-600 dark:text-accent-300'
              : 'text-secondary hover:bg-surface-3',
          )}
        >
          <c.icon size={16} strokeWidth={1.75} aria-hidden />
          <span>{c.label}</span>
        </button>
      ))}
    </nav>
  );
}
