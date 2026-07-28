// renderer/src/components/settings/SettingsView.tsx
//
// 设置视图容器 —— 渲染当前 workspace 的 Git Policy 配置区块。
// 两个区块都是 workspace 级配置，故挂在当前激活 workspace 下。
// 无选中 workspace 时上层 MiddlePanel 已提前拦截，这里不再重复处理空态。
import { useWorkspaceStore } from '../../stores/workspace.store';
import { GitPolicySettings } from './GitPolicySettings';

export function SettingsView() {
  const workspace = useWorkspaceStore((s) => s.getActive());

  if (!workspace) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">
        请先选择一个 workspace
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6 flex flex-col gap-8 max-w-4xl">
      <GitPolicySettings workspaceId={workspace.id} />
    </div>
  );
}
