// renderer/src/components/settings/SettingsNav.tsx
//
// 设置左侧分类导航：宽度 190px（inline style 规避 Tailwind 任意值 class 失效问题）。
// 菜单顺序与图标以 settings.html 原型为准：模型服务 / 默认模型 / 会话设置 /
// Git 策略 / 审计日志 / 节点互联 / 关于。CATEGORIES 键值必须与 settings.store
// 的 SettingsCategory 严格同步。
import { useSettingsStore, type SettingsCategory } from '../../stores/settings.store';
import { cn } from '../../lib/cn';

const CATEGORIES: { key: SettingsCategory; label: string; icon: string }[] = [
  { key: 'model_provider', label: '模型服务', icon: '🏢' },
  { key: 'default_model', label: '默认模型', icon: '🎯' },
  { key: 'conversation', label: '会话设置', icon: '💬' },
  { key: 'git_policy', label: 'Git 策略', icon: '🌿' },
  { key: 'audit_log', label: '审计日志', icon: '📜' },
  { key: 'p2p', label: '节点互联', icon: '🌐' },
  { key: 'about', label: '关于', icon: 'ℹ️' },
];

export function SettingsNav() {
  const active = useSettingsStore((s) => s.activeCategory);
  const setCategory = useSettingsStore((s) => s.setCategory);
  return (
    <nav
      aria-label="设置分类"
      className="shrink-0 border-r border-border-subtle bg-bg-secondary p-2 flex flex-col gap-1"
      style={{ width: 190 }}
    >
      <div className="px-2 py-1 text-xs text-neutral-500">设置</div>
      {CATEGORIES.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => setCategory(c.key)}
          className={cn(
            'w-full text-left px-3 py-2 text-sm rounded transition-colors flex items-center gap-2',
            active === c.key
              ? 'bg-bg-tertiary text-neutral-100'
              : 'text-neutral-300 hover:bg-bg-tertiary/60',
          )}
        >
          <span>{c.icon}</span>
          <span>{c.label}</span>
        </button>
      ))}
    </nav>
  );
}