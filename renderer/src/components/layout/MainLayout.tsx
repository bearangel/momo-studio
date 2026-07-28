// renderer/src/components/layout/MainLayout.tsx
// 顶层布局：左导航栏 + 中间面板。
// M1 起 MiddlePanel 在 files 视图内自包含编辑器，不再需要独立的 RightPanel。
import { LeftRail } from './LeftRail';
import { MiddlePanel } from './MiddlePanel';

export function MainLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-primary">
      <LeftRail />
      <MiddlePanel />
    </div>
  );
}
