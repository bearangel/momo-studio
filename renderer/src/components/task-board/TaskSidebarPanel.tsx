// renderer/src/components/task-board/TaskSidebarPanel.tsx
//
// 看板侧边栏面板（P2 Task 3）：TaskFilters + TaskList + 新建任务按钮从
// TaskBoardView 整体迁入。选中态与筛选逻辑与主区解耦——
//   - 任务数据/选中态走 task.store（TaskBoardView 主区负责 load + 5s 轮询）
//   - 筛选/排序 state 本地持有（原 TaskBoardView filteredTasks useMemo 等价迁移）
//   - 新建任务复用 CreateTaskDialog（与 IM 输入条 📌 入口同源），创建后自动选中
//
// P4 Task 3 追加：底部「远端节点」只读分区——p2p:getRemoteTasks 5s 轮询，
// 每节点一张分组卡（节点名 + 相对时间 + 已离线? 标记 + 只读任务行），
// 无任何操作按钮（远端任务不进本地 tasks 表，仅镜像展示）。
import { useEffect, useMemo, useState } from 'react';
import { useTaskStore } from '../../stores/task.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useAgentStore } from '../../stores/agent.store';
import { ipc } from '../../ipc/client';
import type { RemoteNodeTasks } from '../../ipc/types';
import { CreateTaskDialog } from '../im/CreateTaskDialog';
import { TaskList } from './TaskList';
import { TaskFilters, type FilterState, type AssigneeOption } from './TaskFilters';
import { STATUS_LABEL, STATUS_COLOR } from './TaskCard';

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
    <div className="shrink-0 border-t border-border-subtle px-3 py-2">
      <div className="text-xs font-medium text-neutral-400 mb-1">远端节点</div>
      <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
        {remoteTasks.map((node) => (
          <div key={node.nodeId} className="border border-border-subtle rounded p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-neutral-200 truncate">
                {node.nodeName}
              </span>
              <span className="text-xs text-neutral-500 shrink-0">
                <span>{formatRelativeTime(node.takenAt)}</span>
                {node.stale && <span className="text-amber-500 ml-1">已离线?</span>}
              </span>
            </div>
            {node.tasks.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-2 mt-1">
                <span className="text-xs text-neutral-300 truncate">
                  #{t.id} · {t.title}
                </span>
                {/* 跨版本对端可能送来未知状态枚举——回退原样展示 */}
                <span className="text-xs shrink-0" style={{ color: STATUS_COLOR[t.status] }}>
                  {STATUS_LABEL[t.status] ?? t.status}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TaskSidebarPanel() {
  const tasks = useTaskStore((s) => s.tasks);
  const selectedTaskId = useTaskStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useTaskStore((s) => s.setSelectedTaskId);
  const workspace = useWorkspaceStore((s) => s.getActive());
  const assignments = useAgentStore((s) => s.assignments);
  const [filter, setFilter] = useState<FilterState>({
    status: 'all',
    assignee: 'all',
    sort: 'priority',
  });
  const [createOpen, setCreateOpen] = useState(false);

  // assignee 下拉选项：从当前 workspace 的 assignment 派生
  // （label=agentName 优先，回退 agentUserId，最后 instanceId——确保至少有可读名）
  const assigneeOptions = useMemo<AssigneeOption[]>(
    () =>
      assignments
        .filter((a) => (workspace ? a.workspaceId === workspace.id : true))
        .map((a) => ({
          value: a.instanceId,
          label: a.agentName ?? a.agentUserId ?? a.instanceId,
        })),
    [assignments, workspace],
  );

  // 筛选 + 排序（自 TaskBoardView 原样迁移）
  const filteredTasks = useMemo(() => {
    let list = [...tasks];
    if (filter.status !== 'all') {
      list = list.filter((t) => t.status === filter.status);
    }
    if (filter.assignee !== 'all') {
      list = list.filter((t) => t.assigneeAgentId === filter.assignee);
    }
    list.sort((a, b) => {
      if (filter.sort === 'priority') {
        return b.priority - a.priority || a.createdAt - b.createdAt;
      }
      if (filter.sort === 'scheduled_at') {
        return (
          (a.scheduledAt ?? Number.MAX_SAFE_INTEGER) -
          (b.scheduledAt ?? Number.MAX_SAFE_INTEGER)
        );
      }
      // created_at
      return a.createdAt - b.createdAt;
    });
    return list;
  }, [tasks, filter]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-3 pt-3 pb-1 shrink-0">
        <span className="text-sm font-medium text-neutral-200">任务</span>
        {/* 无 workspace 时 CreateWorkspaceDialog 无宿主，禁用入口避免死按钮 */}
        <button
          type="button"
          aria-label="新建任务"
          title="新建任务"
          onClick={() => setCreateOpen(true)}
          disabled={!workspace}
          className="text-neutral-400 hover:text-neutral-100 disabled:opacity-40 disabled:hover:text-neutral-400 text-sm px-1 rounded"
        >
          ＋
        </button>
      </div>
      <TaskFilters value={filter} onChange={setFilter} assigneeOptions={assigneeOptions} />
      <TaskList
        tasks={filteredTasks}
        selectedId={selectedTaskId}
        onSelect={(id) => setSelectedTaskId(id)}
      />
      <RemoteTaskSection />
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
