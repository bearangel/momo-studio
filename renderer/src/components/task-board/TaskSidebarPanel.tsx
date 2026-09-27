// renderer/src/components/task-board/TaskSidebarPanel.tsx
//
// 看板侧边栏面板（看板重构 Task 14 重构）：
//   - 分组管理：GroupManageList（组列表/新建/重命名/换色/归档组/取消归档）
//   - 归档入口：显示归档计数（mount 拉一次 task.list({archived:'only'})），
//     点击打开 ArchivePanel（大号弹窗，恢复动作在面板内完成）
//   - 远端节点：P4 Task 3 只读分区——函数体原样保留（p2p:getRemoteTasks 5s
//     轮询，每节点一张分组卡，无任何操作按钮）
//   - 新建任务：Plus 入口 + CreateTaskDialog（创建后自动选中）保留
//
// 旧 TaskFilters/TaskList/task-filter 列表形态随本重构退役（Task 14）——
// 任务列表消费移入画板主区（BoardToolbar 过滤 + BoardCanvas）。
import { useEffect, useState } from 'react';
import { Archive, Plus } from 'lucide-react';
import { useTaskStore } from '../../stores/task.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { ipc } from '../../ipc/client';
import type { RemoteNodeTasks } from '../../ipc/types';
import { CreateTaskDialog } from '../im/CreateTaskDialog';
import { ArchivePanel } from './ArchivePanel';
import { GroupManageList } from './GroupManageList';
import { remoteStatusStyle } from '../../lib/task-status';

/** 远端镜像轮询间隔（毫秒）——同 NodeDiscoveryPanel 的发现节点轮询节奏 */
const REMOTE_REFRESH_INTERVAL_MS = 5000;

/** 相对时间展示：「xx 秒/分钟/小时前」 */
function formatRelativeTime(takenAt: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - takenAt) / 1000));
  if (diffSec < 60) return `${diffSec} 秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  return `${Math.floor(diffMin / 60)} 小时前`;
}

/** 底部远端节点只读分区——空数据不渲染；任务行纯展示（非按钮、无操作） */
function RemoteTaskSection() {
  const [remoteTasks, setRemoteTasks] = useState<RemoteNodeTasks[]>([]);

  useEffect(() => {
    const refresh = async (): Promise<void> => {
      try {
        setRemoteTasks(await ipc.p2p.getRemoteTasks());
      } catch {
        // P2P 未启用 / 通道未注册 → 静默保持空（分区不渲染，不刷错误）
      }
    };
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, REMOTE_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  if (remoteTasks.length === 0) return null;

  return (
    <div className="shrink-0 border-t border-subtle px-3 py-2">
      <div className="text-xs font-medium text-tertiary mb-1">远端节点</div>
      <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
        {remoteTasks.map((node) => (
          <div key={node.nodeId} className="border border-subtle rounded p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-primary truncate">
                {node.nodeName}
              </span>
              <span className="text-xs text-tertiary shrink-0">
                <span>{formatRelativeTime(node.takenAt)}</span>
                {node.stale && <span className="text-status-warning ml-1">已离线?</span>}
              </span>
            </div>
            {node.tasks.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-2 mt-1">
                <span className="text-xs text-secondary truncate">
                  #{t.id} · {t.title}
                </span>
                {/* 跨版本对端可能送来未知状态枚举——remoteStatusStyle 回退原样展示 */}
                {(() => {
                  const s = remoteStatusStyle(t.status);
                  return <span className={s.className}>{s.label}</span>;
                })()}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TaskSidebarPanel() {
  const setSelectedTaskId = useTaskStore((s) => s.setSelectedTaskId);
  const workspace = useWorkspaceStore((s) => s.getActive());
  const [createOpen, setCreateOpen] = useState(false);
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
      <div className="flex items-center justify-between px-3 pt-3 pb-1 shrink-0">
        <span className="text-sm font-medium text-primary">任务</span>
        {/* 无 workspace 时 CreateWorkspaceDialog 无宿主，禁用入口避免死按钮 */}
        <button
          type="button"
          aria-label="新建任务"
          title="新建任务"
          onClick={() => setCreateOpen(true)}
          disabled={!workspace}
          className="text-tertiary hover:text-primary disabled:opacity-40 px-1 rounded"
        >
          <Plus size={12} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
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
      <RemoteTaskSection />
      {workspace && (
        <ArchivePanel
          open={archiveOpen}
          onClose={() => setArchiveOpen(false)}
          workspaceId={workspace.id}
        />
      )}
      {workspace && (
        <CreateTaskDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={(taskId) => setSelectedTaskId(taskId)}
          workspaceId={workspace.id}
        />
      )}
    </div>
  );
}
