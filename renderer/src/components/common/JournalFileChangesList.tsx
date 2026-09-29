// renderer/src/components/common/JournalFileChangesList.tsx
//
// 变更账本共享文件行渲染件（G1 spec §3.2）：逐文件行（rename 显示 old → new +
// 条数）+ 就地展开 DiffBlock。摘要计数行由宿主头行承担（chip 折叠头 / 任务
// 分区头形态不同），本组件只负责文件行——防双份计数与多态 prop。
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { JournalEntryView } from '../../ipc/types';
import { DiffBlock, groupByPath, type FileChangeGroup } from './JournalChangeViews';

export interface JournalFileChangesListProps {
  entries: JournalEntryView[];
  /** 宿主专属 testid（文件清单容器） */
  testId?: string;
}

export function JournalFileChangesList({ entries, testId }: JournalFileChangesListProps) {
  const groups = groupByPath(entries);
  return (
    <div data-testid={testId}>
      <div className="space-y-1">
        {groups.map((g) => (
          <FileRow key={g.path} group={g} />
        ))}
      </div>
    </div>
  );
}

function FileRow({ group }: { group: FileChangeGroup }): JSX.Element {
  const [open, setOpen] = useState(false);
  const renameFrom = group.first.oldPath;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1 py-0.5 text-left font-mono text-[11px] text-primary hover:text-accent-500"
      >
        <span className="shrink-0 text-tertiary" aria-hidden>
          {open ? (
            <ChevronDown size={11} strokeWidth={1.75} />
          ) : (
            <ChevronRight size={11} strokeWidth={1.75} />
          )}
        </span>
        <span className="truncate">
          {renameFrom !== null ? `${renameFrom} → ${group.path}` : group.path}
        </span>
        <span className="shrink-0 text-tertiary">{group.entries.length} 条</span>
      </button>
      {open && <DiffBlock beforeText={group.first.beforeText} afterText={group.last.afterText} />}
    </div>
  );
}
