// renderer/src/components/task-board/GroupManageList.tsx
//
// 分组管理列表（看板重构 Task 14，spec §5 侧边栏；UX 修复：行高/字号调大 +
// 点击组行过滤看板）：
//   - 「全部」行：列表头部，selectedGroupId=null 态高亮；计数=全部活跃任务数
//   - 活跃组列表：position 升序；行 = 色点（groupColorStyle 语义 token）/
//     组名 / 任务数（task.store.tasks 按 groupId 实时计）/ GroupMenu 菜单；
//     点击色点+组名+计数区 → 看板只显示该组（再点取消）——选择区与调序箭头/
//     菜单按钮为兄弟节点，结构上隔离（点击操作按钮不可能冒泡成选中）
//   - 新建组：「+ 新建组」→ 内联输入回车提交（taskGroup.create 契约）
//   - 重命名：菜单触发 → 行内编辑输入（Enter 提交 / Esc 取消）
//   - 调序（spec §5.1 可调序）：行尾 ChevronUp/ChevronDown，与相邻组交换后
//     以新序调 group.store.reorder；首组禁用上移、末组禁用下移
//   - 归档组 / 换色：GroupMenu（useGroupActions 公共逻辑）
//   - 取消归档：底部折叠区列归档组（taskGroup.list archived:'only'），
//     点选 taskGroup.unarchive（只复活组本体）
//
// 数据：group.store 活跃组（mount 拉一次，与 TaskBoardView 的 load 幂等并行）；
// 归档组列表在活跃组集合每次变化后刷新（archive/unarchive 都会改 groups）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, ChevronDown, ChevronRight, ChevronUp, Plus } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { CSSProperties } from 'react';
import type { GroupRow } from '../../ipc/types';
import { cn } from '../../lib/cn';
import { groupColorStyle } from '../../lib/board';
import { useGroupStore } from '../../stores/group.store';
import { useTaskStore } from '../../stores/task.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { showToast } from '../ui/Toast';
import { GroupMenu } from './GroupMenu';
import { useGroupActions } from './useGroupActions';

