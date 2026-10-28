// renderer/src/components/settings/SettingsView.tsx
//
// 设置视图（P2 Task 4）：
// - 全屏化：左 SettingsNav 190px + 右内容区，顶部标题栏「← 返回」+「设置」
// - Esc 键全局返回会话视图（仅当 SettingsView 挂载时生效——MiddlePanel
//   的 settings 分支是唯一挂载点，视图切换自动卸载监听）
// - 12 个分类：模型服务 / 默认模型 / 会话设置 / 插件 / 记忆 / 外观 / 安全沙箱 / 浏览器 / 节点互联 / Git 策略 / 审计日志 / 关于
//   （「节点互联」随 p2p 下架摘除后，momo-hub M0 2026-10-23 以 hub 语境回归）
// - M2.2 P2-8：0-ws 态整页可达（全局分类直接可用）；workspace 级分类
//   （记忆 / 浏览器 / Git 策略 / 审计日志）在 0-ws 态渲染占位提示
import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { FolderPlus } from 'lucide-react';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSettingsStore } from '../../stores/settings.store';
import { useUiStore } from '../../stores/ui.store';
import { SettingsNav } from './SettingsNav';
import { GitPolicySettings } from './GitPolicySettings';
import { AuditLog } from './AuditLog';
import { ProviderSettings } from './ProviderSettings';
import { ConversationSettings } from './ConversationSettings';
import { MemorySettings } from './MemorySettings';
import { DefaultModelSettings } from './DefaultModelSettings';
import { About } from './About';
import { PluginSettings } from './PluginSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { SandboxSettingsPanel } from './SandboxSettingsPanel';
import { BrowserSettings } from './BrowserSettings';
import { HubSettingsPanel } from './HubSettingsPanel';
import { Button } from '../ui/Button';

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

  /**
   * workspace 级分类的 0-ws 占位（P2-8：整页可达，ws 级分类不渲染假数据）。
   * M2.3 P2-4：「去创建工作空间」跳 im 视图——0-ws 态 MiddlePanel 主区即创建
   * 引导（EmptyState + 内嵌 CreateWorkspaceDialog），最小面复用既有引导动线。
   */
  const wsRequired = (): ReactElement => (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm text-tertiary">
      该分类需要先选择一个工作空间
      <Button variant="secondary" size="sm" onClick={() => setActiveView('im')}>
        <FolderPlus size={14} strokeWidth={1.75} aria-hidden />
        去创建工作空间
      </Button>
    </div>
  );

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
          {active === 'memory' &&
            (workspace ? <MemorySettings workspaceId={workspace.id} /> : wsRequired())}
          {active === 'appearance' && <AppearanceSettings />}
          {active === 'sandbox' && <SandboxSettingsPanel />}
          {active === 'browser' &&
            (workspace ? <BrowserSettings workspaceId={workspace.id} /> : wsRequired())}
          {active === 'hub' && <HubSettingsPanel />}
          {active === 'git_policy' &&
            (workspace ? <GitPolicySettings workspaceId={workspace.id} /> : wsRequired())}
          {active === 'audit_log' &&
            (workspace ? <AuditLog workspaceId={workspace.id} /> : wsRequired())}
          {active === 'plugins' && <PluginSettings />}
          {active === 'about' && <About />}
        </div>
      </div>
    </div>
  );
}
