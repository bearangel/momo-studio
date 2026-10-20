// renderer/src/components/task-board/TaskSidebarPanel.tsx
//
// 看板侧边栏面板（看板重构 Task 14 重构；UX 修复移除侧边栏新建任务入口——
// 主区 BoardToolbar 已有新建，侧边栏重复入口退役）：
//   - 分组管理：GroupManageList（组列表/新建/重命名/换色/归档组/取消归档）
//   - 归档入口：显示归档计数（mount 拉一次 task.list({archived:'only'})），
//     点击打开 ArchivePanel（大号弹窗，恢复动作在面板内完成）
//   - 远端节点：P4 Task 3 只读分区——函数体原样保留（p2p:getRemoteTasks 5s
//     轮询，每节点一张分组卡，无任何操作按钮）
//
// 旧 TaskFilters/TaskList/task-filter 列表形态随本重构退役（Task 14）——
// 任务列表消费移入画板主区（BoardToolbar 过滤 + BoardCanvas）。
import { useEffect, useState } from 'react';
import { Archive } from 'lucide-react';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { ipc } from '../../ipc/client';
import { ArchivePanel } from './ArchivePanel';
import { GroupManageList } from './GroupManageList';

export function TaskSidebarPanel() {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archivedCount, setArchivedCount] = useState(0);

  // mount 拉一次归档计数（面板内恢复会自行刷新展示，此处不轮询）
  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    ipc.task
      .list({ workspaceId: workspace.id, archived: 'only', limit: 500 })
      .then((rows) => {
        if (!cancelled) setArchivedCount(rows.length);
      })
      .catch(() => {
        // 计数拉取失败静默保持 0（入口仍可用）
      });
    return () => {
      cancelled = true;
    };
  }, [workspace?.id]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto pt-1">
        <GroupManageList />
      </div>
      {/* 归档入口：计数 = 当前 workspace 归档任务数 */}
      <div className="shrink-0 border-t border-subtle px-3 py-2">
        <button
          type="button"
          aria-label={`归档 ${archivedCount}`}
          onClick={() => setArchiveOpen(true)}
          disabled={!workspace}
          className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-xs text-secondary hover:text-primary disabled:opacity-40"
        >
          <Archive size={12} strokeWidth={1.75} aria-hidden />
          归档 <span className="text-tertiary">{archivedCount}</span>
        </button>
      </div>
      {workspace && (
        <ArchivePanel
          open={archiveOpen}
          onClose={() => setArchiveOpen(false)}
          workspaceId={workspace.id}
        />
      )}
    </div>
  );
}
