// renderer/src/components/workgroup/WorkgroupView.tsx
//
// 工作组视图主区容器（momo-hub M2.1 Task 2 骨架 + Task 3 监控台 + Task 4 查看态）
// ——状态分发：
//   快照未落地（status === null）→ 加载行；未接入（!configured）→ WorkgroupEmptyState
//   （D2 治愈：不依赖工作空间存在）；已接入（configured）→ GroupMonitor 编队监控台；
//   查看态（hub-view store open 且非 picking）→ 主区整体替换为 RemoteViewPane
//   （S4 全宽四页签），ViewPickerDialog（S3b）在 picking 前置步弹窗在场——
//   退出查看（store.close）即回监控态。
// 本视图是组/委派 store 的生命周期拥有者：在线挂载期统一 init（订阅 + 拉取），
// 卸载即退订——侧栏（ViewSidebar 渲染的 WorkgroupSidebar）与主区共享同一份数据。
// hub.store 自身仍在此 init（订阅先于快照，与 HubSettingsPanel 同款）——本视图是
// 未接设备的首个接入入口，不能假设设置面板已拉过快照。
// 组/委派 init 门控用 online 而非 configured（对齐 GroupPanel 语义）：离线拉取
// 只会把连接错误落进 store.error 呈现红行噪音；configured&&!online 仍渲染空态，
// online 翻转重挂订阅（重连后自恢复拉取）。
// 快照失败不吞错：status 保持 null + loadError 置位，加载行翻错误行（role=alert）
// +「重试」（走 store.refresh：清 loadError 复用订阅重拉）——不修复则「加载中…」死端。
// 渲染分支键用 configured 而非 state==='online'：enroll 成功即翻监控台，不会因
// connecting 短暂回弹空态表单（连接态细节由侧栏/监控台离线注记呈现）。
import { useCallback, useEffect } from 'react';
import { useHubStore } from '../../stores/hub.store';
import { useHubGroupStore, effectiveSelectedGroup } from '../../stores/hub-group.store';
import { useHubDelegationStore } from '../../stores/hub-delegation.store';
import { useHubViewStore } from '../../stores/hub-view.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { hubSupportsMinor } from '../../lib/hub-capability';
import { Button } from '../ui/Button';
import { WorkgroupEmptyState } from './WorkgroupEmptyState';
import { GroupMonitor } from './GroupMonitor';
import { RemoteViewPane } from './RemoteViewPane';
import { ViewPickerDialog } from './ViewPickerDialog';

export function WorkgroupView() {
  const status = useHubStore((s) => s.status);
  const loadError = useHubStore((s) => s.loadError);
  const init = useHubStore((s) => s.init);
  const refresh = useHubStore((s) => s.refresh);
  const initGroups = useHubGroupStore((s) => s.init);
  const initDelegations = useHubDelegationStore((s) => s.init);
  const viewOpen = useHubViewStore((s) => s.open);
  const viewPicking = useHubViewStore((s) => s.picking);
  const openViewPanel = useHubViewStore((s) => s.openPanel);

  useEffect(() => init(), [init]);

  // 组/委派 store 只在在线态订阅 + 拉取（对齐 GroupPanel：离线拉取只产生
  // store.error 红行噪音；configured&&!online 仍渲染空态，重连后自恢复）。
  // HubSettingsPanel 的 GroupPanel 仍各自 init——两入口并存到 T5 收敛
  const online = status?.state === 'online';
  useEffect(() => {
    if (!online) return;
    const disposeGroups = initGroups();
    const disposeDelegations = initDelegations();
    return () => {
      disposeGroups();
      disposeDelegations();
    };
  }, [online, initGroups, initDelegations]);

  // T4 查看链路入口：NodeCard「查看」→ S3b 选择器（store picking 前置步）。
  // M3.2（协议 1.4.0）数据源切换：hub 支持 minor 4 时走远端空间清单
  // （viewWorkspaces 带当前选中组 groupId——openRemotePick 前置步内拉取）；
  // 旧 hub（<1.4 / 未协商出版本）回落本机清单（M2 迁移语义——本机清单是
  // 「对方已镜像我这边空间」的代理视图）。工作组视图上下文里 workspace store
  // 可能尚未加载（首进视图未过工作空间页），空清单先补拉再 openPanel——否则
  // ≤1 自动选中判定拿空数组误报「本机无工作空间」
  const handleOpenView = useCallback(
    (nodeId: string, nodeName: string): void => {
      const hubProtoVer = useHubStore.getState().status?.hubProtoVer ?? null;
      const groupState = useHubGroupStore.getState();
      const groupId = effectiveSelectedGroup(groupState.groups, groupState.selectedGroupId)?.groupId ?? null;
      if (hubSupportsMinor(hubProtoVer, 4)) {
        useHubViewStore.getState().openRemotePick({ targetNodeId: nodeId, targetName: nodeName, groupId });
        return;
      }
      const toEntries = (): Array<{ id: string; name: string }> =>
        useWorkspaceStore.getState().workspaces.map((w) => ({ id: w.id, name: w.name }));
      if (useWorkspaceStore.getState().workspaces.length > 0) {
        openViewPanel({ targetNodeId: nodeId, targetName: nodeName, workspaces: toEntries(), groupId });
        return;
      }
      void useWorkspaceStore.getState().load().then(() => {
        openViewPanel({ targetNodeId: nodeId, targetName: nodeName, workspaces: toEntries(), groupId });
      });
    },
    [openViewPanel],
  );

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
    <>
      {viewOpen && !viewPicking ? <RemoteViewPane /> : <GroupMonitor onOpenView={handleOpenView} />}
      <ViewPickerDialog />
    </>
  );
}
