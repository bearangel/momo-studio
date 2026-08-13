// renderer/src/components/layout/MainLayout.tsx
// 顶层布局：左导航栏 + 中间面板。
// 负责在认证后启动 Matrix /sync（主进程）。
// v2.0 A 子系统：实时消息订阅已上移到 App.tsx 的 subscribeImChannels，这里只触发首屏拉取。
import { useEffect } from 'react';
import { LeftRail } from './LeftRail';
import { MiddlePanel } from './MiddlePanel';
import { ipc } from '../../ipc/client';
import { useImStore } from '../../stores/im.store';
import { useAgentStore } from '../../stores/agent.store';

export function MainLayout() {
  const loadRooms = useImStore((s) => s.loadRooms);
  const syncRunningStates = useAgentStore((s) => s.syncRunningStates);

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

    return () => {
      cancelled = true;
    };
  }, [loadRooms]);

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
      <MiddlePanel />
    </div>
  );
}
