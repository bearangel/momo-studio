// renderer/src/components/task-board/ArchivePanel.tsx
//
// 归档面板（看板重构 Task 14，spec §7）：大号 Dialog 弹窗——
//   - 数据：open 时并行拉 task.list({archived:'only', orderBy:'created_at_desc',
//     limit:500}) + taskGroup.list(ws,{archived:'all'})（组名 map）
//   - 过滤：搜索框（标题/ID 子串）+ 组 select + 状态 select，三维 AND
//   - 行：checkbox / #短ID·标题 / 组名 / 状态徽标 / 归档时间 / 单条「恢复」
//   - 底部：已选 n · 批量恢复（按列表序逐条）· 恢复整组 select（候选=还有
//     归档任务的已归档组，选中即一次 taskGroup.unarchive——主进程事务内
//     组+组内归档任务一并恢复，2026-09-27 spec §3.1 修订）
//
// 恢复链路：单条/批量走 task.store.unarchive（ipc.task.unarchive + 本地 tasks
// 追加——恢复行立即回看板）；恢复整组走 ipc.taskGroup.unarchive 一次调用，
// 成功后重拉 rows/groups + task.store.load（组内任务即时回看板，不等 5s 轮询）；
// 失败 toast 且行保留。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { GroupRow, TaskRow, TaskStatus } from '../../ipc/types';
import { taskStatusStyle } from '../../lib/task-status';
import { useTaskStore } from '../../stores/task.store';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Toast, showToast } from '../ui/Toast';

/** 状态下拉遍历序（task-status 词表单源，避免本文件另造清单漂移） */
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

interface ArchivePanelProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
}