export function GroupManageList() {
  const workspace = useWorkspaceStore((s) => s.getActive());
  // 无 workspace 时下方渲染 null；hook 必须无条件调用 → 以 '' 占位（内部动作不可达）
  const { runRename, runUnarchive } = useGroupActions(workspace?.id ?? '');
  const groups = useGroupStore((s) => s.groups);
  const groupsLoading = useGroupStore((s) => s.loading);
  const selectedGroupId = useGroupStore((s) => s.selectedGroupId);
  const setSelectedGroupId = useGroupStore((s) => s.setSelectedGroupId);
  const loadGroups = useGroupStore((s) => s.load);
  const createGroup = useGroupStore((s) => s.create);
  const reorderGroups = useGroupStore((s) => s.reorder);
  const tasks = useTaskStore((s) => s.tasks);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  /** 行内重命名目标组 id（null=无） */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [archivedGroups, setArchivedGroups] = useState<GroupRow[]>([]);
  const [showArchived, setShowArchived] = useState(false);

  // mount / workspace 切换拉活跃组（与 TaskBoardView 并行各拉一次，幂等）
  useEffect(() => {
    if (!workspace) return;
    void loadGroups(workspace.id).catch(() => {
      // 组拉取失败不阻塞侧边栏——空列表 + 画板侧同样静默
    });
  }, [workspace?.id, loadGroups]);

  // 归档组列表：mount + 活跃组集合变化后刷新（archive→入档 / unarchive→出档都会改 groups）
  const refreshArchived = useCallback(async (wsId: string): Promise<void> => {
    try {
      setArchivedGroups(await ipc.taskGroup.list(wsId, { archived: 'only' }));
    } catch {
      setArchivedGroups([]); // 拉取失败折叠区置空（无归档组展示）
    }
  }, []);
  useEffect(() => {
    if (!workspace) return;
    void refreshArchived(workspace.id);
  }, [workspace?.id, groups, refreshArchived]);

  // 任务数：task.store.tasks（活跃任务）按 groupId 计
  const countByGroup = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) {
      if (t.groupId !== null) m.set(t.groupId, (m.get(t.groupId) ?? 0) + 1);
    }
    return m;
  }, [tasks]);

  const submitCreate = async (): Promise<void> => {
    if (!workspace) return;
    const name = newName.trim();
    if (name === '') {
      setCreating(false);
      setNewName('');
      return;
    }
    try {
      await createGroup({ workspaceId: workspace.id, name });
      setNewName('');
      setCreating(false);
    } catch (err) {
      // 失败收起输入 + toast 提示（store 不吞错，UI 层承接）
      setCreating(false);
      showToast(`新建组失败: ${(err as Error).message}`);
    }
  };

  /** 与相邻组交换后取新序调 reorder（store 镜像 repo 的 (i+1)*1024 重写） */
  const moveGroup = (index: number, delta: -1 | 1): void => {
    const target = index + delta;
    if (target < 0 || target >= groups.length) return;
    const next = [...groups];
    const [row] = next.splice(index, 1);
    if (!row) return;
    next.splice(target, 0, row);
    void reorderGroups(next.map((g) => g.id)).catch((err) => {
      showToast(`调整分组顺序失败: ${(err as Error).message}`);
    });
  };

  if (!workspace) return null;

  return (
    <section aria-label="分组管理" className="flex flex-col gap-1 px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-tertiary">分组</span>
        <button
          type="button"
          aria-label="新建组"
          title="新建组"
          onClick={() => setCreating(true)}
          className="text-tertiary hover:text-primary px-1 rounded"
        >
          <Plus size={12} strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      {creating && (
        <input
          aria-label="新组名称"
          value={newName}
          autoFocus
          placeholder="组名，回车创建"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submitCreate();
            if (e.key === 'Escape') {
              setCreating(false);
              setNewName('');
            }
          }}
          className="rounded border border-subtle bg-surface-2 px-2 py-1.5 text-[13px] text-primary focus:border-focus focus:outline-none"
        />
      )}

      {/* 「全部」行：selectedGroupId=null 态（显示全部任务）；计数=活跃任务总数 */}
      <button
        type="button"
        aria-label="筛选全部分组"
        aria-pressed={selectedGroupId === null}
        onClick={() => setSelectedGroupId(null)}
        className={cn(
          'flex min-h-7 w-full items-center gap-1.5 rounded border px-1.5 py-1.5 text-left text-[13px] leading-4 transition-colors',
          selectedGroupId === null
            ? 'border-focus bg-surface-active text-primary'
            : 'border-transparent text-secondary hover:bg-surface-2',
        )}
      >
        <span className="min-w-0 flex-1 truncate">全部</span>
        <span className="shrink-0 text-tertiary">{tasks.length}</span>
      </button>

      <ul className="flex flex-col gap-0.5">
        {groups.map((g, index) => {
          const colorCss = groupColorStyle(g.color);
          const dotStyle: CSSProperties = colorCss
            ? { backgroundColor: colorCss }
            : { backgroundColor: 'rgb(var(--text-tertiary))' };
          const selected = selectedGroupId === g.id;
          return (
            <li
              key={g.id}
              aria-label={`分组 ${g.name}`}
              className="flex min-h-7 items-center gap-1 rounded text-[13px] leading-4"
            >
              {renamingId === g.id ? (
                <input
                  aria-label={`重命名${g.name}`}
                  defaultValue={g.name}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const name = (e.target as HTMLInputElement).value.trim();
                      setRenamingId(null);
                      if (name !== '' && name !== g.name) void runRename(g.id, name);
                    }
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  className="w-full rounded border border-subtle bg-surface-2 px-2 py-1.5 text-[13px] text-primary focus:border-focus focus:outline-none"
                />
              ) : (
                <>
                  {/* 选择区按钮：与调序箭头/菜单按钮兄弟布局——点击操作按钮结构上不可能触发选中 */}
                  <button
                    type="button"
                    aria-label={`筛选分组 ${g.name}`}
                    aria-pressed={selected}
                    title={selected ? '取消分组过滤' : '只看该组任务'}
                    onClick={() => setSelectedGroupId(selected ? null : g.id)}
                    className={cn(
                      'flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded border px-1.5 py-1.5 text-left transition-colors',
                      selected
                        ? 'border-focus bg-surface-active text-primary'
                        : 'border-transparent text-secondary hover:bg-surface-2',
                    )}
                  >
                    <i aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-[2px]" style={dotStyle} />
                    <span className="min-w-0 flex-1 truncate">{g.name}</span>
                    <span className="shrink-0 text-tertiary">{countByGroup.get(g.id) ?? 0}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`上移 ${g.name}`}
                    title="上移"
                    disabled={index === 0}
                    onClick={() => moveGroup(index, -1)}
                    className="flex h-6 w-5 shrink-0 items-center justify-center rounded text-tertiary hover:text-primary disabled:opacity-40"
                  >
                    <ChevronUp size={14} strokeWidth={1.75} aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={`下移 ${g.name}`}
                    title="下移"
                    disabled={index === groups.length - 1}
                    onClick={() => moveGroup(index, 1)}
                    className="flex h-6 w-5 shrink-0 items-center justify-center rounded text-tertiary hover:text-primary disabled:opacity-40"
                  >
                    <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
                  </button>
                  <GroupMenu
                    group={g}
                    triggerLabel={`分组菜单 ${g.name}`}
                    onRenameRequest={() => setRenamingId(g.id)}
                  />
                </>
              )}
            </li>
          );
        })}
        {!groupsLoading && groups.length === 0 && !creating && (
          <li className="py-1 text-xs text-tertiary">暂无分组</li>
        )}
      </ul>

      {/* 归档组折叠区（有归档组才渲染入口；内容按展开态渲染） */}
      {archivedGroups.length > 0 && (
        <div className="mt-1 border-t border-subtle pt-1">
          <button
            type="button"
            aria-label="已归档分组"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((v) => !v)}
            className="flex w-full items-center gap-1 rounded px-0.5 py-0.5 text-xs text-tertiary hover:text-primary"
          >
            {showArchived ? (
              <ChevronDown size={12} strokeWidth={1.75} aria-hidden />
            ) : (
              <ChevronRight size={12} strokeWidth={1.75} aria-hidden />
            )}
            <Archive size={12} strokeWidth={1.75} aria-hidden />
            已归档分组 ({archivedGroups.length})
          </button>
          {showArchived && (
            <div className="flex flex-col gap-0.5 py-1">
              {archivedGroups.map((g) => (
                <div key={g.id} className="flex items-center gap-1.5 px-1 py-0.5 text-xs">
                  <span className="min-w-0 flex-1 truncate text-tertiary">{g.name}</span>
                  <button
                    type="button"
                    aria-label={`取消归档 ${g.name}`}
                    onClick={() => void runUnarchive(g.id)}
                    className="shrink-0 rounded px-1 text-tertiary hover:text-primary"
                  >
                    取消归档
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
