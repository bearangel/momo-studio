// renderer/src/components/task-board/TaskChangesView.tsx
//
// 任务详情·变更查看（2026-09-30 预览确认后新增）：纯只读分区——「N 处变更 ·
// M 个文件」+ 逐文件 diff，视觉与气泡 ChangesChip 同款（头行样式一致，展开体
// 复用同一 JournalFileChangesList，效果单源不漂移）。
//
// 与 chip 的数据切面差异：chip 按 streamSessionId 查单条消息流的账目；本组件
// 按 taskId 查任务全部条目（多轮累计）。无回滚动作——回滚统一走气泡右下角
// TurnUndoButton（仅最后气泡渲染，任务面板不感知回滚资格）。
//
// 空账 / 查询失败 → 不渲染（与 chip 同语义，不占位）。
import { useEffect, useState } from 'react';
import { FileDiff } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { JournalEntryView } from '../../ipc/types';
import { groupByPath } from '../common/JournalChangeViews';
import { JournalFileChangesList } from '../common/JournalFileChangesList';

export interface TaskChangesViewProps {
  workspaceId: string;
  taskId: string;
}

export function TaskChangesView({ workspaceId, taskId }: TaskChangesViewProps) {
  const [entries, setEntries] = useState<JournalEntryView[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ipc.journal
      .list({ workspaceId, taskId })
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch((err: unknown) => {
        console.warn('[TaskChangesView] journal.list 查询失败', err);
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, taskId]);

  if (entries === null || entries.length === 0) return null;

  return (
    <div className="rounded border border-subtle bg-surface-2" data-testid="task-changes-view">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left text-[11px] text-secondary hover:text-primary"
      >
        <FileDiff size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
        {entries.length} 处变更 · {groupByPath(entries).length} 个文件
      </button>
      {open && (
        <div className="space-y-1 border-t border-subtle px-2 py-1.5">
          <JournalFileChangesList entries={entries} />
        </div>
      )}
    </div>
  );
}
