// renderer/src/components/task-board/task-filter.ts
//
// 任务过滤+排序纯函数（自 TaskSidebarPanel 抽出，spec §4）：
// status / assignee / text 三过滤 AND 叠加后按 sort 排序。
// text 匹配 title + description（大小写不敏感子串，空 = 不过滤）。
import type { TaskStatus, TaskRow } from '../../ipc/types';
import type { FilterState } from './TaskFilters';

/** 'all' 的语义 = 不过滤（全部 9 态）。终态历史由 task.store.load 的
 *  orderBy created_at_desc + limit 500 截断保障。 */
const ALL_STATUSES: TaskStatus[] = [
  'draft',
  'pending',
  'assigned',
  'session_queued',
  'in_progress',
  'paused',
  'completed',
  'failed',
  'cancelled',
];

export function applyTaskFilters(tasks: TaskRow[], filter: FilterState): TaskRow[] {
  let list = [...tasks];
  if (filter.status === 'all') {
    list = list.filter((t) => ALL_STATUSES.includes(t.status));
  } else {
    list = list.filter((t) => t.status === filter.status);
  }
  if (filter.assignee !== 'all') {
    list = list.filter((t) => t.assigneeAgentId === filter.assignee);
  }
  const q = filter.text.trim().toLowerCase();
  if (q !== '') {
    list = list.filter(
      (t) => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    );
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
}
