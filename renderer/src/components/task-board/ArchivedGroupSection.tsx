// renderer/src/components/task-board/ArchivedGroupSection.tsx
//
// 侧边栏「已归档分组」风琴分区（分组面板风琴化改造抽出的自包含组件）：
//   - 分区风琴头：默认折叠；有归档组才渲染（taskGroup.list archived:'only'）
//   - 归档组行 = 选中过滤按钮：整行可点 → 写 group.store.selectedArchivedGroupId，
//     主区看板切换为该组归档任务只读泳道（ArchivedBoardSection）；再点已选中
//     组行取消（镜像活跃组 toggleSelect 的 `selected ? null : id` 语义）；
//     选中高亮与活跃组行同款（border-focus bg-surface-active text-primary）
//   - 「取消归档」按钮保留为兄弟按钮（不触发选中；runUnarchive 解档连带刷新
//     任务列表）
//   - 侧边栏零归档任务拉取：归档任务展示整体移交主区，本组件不再拉取/缓存
//     任何任务（内联展开实现已退役）
//
// 数据：group.store 活跃组集合作失效信号（mount + groups 变化后刷新归档组列表；
// 选中互斥/清除契约单点在 group.store 动作内，本组件只写选中 id 不做双清）。
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Archive, ChevronDown, ChevronRight } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { GroupRow } from '../../ipc/types';
import { cn } from '../../lib/cn';
import { groupColorStyle } from '../../lib/board';
import { useGroupStore } from '../../stores/group.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useGroupActions } from './useGroupActions';

export function ArchivedGroupSection() {
  const workspace = useWorkspaceStore((s) => s.getActive());
  // 无 workspace 时下方渲染 null；hook 必须无条件调用 → 以 '' 占位（内部动作不可达）
  const { runUnarchive } = useGroupActions(workspace?.id ?? '');
  const groups = useGroupStore((s) => s.groups);
  const selectedArchivedGroupId = useGroupStore((s) => s.selectedArchivedGroupId);
  const setSelectedArchivedGroupId = useGroupStore((s) => s.setSelectedArchivedGroupId);

  /** 分区风琴态（默认折叠） */
  const [sectionOpen, setSectionOpen] = useState(false);
  const [archivedGroups, setArchivedGroups] = useState<GroupRow[]>([]);

  // 归档组列表：mount + 活跃组集合变化后刷新（archive→入档 / unarchive→出档都会改 groups）
  const refreshArchived = useCallback(async (wsId: string): Promise<void> => {
    try {
      setArchivedGroups(await ipc.taskGroup.list(wsId, { archived: 'only' }));
    } catch {
      setArchivedGroups([]); // 拉取失败分区置空（无归档组展示）
    }
  }, []);
  useEffect(() => {
    if (!workspace) return;
    void refreshArchived(workspace.id);
  }, [workspace?.id, groups, refreshArchived]);

  /** 组行 toggle：镜像活跃组 toggleSelect 的 `selected ? null : id` 语义 */
  const toggleSelect = useCallback(
    (id: string, selected: boolean): void => {
      setSelectedArchivedGroupId(selected ? null : id);
    },
    [setSelectedArchivedGroupId],
  );

  if (!workspace) return null;
  if (archivedGroups.length === 0) return null; // 无归档组不渲染分区

  return (
    <div className="mt-1 border-t border-subtle pt-1">
      {/* 风琴头样式与「任务分组」分区头统一：chevron + 分区图标 + 标题(font-medium) + 计数 */}
      <button
        type="button"
        aria-label="已归档分组"
        aria-expanded={sectionOpen}
        title={sectionOpen ? '折叠已归档分组' : '展开已归档分组'}
        onClick={() => setSectionOpen((v) => !v)}
        className="flex w-full items-center gap-1 rounded px-0.5 py-0.5 text-xs font-medium text-tertiary hover:text-primary"
      >
        {sectionOpen ? (
          <ChevronDown size={12} strokeWidth={1.75} aria-hidden />
        ) : (
          <ChevronRight size={12} strokeWidth={1.75} aria-hidden />
        )}
        <Archive size={12} strokeWidth={1.75} aria-hidden />
        已归档分组
        <span className="font-normal text-tertiary">({archivedGroups.length})</span>
      </button>
      {sectionOpen && (
        <ul className="flex flex-col gap-0.5 py-1">
          {archivedGroups.map((g) => {
            const selected = selectedArchivedGroupId === g.id;
            const colorCss = groupColorStyle(g.color);
            const dotStyle: CSSProperties = colorCss
              ? { backgroundColor: colorCss }
              : { backgroundColor: 'rgb(var(--text-tertiary))' };
            return (
              // 行结构与活跃组行（SortableGroupRow）同源镜像：整行满宽选择按钮
              // （选中高亮含全行），右侧操作绝对定位叠加层（点击结构上不冒泡成
              // 选中）——两分区行视觉/交互一致
              <li key={g.id} className="relative w-full rounded">
                <button
                  type="button"
                  aria-label={`查看归档分组 ${g.name}`}
                  aria-pressed={selected}
                  title={selected ? '取消归档分组过滤' : '查看该组归档任务'}
                  onClick={() => toggleSelect(g.id, selected)}
                  className={cn(
                    'flex min-h-7 w-full items-center gap-1.5 rounded border py-1.5 pl-1.5 pr-16 text-left text-[13px] leading-4 transition-colors',
                    selected
                      ? 'border-focus bg-surface-active text-primary'
                      : 'border-transparent text-secondary hover:bg-surface-2',
                  )}
                >
                  <i aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-[2px]" style={dotStyle} />
                  <span className="min-w-0 flex-1 truncate">{g.name}</span>
                </button>
                <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
                  <button
                    type="button"
                    aria-label={`取消归档 ${g.name}`}
                    onClick={() => void runUnarchive(g.id)}
                    className="shrink-0 rounded px-1 text-xs text-tertiary hover:text-primary"
                  >
                    取消归档
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
