// renderer/src/components/settings/SettingsView.tsx
//
// 设置视图：左导航（分类）+ 右内容。分类由 settings.store 管理。
// workspace 级配置（Git Policy / 审计日志）仍挂在当前激活 workspace 下。
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSettingsStore } from '../../stores/settings.store';
import { SettingsNav } from './SettingsNav';
import { GitPolicySettings } from './GitPolicySettings';
import { AuditLog } from './AuditLog';
import { ProviderSettings } from './ProviderSettings';

export function SettingsView() {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const active = useSettingsStore((s) => s.activeCategory);

  if (!workspace) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">
        请先选择一个 workspace
      </div>
    );
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      <SettingsNav />
      <div className="flex-1 overflow-auto p-6 max-w-4xl">
        {active === 'model_provider' && <ProviderSettings />}
        {active === 'git_policy' && <GitPolicySettings workspaceId={workspace.id} />}
        {active === 'audit_log' && <AuditLog workspaceId={workspace.id} />}
      </div>
    </div>
  );
}
