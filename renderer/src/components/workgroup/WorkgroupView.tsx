// renderer/src/components/workgroup/WorkgroupView.tsx
//
// 工作组视图主区容器（momo-hub M2.1 Task 2）——三态分发骨架：
//   快照未落地（status === null）→ 加载行；未接入（!configured）→ WorkgroupEmptyState
//   （D2 治愈：不依赖工作空间存在）；已接入（configured）→「监控台建设中」占位
//   （Task 3 填充组/节点卡/在跑行，Task 4 接查看态）。
// 挂载即 init()（订阅先于快照，与 HubSettingsPanel 同款）——本视图是未接设备的
// 首个接入入口，不能假设设置面板已拉过快照。
// 快照失败不吞错：status 保持 null + loadError 置位，加载行翻错误行（role=alert）
// +「重试」（走 store.refresh：清 loadError 复用订阅重拉）——不修复则「加载中…」死端。
// 分支键用 configured 而非 state==='online'：enroll 成功即翻占位，不会因
// connecting 短暂回弹空态表单（连接态细节由 Task 3 监控台呈现）。
import { useEffect } from 'react';
import { LayoutDashboard } from 'lucide-react';
import { useHubStore } from '../../stores/hub.store';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { WorkgroupEmptyState } from './WorkgroupEmptyState';

export function WorkgroupView() {
  const status = useHubStore((s) => s.status);
  const loadError = useHubStore((s) => s.loadError);
  const init = useHubStore((s) => s.init);
  const refresh = useHubStore((s) => s.refresh);

  useEffect(() => init(), [init]);

  if (status === null) {
    if (loadError !== null) {
      return (
        <div className="flex flex-1 items-center justify-center bg-canvas">
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-xs text-status-error" role="alert">
              {loadError}
            </p>
            <Button variant="secondary" onClick={refresh}>
              重试
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-1 items-center justify-center bg-canvas">
        <p className="text-sm text-secondary">加载中…</p>
      </div>
    );
  }

  if (!status.configured) {
    return <WorkgroupEmptyState />;
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-canvas">
      <EmptyState
        icon={LayoutDashboard}
        title="监控台建设中"
        description="工作组监控台即将在此提供——组、成员与在跑任务"
        role="status"
      />
    </div>
  );
}
