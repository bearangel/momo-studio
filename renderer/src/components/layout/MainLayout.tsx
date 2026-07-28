// renderer/src/components/layout/MainLayout.tsx
// 顶层布局：左导航栏 + 中间面板。
// 负责在认证后启动 Matrix /sync（主进程）并注册实时消息推送监听。
import { useEffect } from 'react';
import { LeftRail } from './LeftRail';
import { MiddlePanel } from './MiddlePanel';
import { ipc } from '../../ipc/client';
import { useImStore } from '../../stores/im.store';

export function MainLayout() {
  const loadRooms = useImStore((s) => s.loadRooms);
  const receiveMessage = useImStore((s) => s.receiveMessage);

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

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-primary">
      <LeftRail />
      <MiddlePanel />
    </div>
  );
}
