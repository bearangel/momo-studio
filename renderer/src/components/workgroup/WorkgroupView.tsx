// renderer/src/components/workgroup/WorkgroupView.tsx
//
// 工作组视图主区容器（momo-hub M2.1 Task 2 骨架 + Task 3 监控台）——三态分发：
//   快照未落地（status === null）→ 加载行；未接入（!configured）→ WorkgroupEmptyState
//   （D2 治愈：不依赖工作空间存在）；已接入（configured）→ GroupMonitor 编队监控台。
// 本视图是组/委派 store 的生命周期拥有者：configured 挂载期统一 init（订阅 + 拉取），
// 卸载即退订——侧栏（ViewSidebar 渲染的 WorkgroupSidebar）与主区共享同一份数据。
// hub.store 自身仍在此 init（订阅先于快照，与 HubSettingsPanel 同款）——本视图是
// 未接设备的首个接入入口，不能假设设置面板已拉过快照。
// 快照失败不吞错：status 保持 null + loadError 置位，加载行翻错误行（role=alert）
// +「重试」（走 store.refresh：清 loadError 复用订阅重拉）——不修复则「加载中…」死端。
// 分支键用 configured 而非 state==='online'：enroll 成功即翻监控台，不会因
// connecting 短暂回弹空态表单（连接态细节由侧栏/监控台离线注记呈现）。
import { useEffect } from 'react';
import { useHubStore } from '../../stores/hub.store';
import { useHubGroupStore } from '../../stores/hub-group.store';
import { useHubDelegationStore } from '../../stores/hub-delegation.store';
import { Button } from '../ui/Button';
import { WorkgroupEmptyState } from './WorkgroupEmptyState';
import { GroupMonitor } from './GroupMonitor';

export function WorkgroupView() {
  const status = useHubStore((s) => s.status);
  const loadError = useHubStore((s) => s.loadError);
  const init = useHubStore((s) => s.init);
  const refresh = useHubStore((s) => s.refresh);
  const initGroups = useHubGroupStore((s) => s.init);
  const initDelegations = useHubDelegationStore((s) => s.init);

  useEffect(() => init(), [init]);

  // 组/委派 store 只在已接入态挂载（未接入空态无组数据可拉；HubSettingsPanel
  // 的 GroupPanel 仍各自 init——两入口并存到 T5 收敛）
  const configured = status?.configured === true;
  useEffect(() => {
    if (!configured) return;
    const disposeGroups = initGroups();
    const disposeDelegations = initDelegations();
    return () => {
      disposeGroups();
      disposeDelegations();
    };
  }, [configured, initGroups, initDelegations]);

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

  return <GroupMonitor />;
}
