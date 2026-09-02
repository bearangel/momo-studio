// renderer/src/App.tsx
//
// v2.0 P1 Task 11：无登录概念——启动分支由 workspace 判定（SQLite 是唯一状态源）。
//   - 已有 workspace → 直接进入 MainShell
//   - 无 workspace → 首启空态：TitleBar + 内嵌 CreateWorkspaceDialog
//     （P2 Task 3 空态也包 TitleBar——frameless 下保留拖拽/关闭；tabs 只剩 ＋，
//     正好引导创建第一个 workspace）
//
// P5 Task 2：升级首启提示——bootstrapped 后 invoke getUpgradeNotice，
// 有标记 → 在 MainShell 同屏渲染 UpgradeNotice；首启空态分支不受影响
// （新装用户无标记；仅 MainShell 分支承载升级提示）。
import { useEffect, useState, useCallback } from 'react';
import { useWorkspaceStore } from './stores/workspace.store';
import { subscribeSessionChannels } from './stores/session.store';
import { CreateWorkspaceDialog } from './components/workspace/CreateWorkspaceDialog';
import { MainShell } from './routes/MainShell';
import { TitleBar } from './components/layout/TitleBar';
import { UpgradeNotice } from './components/upgrade/UpgradeNotice';
import { ipc } from './ipc/client';

export function App() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const load = useWorkspaceStore((s) => s.load);
  // 首次列表返回前不渲染首启对话框，避免加载期间闪现（store 初始态 workspaces=[]）
  const [bootstrapped, setBootstrapped] = useState(false);
  // P5 Task 2：v1.x → 2.0 旧库升级标记（导出目录）；null = 无标记
  const [upgradeExportDir, setUpgradeExportDir] = useState<string | null>(null);

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

  // P5 Task 2：bootstrapped 后一次性拉取升级标记——新装用户无标记，
  // 旧库用户则有 exportDir。MainShell 同屏渲染 UpgradeNotice 告知导出位置。
  // 「知道了」→ 调 IPC 清标记（一次性），本地 state 也清。
  useEffect(() => {
    if (!bootstrapped) return;
    void ipc.system
      .getUpgradeNotice()
      .then((n) => {
        if (n) setUpgradeExportDir(n.exportDir);
      })
      .catch(() => {
        // 拉取失败不阻塞启动——首启提示是体验性增强，不是关键路径
      });
  }, [bootstrapped]);

  const dismissUpgrade = useCallback(() => {
    setUpgradeExportDir(null);
    void ipc.system.dismissUpgradeNotice();
  }, []);

  if (!bootstrapped) return null;

  if (workspaces.length === 0) {
    // 首启空态：TitleBar（拖拽/关闭/＋）+ 内嵌创建表单；创建成功后 store 写入
    // workspace → 分支翻转进 MainShell。onClose 重新拉取列表兜底（仍为空则表单保持）。
    // 注：升级提示不在首启空态渲染——新装用户无标记；纯 2.0 新装命中此分支无需告知。
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-bg-primary">
        <TitleBar />
        <div className="flex-1 min-h-0 flex items-center justify-center p-6">
          <CreateWorkspaceDialog onClose={() => void load()} embedded />
        </div>
      </div>
    );
  }

  return (
    <>
      <MainShell />
      {upgradeExportDir && (
        <UpgradeNotice exportDir={upgradeExportDir} onDismiss={dismissUpgrade} />
      )}
    </>
  );
}
