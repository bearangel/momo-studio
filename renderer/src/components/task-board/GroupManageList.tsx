// renderer/src/components/task-board/GroupManageList.tsx
//
// 分组管理列表（看板重构 Task 14，spec §5 侧边栏；UX 波 2 #2/#3）：
//   - 「全部」行：列表头部，selectedGroupId=null 态高亮；计数=全部活跃任务数
//   - 活跃组列表：position 升序；行 = 色点（groupColorStyle 语义 token 或自定义
//     hex）/ 组名 / 任务数（task.store.tasks 按 groupId 实时计）/ GroupMenu 菜单
//   - 行满宽可点（UX 波 2 #3）：整行选择按钮 w-full（视觉/交互与「全部」行一致）；
//     拖动手柄与菜单按钮为绝对定位兄弟层，结构隔离——点击它们不可能触发选中
//   - 调序（UX 波 2 #2，替代上下移按钮）：@dnd-kit/sortable 垂直拖动排序，
//     仅 GripVertical 手柄可发起拖动；落点经纯函数 computeGroupOrder 产新序调
//     group.store.reorder（dnd DOM 拖拽 jsdom 测不了，单测照 Task 12 resolveDrop
//     模式打在导出的纯函数/编排函数上）
//   - 新建组：「+ 新建组」→ 内联输入回车提交（taskGroup.create 契约）
//   - 重命名：菜单触发 → 行内编辑输入（Enter 提交 / Esc 取消）
//   - 归档组 / 换色：GroupMenu（useGroupActions 公共逻辑）
//   - 取消归档：底部折叠区列归档组（taskGroup.list archived:'only'），
//     点选 taskGroup.unarchive（只复活组本体）
//
// 数据：group.store 活跃组（mount 拉一次，与 TaskBoardView 的 load 幂等并行）；
// 归档组列表在活跃组集合每次变化后刷新（archive/unarchive 都会改 groups）。
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Archive, ChevronDown, ChevronRight, GripVertical, Plus } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ipc } from '../../ipc/client';
import type { GroupRow } from '../../ipc/types';
import { cn } from '../../lib/cn';
import { groupColorStyle } from '../../lib/board';
import { useGroupStore } from '../../stores/group.store';
import { useTaskStore } from '../../stores/task.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { showToast } from '../ui/Toast';
import { GroupMenu } from './GroupMenu';
import { useGroupActions } from './useGroupActions';

/** PointerSensor 激活位移阈值（px）：小于该位移视为点击，不启动拖拽 */
const DRAG_ACTIVATION_DISTANCE_PX = 4;

/**
 * 拖动落点 → 新组序（纯函数，UX 波 2 #2）：
 * active/over 任一不在列表、或同位（active===over）→ null（不调 reorder）；
 * 否则把 active 移到 over 位次，返回新 id 序。
 */
export function computeGroupOrder(
  groups: GroupRow[],
  activeId: string,
  overId: string,
): string[] | null {
  const activeIdx = groups.findIndex((g) => g.id === activeId);
  const overIdx = groups.findIndex((g) => g.id === overId);
  if (activeIdx < 0 || overIdx < 0 || activeIdx === overIdx) return null;
  const next = [...groups];
  const [row] = next.splice(activeIdx, 1);
  if (!row) return null;
  next.splice(overIdx, 0, row);
  return next.map((g) => g.id);
}

/**
 * 拖动落点编排（onDragEnd 的可测包装）：computeGroupOrder 产新序调 reorder；
 * 同位/未知 id 零调用；失败 toast + 本地 groups 不动（store.reorder 失败 rethrow）。
 */
export async function applyGroupReorder(
  groups: GroupRow[],
  activeId: string,
  overId: string,
  reorder: (orderedIds: string[]) => Promise<void>,
): Promise<void> {
  const ids = computeGroupOrder(groups, activeId, overId);
  if (ids === null) return;
  try {
    await reorder(ids);
  } catch (err) {
    showToast(`调整分组顺序失败: ${(err as Error).message}`);
  }
}

interface SortableGroupRowProps {
  group: GroupRow;
  selected: boolean;
  renaming: boolean;
  count: number;
  onToggleSelect: (id: string, selected: boolean) => void;
  onRenameRequest: (id: string) => void;
  onRenameCommit: (id: string, name: string) => void;
  onRenameCancel: () => void;
}

