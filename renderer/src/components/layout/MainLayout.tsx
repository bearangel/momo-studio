// renderer/src/components/layout/MainLayout.tsx
// 顶层布局：左导航栏 + 中间面板。
// 负责在认证后启动 Matrix /sync（主进程）并注册实时消息推送监听。
import { useEffect } from 'react';
import { LeftRail } from './LeftRail';
import { MiddlePanel } from './MiddlePanel';
import { ipc } from '../../ipc/client';
import { useImStore } from '../../stores/im.store';
import { useAgentStore } from '../../stores/agent.store';
import { useUiStore } from '../../stores/ui.store';

export function MainLayout() {
  const loadRooms = useImStore((s) => s.loadRooms);
  const receiveMessage = useImStore((s) => s.receiveMessage);
  const syncRunningStates = useAgentStore((s) => s.syncRunningStates);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await ipc.im.startSync();
        if (!cancelled) await loadRooms();
      } catch {
        // sync 失败非致命：UI 仍可用，用户切换到 IM 视图时可手动重试
      }
    })();

    // 注册主进程消息推送监听，实时消息写入 store
    const cleanup = ipc.im.onMessage((msg) => {
      receiveMessage(msg);
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [loadRooms, receiveMessage]);

  // 主进程在 agent 运行态变化（自动恢复完成/启停）时通知，重新同步 running，
  // 修复首次启动时 @ 候选为空（renderer 首次同步早于 autoStartAgents 完成）
  useEffect(() => {
    const cleanup = ipc.agent.onRuntimeChanged(() => {
      void syncRunningStates();
    });
    return cleanup;
  }, [syncRunningStates]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-primary">
      <LeftRail />
      {/* v1.5.7: 侧边栏收起时显示展开按钮 */}
      {sidebarCollapsed && (
        <button
          type="button"
          onClick={toggleSidebar}
          title="展开侧边栏"
          className="shrink-0 w-8 bg-bg-secondary border-r border-border-subtle flex items-center justify-center text-neutral-400 hover:bg-bg-tertiary transition-colors"
        >
          ▶
        </button>
      )}
      <MiddlePanel />
    </div>
  );
}
