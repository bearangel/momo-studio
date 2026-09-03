// renderer/src/routes/MainShell.tsx
//
// v2.0 P2 Task 2：外层接管整窗布局——TitleBar 顶部（拖拽 + workspace tabs +
// 窗口控件），MainLayout 填充剩余空间。ConflictDialogMount 自 MainLayout 上移到
// 这里（全局挂载点，避免 MainLayout 内重复订阅 im:conflict）。
import { MainLayout } from '../components/layout/MainLayout';
import { TitleBar } from '../components/layout/TitleBar';
import { ConflictDialogMount } from '../components/im/ConflictDialogMount';

export function MainShell() {
  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-canvas">
      <TitleBar />
      <MainLayout />
      <ConflictDialogMount />
    </div>
  );
}
