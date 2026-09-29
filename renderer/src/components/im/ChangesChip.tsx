// renderer/src/components/im/ChangesChip.tsx
//
// 消息流「N 处变更」chip（v2.5 Task 8）——2026-09-28 回滚重构后为**纯查看**
// （rollback UI 重设计）：展开看逐文件 diff，不再提供任何撤回动作——
// 撤回统一走气泡右下角 TurnUndoButton（逐层、整组事务）。
//
// 挂载即懒查一次（终态消息的条目在挂载前已全部落账）；失败 warn 留痕不弹错。
// workspaceId null（旧数据）/ 查询失败 / 空账 → 不渲染。
import { useEffect, useState } from 'react';
import { FileDiff } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { ImMessage, JournalEntryView } from '../../ipc/types';
import { FileChangeGroup, groupByPath } from '../common/JournalChangeViews';
import { JournalFileChangesList } from '../common/JournalFileChangesList';

export interface ChangesChipProps {
  message: ImMessage;
}

export function ChangesChip({ message }: ChangesChipProps) {
  const [entries, setEntries] = useState<JournalEntryView[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (message.workspaceId === null || message.streamSessionId === null) return;
    ipc.journal
      .list({ workspaceId: message.workspaceId, streamSessionId: message.streamSessionId })
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch((err: unknown) => {
        console.warn('[ChangesChip] journal.list 查询失败', err);
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [message.workspaceId, message.streamSessionId]);

  if (entries === null || entries.length === 0) return null;

  const fileGroups: FileChangeGroup[] = groupByPath(entries);

  return (
    <div className="mt-1 rounded border border-subtle bg-surface-2" data-testid="changes-chip">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left text-[11px] text-secondary hover:text-primary"
      >
        <FileDiff size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
        {entries.length} 处变更 · {fileGroups.length} 个文件
      </button>
      {open && (
        <div className="space-y-1 border-t border-subtle px-2 py-1.5">
          <JournalFileChangesList entries={entries} />
        </div>
      )}
    </div>
  );
}
