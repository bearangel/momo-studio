// renderer/src/components/settings/AppearanceSettings.tsx
// 外观设置：主题模式三选一（浅色/深色/跟随系统）——v2.1 设计系统主题切换入口。
import { useThemeStore, type ThemeMode } from '../../stores/theme.store';
import { Segmented, type SegmentedOption } from '../ui/Segmented';

const MODE_OPTIONS = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
] as const satisfies readonly SegmentedOption<ThemeMode>[];

export function AppearanceSettings() {
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  return (
    <section aria-label="外观设置" className="flex flex-col gap-4">
      <h2 className="text-base font-semibold">外观</h2>
      <div className="flex items-center gap-4">
        <span className="text-sm text-secondary">主题模式</span>
        <Segmented options={MODE_OPTIONS} value={mode} onChange={setMode} aria-label="主题模式" />
      </div>
      <p className="text-xs text-tertiary">
        跟随系统时自动匹配操作系统外观，切换即时生效并记忆您的选择。
      </p>
    </section>
  );
}
