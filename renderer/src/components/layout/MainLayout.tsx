// renderer/src/components/layout/MainLayout.tsx
// 顶层布局：活动栏 + 统一侧边栏 + 中间面板。
// v2.0 P1 Task 9：会话内核纯 SQLite 无 /sync 启动步骤，这里只触发首屏拉取；
// 实时消息订阅在 App.tsx 的 subscribeSessionChannels。
// v2.0 P2 Task 2：整窗布局（h-screen w-screen + TitleBar + ConflictDialogMount）
// 上移到 MainShell，这里改为 flex-1 min-h-0 填充剩余空间。
// v2.0 P2 Task 3：LeftRail → ActivityBar + ViewSidebar；全局 Ctrl/Cmd+B 折叠侧边栏。
import { useEffect } from 'react';
import { ActivityBar } from './ActivityBar';
import { ViewSidebar } from './ViewSidebar';
import { MiddlePanel } from './MiddlePanel';
import { ipc } from '../../ipc/client';
import { useUiStore } from '../../stores/ui.store';
import { useSessionStore } from '../../stores/session.store';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';

export function MainLayout() {
  const loadSessions = useSessionStore((s) => s.loadSessions);
  const loadMembers = useAgentStore((s) => s.loadMembers);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!cancelled) await loadSessions();
      } catch {
        // 首屏拉取失败非致命：UI 仍可用，用户切换到会话视图时可手动重试
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadSessions]);

  // 冷启动主动加载 assignments：RoomList 新建房间的邀请候选消费它——
  // 此前仅在 onRuntimeChanged 推送时加载，重启后直接新建房间会看到空邀请列表，
  // 切到 Agent 视图（WorkspaceAgentsPanel 挂载加载）再切回才恢复
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  useEffect(() => {
    if (activeWorkspaceId) void loadMembers(activeWorkspaceId);
  }, [activeWorkspaceId, loadMembers]);

  // 主进程在 agent 运行态变化（自动恢复完成/启停）时通知，重新加载 assignments，
  // 让 assignment.lastRunning 反映最新状态
  useEffect(() => {
    const cleanup = ipc.agent.onRuntimeChanged(() => {
      const ws = useWorkspaceStore.getState().getActive();
      if (ws) void loadMembers(ws.id);
    });
    return cleanup;
  }, [loadMembers]);

  // 全局 Ctrl/Cmd+B 折叠/展开侧边栏（preventDefault 阻止浏览器默认行为）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        useUiStore.getState().toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden bg-bg-primary">
      <ActivityBar />
      <ViewSidebar />
      <MiddlePanel />
    </div>
  );
}
