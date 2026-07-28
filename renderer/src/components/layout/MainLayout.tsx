// renderer/src/components/layout/MainLayout.tsx
import { LeftRail } from './LeftRail';
import { MiddlePanel } from './MiddlePanel';
import { RightPanel } from './RightPanel';

export function MainLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-primary">
      <LeftRail />
      <MiddlePanel />
      <RightPanel />
    </div>
  );
}