/** 单个分组行：useSortable 挂 li（位移动画），拖动 listener 只给手柄按钮 */
function SortableGroupRow({
  group,
  selected,
  renaming,
  count,
  onToggleSelect,
  onRenameRequest,
  onRenameCommit,
  onRenameCancel,
}: SortableGroupRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: group.id,
  });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition };
  const colorCss = groupColorStyle(group.color);
  const dotStyle: CSSProperties = colorCss
    ? { backgroundColor: colorCss }
    : { backgroundColor: 'rgb(var(--text-tertiary))' };

  return (
    <li
      ref={setNodeRef}
      style={style}
      aria-label={`分组 ${group.name}`}
      className={cn('relative w-full rounded', isDragging && 'z-10 opacity-70')}
    >
      {renaming ? (
        <input
          aria-label={`重命名${group.name}`}
          defaultValue={group.name}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onRenameCommit(group.id, (e.target as HTMLInputElement).value.trim());
            }
            if (e.key === 'Escape') onRenameCancel();
          }}
          className="w-full rounded border border-subtle bg-surface-2 px-2 py-1.5 text-[13px] text-primary focus:border-focus focus:outline-none"
        />
      ) : (
        <>
          {/* 整行满宽选择按钮（UX 波 2 #3）：右侧 pr 预留手柄+菜单层空间；
              手柄/菜单是绝对定位兄弟节点，点击它们结构上不可能冒泡成选中 */}
          <button
            type="button"
            aria-label={`筛选分组 ${group.name}`}
            aria-pressed={selected}
            title={selected ? '取消分组过滤' : '只看该组任务'}
            onClick={() => onToggleSelect(group.id, selected)}
            className={cn(
              'flex min-h-7 w-full items-center gap-1.5 rounded border py-1.5 pl-1.5 pr-14 text-left text-[13px] leading-4 transition-colors',
              selected
                ? 'border-focus bg-surface-active text-primary'
                : 'border-transparent text-secondary hover:bg-surface-2',
            )}
          >
            <i aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-[2px]" style={dotStyle} />
            <span className="min-w-0 flex-1 truncate">{group.name}</span>
            <span className="shrink-0 text-tertiary">{count}</span>
          </button>
          <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
            <button
              type="button"
              aria-label={`拖动排序 ${group.name}`}
              title="拖动排序"
              {...attributes}
              {...listeners}
              className="flex h-6 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-tertiary hover:text-primary"
            >
              <GripVertical size={14} strokeWidth={1.75} aria-hidden />
            </button>
            <GroupMenu
              group={group}
              triggerLabel={`分组菜单 ${group.name}`}
              onRenameRequest={() => onRenameRequest(group.id)}
            />
          </div>
        </>
      )}
    </li>
  );
}

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

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE_PX },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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

  const toggleSelect = useCallback(
    (id: string, selected: boolean): void => {
      setSelectedGroupId(selected ? null : id);
    },
    [setSelectedGroupId],
  );

  const requestRename = useCallback((id: string) => setRenamingId(id), []);

  const commitRename = useCallback(
    (id: string, name: string): void => {
      setRenamingId(null);
      const g = groups.find((x) => x.id === id);
      if (name !== '' && g && name !== g.name) void runRename(id, name);
    },
    [groups, runRename],
  );

  const cancelRename = useCallback((): void => setRenamingId(null), []);

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

      <DndContext
        sensors={sensors}
        onDragEnd={(event) => {
          const overId = event.over ? String(event.over.id) : '';
          void applyGroupReorder(groups, String(event.active.id), overId, reorderGroups);
        }}
      >
        <SortableContext
          items={groups.map((g) => g.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="flex flex-col gap-0.5">
            {groups.map((g) => (
              <SortableGroupRow
                key={g.id}
                group={g}
                selected={selectedGroupId === g.id}
                renaming={renamingId === g.id}
                count={countByGroup.get(g.id) ?? 0}
                onToggleSelect={toggleSelect}
                onRenameRequest={requestRename}
                onRenameCommit={commitRename}
                onRenameCancel={cancelRename}
              />
            ))}
            {!groupsLoading && groups.length === 0 && !creating && (
              <li className="py-1 text-xs text-tertiary">暂无分组</li>
            )}
          </ul>
        </SortableContext>
      </DndContext>

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