export function ArchivePanel({ open, onClose, workspaceId }: ArchivePanelProps) {
  const unarchiveTask = useTaskStore((s) => s.unarchive);
  const loadTasks = useTaskStore((s) => s.load);
  const [rows, setRows] = useState<TaskRow[]>([]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [restoring, setRestoring] = useState(false);

  // open 时拉数据 + 复位过滤/勾选（关闭再开保持干净态）；卸载/关闭中途取消落盘
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRows([]);
    setGroups([]);
    setSearch('');
    setGroupFilter('all');
    setStatusFilter('all');
    setSelected(new Set());
    Promise.all([
      ipc.task.list({ workspaceId, archived: 'only', orderBy: 'created_at_desc', limit: 500 }),
      ipc.taskGroup.list(workspaceId, { archived: 'all' }),
    ])
      .then(([tasks, groupRows]) => {
        if (cancelled) return;
        setRows(tasks);
        setGroups(groupRows);
      })
      .catch((err) => {
        if (cancelled) return;
        showToast(`归档数据拉取失败: ${(err as Error).message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId]);

  const groupNameById = useMemo(
    () => new Map(groups.map((g) => [g.id, g.name] as const)),
    [groups],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((t) => {
      if (q !== '' && !t.title.toLowerCase().includes(q) && !t.id.toLowerCase().includes(q)) {
        return false;
      }
      if (groupFilter !== 'all' && (t.groupId ?? '') !== groupFilter) return false;
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      return true;
    });
  }, [rows, search, groupFilter, statusFilter]);

  /** 过滤组下拉候选：出现在归档行里的组（保序去重）+ 未分组 */
  const groupOptions = useMemo(() => {
    const seen: string[] = [];
    for (const t of rows) {
      const gid = t.groupId ?? '';
      if (gid !== '' && groupNameById.has(gid) && !seen.includes(gid)) seen.push(gid);
    }
    return seen;
  }, [rows, groupNameById]);
  const hasUngroupedRow = useMemo(() => rows.some((t) => t.groupId === null), [rows]);

  /** 恢复整组候选：已归档组中还有归档任务在列的组 */
  const restoreGroupOptions = useMemo(() => {
    const archivedGroupIds = new Set(
      groups.filter((g) => g.archivedAt !== null).map((g) => g.id),
    );
    const present = new Set(
      rows.map((t) => t.groupId).filter((gid): gid is string => gid !== null),
    );
    return groups.filter((g) => archivedGroupIds.has(g.id) && present.has(g.id));
  }, [groups, rows]);

  const restoreOne = useCallback(
    async (id: string): Promise<void> => {
      setRestoring(true);
      try {
        await unarchiveTask(id);
        setRows((rs) => rs.filter((t) => t.id !== id));
        setSelected((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
      } catch (err) {
        showToast(`恢复失败: ${(err as Error).message}`);
      } finally {
        setRestoring(false);
      }
    },
    [unarchiveTask],
  );

  const toggleSelected = (id: string): void => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** 批量恢复：按列表序逐条（失败行 toast 中断该行、后续行继续） */
  const restoreSelected = async (): Promise<void> => {
    for (const t of filtered) {
      if (selected.has(t.id)) await restoreOne(t.id);
    }
  };

  /** 恢复整组：一次 taskGroup.unarchive（组+组内归档任务主进程事务一体恢复），重拉面板数据并刷新看板任务 */
  const restoreWholeGroup = async (groupId: string): Promise<void> => {
    setRestoring(true);
    try {
      await ipc.taskGroup.unarchive(groupId);
      const [tasks, groupRows] = await Promise.all([
        ipc.task.list({ workspaceId, archived: 'only', orderBy: 'created_at_desc', limit: 500 }),
        ipc.taskGroup.list(workspaceId, { archived: 'all' }),
      ]);
      setRows(tasks);
      setGroups(groupRows);
      setSelected((s) => {
        const next = new Set(s);
        for (const id of next) {
          if (!tasks.some((t) => t.id === id)) next.delete(id);
        }
        return next;
      });
      void loadTasks(workspaceId); // 看板即时回归（load 内部吞错，不阻断面板）
    } catch (err) {
      showToast(`恢复整组失败: ${(err as Error).message}`);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} title="归档任务" width={720}>
        {/* 过滤条：搜索 + 组 + 状态（三维 AND） */}
        <div className="flex items-center gap-2 pb-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索归档任务"
            aria-label="搜索归档任务"
            className="w-44 py-1.5"
          />
          <Select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            aria-label="按组过滤"
            className="w-32 py-1.5"
          >
            <option value="all">全部组</option>
            {groupOptions.map((gid) => (
              <option key={gid} value={gid}>
                {groupNameById.get(gid) ?? gid}
              </option>
            ))}
            {hasUngroupedRow && <option value="">未分组</option>}
          </Select>
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="按状态过滤"
            className="w-32 py-1.5"
          >
            <option value="all">全部状态</option>
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {taskStatusStyle(s).label}
              </option>
            ))}
          </Select>
        </div>

        {/* 归档行列表 */}
        <div className="flex flex-col gap-1">
          {filtered.length === 0 && (
            <div className="flex items-center justify-center gap-1.5 py-8 text-sm text-tertiary">
              <Archive size={14} strokeWidth={1.75} aria-hidden />
              暂无归档任务
            </div>
          )}
          {filtered.map((t) => {
            const status = taskStatusStyle(t.status);
            return (
              <div
                key={t.id}
                data-archive-row
                className="flex items-center gap-2 rounded-md border border-subtle bg-canvas px-2.5 py-1.5"
              >
                <Checkbox
                  aria-label={`选择 ${t.title}`}
                  checked={selected.has(t.id)}
                  onChange={() => toggleSelected(t.id)}
                  className="shrink-0"
                />
                <span className="min-w-0 flex-1 truncate text-xs text-primary">
                  #{t.id.slice(0, 6)} · {t.title}
                </span>
                <span className="w-20 shrink-0 truncate text-xs text-secondary">
                  {t.groupId !== null ? (groupNameById.get(t.groupId) ?? '未知组') : '未分组'}
                </span>
                <span className={`${status.className} shrink-0`}>{status.label}</span>
                <span className="w-36 shrink-0 truncate text-right text-xs text-tertiary">
                  {t.archivedAt !== null ? new Date(t.archivedAt).toLocaleString() : '—'}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={restoring}
                  onClick={() => void restoreOne(t.id)}
                >
                  恢复
                </Button>
              </div>
            );
          })}
        </div>

        {/* 底部动作条：已选 n / 批量恢复 / 恢复整组 */}
        <div className="mt-3 flex items-center gap-2 border-t border-subtle pt-3">
          <span className="text-xs text-tertiary">已选 {selected.size}</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={selected.size === 0 || restoring}
            onClick={() => void restoreSelected()}
          >
            批量恢复
          </Button>
          <Select
            aria-label="恢复整组"
            value=""
            className="ml-auto w-44 py-1"
            disabled={restoreGroupOptions.length === 0 || restoring}
            onChange={(e) => {
              const v = e.target.value;
              if (v !== '') void restoreWholeGroup(v);
            }}
          >
            <option value="">恢复整组…</option>
            {restoreGroupOptions.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}（{rows.filter((t) => t.groupId === g.id).length} 条）
              </option>
            ))}
          </Select>
        </div>
        <p className="mt-1.5 text-xs text-tertiary">恢复组会把组内全部归档任务一并带回</p>
      </Dialog>
      <Toast />
    </>
  );
}
