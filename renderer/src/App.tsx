// renderer/src/App.tsx
//
// v2.0 P1 Task 11：无登录概念——启动分支由 workspace 判定（SQLite 是唯一状态源）。
//   - 已有 workspace → 直接进入 MainShell
//   - 无 workspace → 首启空态：TitleBar + 内嵌 CreateWorkspaceDialog
//     （P2 Task 3 空态也包 TitleBar——frameless 下保留拖拽/关闭；tabs 只剩 ＋，
//     正好引导创建第一个 workspace）
import { useEffect, useState } from 'react';
import { useWorkspaceStore } from './stores/workspace.store';
import { subscribeSessionChannels } from './stores/session.store';
import { CreateWorkspaceDialog } from './components/workspace/CreateWorkspaceDialog';
import { MainShell } from './routes/MainShell';
import { TitleBar } from './components/layout/TitleBar';

export function App() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const load = useWorkspaceStore((s) => s.load);
  // 首次列表返回前不渲染首启对话框，避免加载期间闪现（store 初始态 workspaces=[]）
  const [bootstrapped, setBootstrapped] = useState(false);

  // 全局会话通道订阅（session:message + session:message_event_batch；
  // Task 12 起全部发送方统一走 session:* 通道，无桥接）。
  // subscribeSessionChannels 内部同时喂 session.store 和 stream.store——同一份 batch
  // 既累积到 session.store.eventsByMessage（重启还原用），又聚合到
  // stream.store.streams（UI 实时渲染用）。
  // 放在 App 顶层保证整个生命周期只订阅一次，避免视图切换重复注册。
  useEffect(() => subscribeSessionChannels(), []);

  useEffect(() => {
    void load().finally(() => setBootstrapped(true));
  }, [load]);

  if (!bootstrapped) return null;

  if (workspaces.length === 0) {
    // 首启空态：TitleBar（拖拽/关闭/＋）+ 内嵌创建表单；创建成功后 store 写入
    // workspace → 分支翻转进 MainShell。onClose 重新拉取列表兜底（仍为空则表单保持）。
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-bg-primary">
        <TitleBar />
        <div className="flex-1 min-h-0 flex items-center justify-center p-6">
          <CreateWorkspaceDialog onClose={() => void load()} embedded />
        </div>
      </div>
    );
  }

  return <MainShell />;
}
