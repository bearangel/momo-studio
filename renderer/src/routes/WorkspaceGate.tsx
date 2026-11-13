// renderer/src/routes/WorkspaceGate.tsx
//
// WorkspaceGate（spec 2026-11-13 T2 §4.2）：跳过引导/历史清空后的 0-ws 必填页。
// 无跳过出口——工作空间是 agent 文件操作的前提（用户裁定 2026-11-13：必须配置）。
// 创建完成 = activeWorkspaceId 翻转 → App 分支自然退回 MainShell（本组件无需
// 自有完成回调；隐藏表单防双入口）。
import { useEffect } from 'react';
import { TitleBar } from '../components/layout/TitleBar';
import { CreateWorkspaceDialog } from '../components/workspace/CreateWorkspaceDialog';
import { useWorkspaceStore } from '../stores/workspace.store';

export function WorkspaceGate(): React.JSX.Element {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  // 防御性重拉：创建落库后若 App 重渲染未及（理论不发生），主动对账一次
  useEffect(() => {
    if (activeWorkspaceId) void useWorkspaceStore.getState().load();
  }, [activeWorkspaceId]);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-canvas">
      <TitleBar wizardMode />
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center p-6">
        <div className="w-[440px] mb-3">
          <h2 className="text-[15px] font-semibold text-primary mb-1">设置工作空间</h2>
          <p className="text-xs text-tertiary">
            agent 的文件操作都发生在这个目录里，创建后即可开始使用
          </p>
        </div>
        {!activeWorkspaceId && (
          <CreateWorkspaceDialog onClose={() => undefined} embedded hideCancel />
        )}
      </div>
    </div>
  );
}
