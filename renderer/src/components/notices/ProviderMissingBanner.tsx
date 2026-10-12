// renderer/src/components/notices/ProviderMissingBanner.tsx
//
// D1b（预览 S2）：主界面「未配置模型服务」warning 横幅，挂在 MainShell 的
// TitleBar 与 MainLayout 之间。显示条件：providers.length === 0——向导打开时
// App 分支渲染 OnboardingWizard 而非 MainShell，故「向导未开」由挂载位置天然
// 保证，无需额外标志。「关闭」为会话级（组件常驻 MainShell 不卸载，useState
// 即可；重启后横幅可再现，配置成功后自然消失）。
import { useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useProviderStore } from '../../stores/provider.store';
import { openProviderSettings } from '../../lib/open-provider-settings';
import { Button } from '../ui/Button';

export function ProviderMissingBanner() {
  const providers = useProviderStore((s) => s.providers);
  const loadProviders = useProviderStore((s) => s.loadProviders);
  const [dismissed, setDismissed] = useState(false);
  // 首拉完成前不显示（避免加载间隙闪现）；拉取失败 providers 保持 [] ——横幅
  // 仍给出设置入口，属于可接受的保守降级
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    // 拉取失败吞掉（providers 保持 []，横幅照常给出路）——不让 rejection 漂浮
    void loadProviders()
      .catch(() => undefined)
      .finally(() => setChecked(true));
  }, [loadProviders]);

  if (!checked || dismissed || providers.length > 0) return null;

  return (
    <div
      data-testid="provider-missing-banner"
      role="alert"
      className="mx-3 mt-2 flex items-center gap-2.5 rounded-lg bg-status-warning-tint px-3.5 py-2 text-sm text-status-warning"
    >
      <TriangleAlert size={16} strokeWidth={1.75} className="shrink-0" aria-hidden />
      <span className="flex-1 min-w-0">
        尚未配置模型服务——智能体需要模型供应商才能运行。可到 设置 → 模型服务 添加。
      </span>
      <Button size="sm" onClick={openProviderSettings}>
        去配置
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
        关闭
      </Button>
    </div>
  );
}
