// renderer/src/components/layout/MainLayout.tsx
// 顶层布局：左导航栏 + 中间面板。
// v2.0 P1 Task 9：会话内核纯 SQLite 无 /sync 启动步骤，这里只触发首屏拉取；
// 实时消息订阅在 App.tsx 的 subscribeSessionChannels。
// v2.0 P2 Task 2：整窗布局（h-screen w-screen + TitleBar + ConflictDialogMount）
// 上移到 MainShell，这里改为 flex-1 min-h-0 填充剩余空间。
import { useEffect } from 'react';
import { LeftRail } from './LeftRail';
import { MiddlePanel } from './MiddlePanel';
import { ipc } from '../../ipc/client';
import { useSessionStore } from '../../stores/session.store';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';

export function MainLayout() {
  const loadSessions = useSessionStore((s) => s.loadSessions);
  const loadAssignments = useAgentStore((s) => s.loadAssignments);

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

  // 主进程在 agent 运行态变化（自动恢复完成/启停）时通知，重新加载 assignments，
  // 让 assignment.lastRunning 反映最新状态
  useEffect(() => {
    const cleanup = ipc.agent.onRuntimeChanged(() => {
      const ws = useWorkspaceStore.getState().getActive();
      if (ws) void loadAssignments(ws.id);
    });
    return cleanup;
  }, [loadAssignments]);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden bg-bg-primary">
      <LeftRail />
      <MiddlePanel />
    </div>
  );
}
