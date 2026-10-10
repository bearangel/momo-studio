// renderer/src/components/onboarding/WelcomeStep.tsx
//
// 欢迎页（spec 2026-10-10 §8）：两条路线大卡 + 常驻跳过。视觉基线见
// .omo/previews/onboarding-wizard.html 帧①（P1 门禁确认稿）。
import { Sparkles, Settings2 } from 'lucide-react';
import type { WizardRoute } from '../../routes/OnboardingWizard';

interface Props {
  onSelect: (route: WizardRoute) => void;
  onSkip: () => void;
}

export function WelcomeStep({ onSelect, onSkip }: Props) {
  return (
    <div className="w-[440px] text-center">
      <h2 className="text-[17px] font-semibold text-primary">欢迎使用 Momo Studio</h2>
      <p className="text-xs text-tertiary mt-1 mb-5">个人桌面端多 agent 协作平台 · 几分钟完成初始配置</p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => onSelect('ai')}
          className="flex-1 text-left rounded-lg border border-accent-500 bg-surface-active p-4 hover:border-accent-600 transition-colors"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-surface-3 mb-2.5">
            <Sparkles size={16} strokeWidth={1.75} className="text-accent-500" />
          </span>
          <b className="block text-[13px] text-primary">AI 引导</b>
          <span className="block text-[11px] leading-relaxed text-tertiary mt-1">
            描述你的工作需求，AI 帮你挑选预制 agent 并完成配置
          </span>
        </button>
        <button
          type="button"
          onClick={() => onSelect('manual')}
          className="flex-1 text-left rounded-lg border border-border-subtle bg-surface-1 p-4 hover:border-border-strong transition-colors"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-surface-3 mb-2.5">
            <Settings2 size={16} strokeWidth={1.75} className="text-tertiary" />
          </span>
          <b className="block text-[13px] text-primary">手动引导</b>
          <span className="block text-[11px] leading-relaxed text-tertiary mt-1">
            自己挑选预制 agent 或创建自定义 agent，逐步完成配置
          </span>
        </button>
      </div>
      <button
        type="button"
        onClick={onSkip}
        className="mt-5 text-xs text-tertiary underline underline-offset-2 hover:text-secondary"
      >
        跳过引导
      </button>
    </div>
  );
}
