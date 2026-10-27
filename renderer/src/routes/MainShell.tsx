// renderer/src/routes/MainShell.tsx
//
// v2.0 P2 Task 2：外层接管整窗布局——TitleBar 顶部（拖拽 + workspace tabs +
// 窗口控件），MainLayout 填充剩余空间。ConflictDialogMount 自 MainLayout 上移到
// 这里（全局挂载点，避免 MainLayout 内重复订阅 im:conflict）。
// D1b：TitleBar 与 MainLayout 之间挂 ProviderMissingBanner（未配置模型服务时
// 的会话级提醒；向导打开时 App 分支不渲染 MainShell，条件由挂载位置保证）。
// M2.2 P2-7：HubInstallNotice 右下角补装进度条（hub:installProgress 推送，
// worker 侧镜像补装大包可见）。
import { MainLayout } from '../components/layout/MainLayout';
import { TitleBar } from '../components/layout/TitleBar';
import { ConflictDialogMount } from '../components/im/ConflictDialogMount';
import { ProviderMissingBanner } from '../components/notices/ProviderMissingBanner';
import { HubInstallNotice } from '../components/hub/HubInstallNotice';

export function MainShell() {
  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-canvas">
      <TitleBar />
      <ProviderMissingBanner />
      <MainLayout />
      <ConflictDialogMount />
      <HubInstallNotice />
    </div>
  );
}
