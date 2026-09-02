// renderer/src/components/settings/SettingsView.tsx
//
// 设置视图（P2 Task 4）：
// - 全屏化：左 SettingsNav 190px + 右内容区，顶部标题栏「← 返回」+「设置」
// - Esc 键全局返回会话视图（仅当 SettingsView 挂载时生效——MiddlePanel
//   的 settings 分支是唯一挂载点，视图切换自动卸载监听）
// - 8 个分类：模型服务 / 默认模型 / 会话设置 / 外观 / Git 策略 / 审计日志 / 节点互联 / 关于
// - workspace 级配置（Git 策略 / 审计日志）仍要求当前激活 workspace；
//   全局配置（模型服务 / 默认模型 / 关于 / 会话设置）的 workspace 守卫留待 P3
import { useEffect } from 'react';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSettingsStore } from '../../stores/settings.store';
import { useUiStore } from '../../stores/ui.store';
import { SettingsNav } from './SettingsNav';
import { GitPolicySettings } from './GitPolicySettings';
import { AuditLog } from './AuditLog';
import { ProviderSettings } from './ProviderSettings';
import { ConversationSettings } from './ConversationSettings';
import { DefaultModelSettings } from './DefaultModelSettings';
import { About } from './About';
import { NodeDiscoveryPanel } from '../p2p/NodeDiscoveryPanel';
import { AppearanceSettings } from './AppearanceSettings';

export function SettingsView() {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const active = useSettingsStore((s) => s.activeCategory);
  const setActiveView = useUiStore((s) => s.setActiveView);

  // Esc 键返回会话视图（与 TitleBar WorkspaceTabs 的「Esc 关闭菜单」语义一致）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setActiveView('im');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setActiveView]);

  if (!workspace) {
    return (
      <div className="flex-1 flex items-center justify-center bg-canvas text-tertiary text-sm">
        请先选择一个 workspace
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶部标题栏：「← 返回」+「设置」标题 */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-subtle bg-surface-1">
        <button
          type="button"
          onClick={() => setActiveView('im')}
          className="text-sm text-secondary hover:bg-surface-3 hover:text-primary px-2 py-1 rounded"
          aria-label="返回"
        >
          ← 返回
        </button>
        <h1 className="text-sm text-primary font-medium">设置</h1>
      </div>

      {/* 主体：左导航 + 右内容 */}
      <div className="flex-1 flex overflow-hidden">
        <SettingsNav />
        <div className="flex-1 overflow-auto p-6 max-w-4xl">
          {active === 'model_provider' && <ProviderSettings />}
          {active === 'default_model' && <DefaultModelSettings />}
          {active === 'conversation' && <ConversationSettings />}
          {active === 'appearance' && <AppearanceSettings />}
          {active === 'git_policy' && <GitPolicySettings workspaceId={workspace.id} />}
          {active === 'audit_log' && <AuditLog workspaceId={workspace.id} />}
          {active === 'p2p' && <NodeDiscoveryPanel />}
          {active === 'about' && <About />}
        </div>
      </div>
    </div>
  );
}