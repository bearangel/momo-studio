// renderer/src/components/im/MoveToGroupDialog.tsx
//
// 「移动到分组」弹窗（spec 2026-10-22 §4.4）：分组 radio（含「未分组」）+ 内联新建分组。
// 提交：新名非空时先 sessionGroup.create 再 moveToGroup（新名优先于上方选择）；
// 成功后 refreshSessionList（主进程全局序重排）+ onClose。
import { useEffect, useState, type FormEvent } from 'react';
import { FolderPlus } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useSessionStore } from '../../stores/session.store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import type { SessionGroupRow, SessionSummary } from '../../ipc/types';

interface Props {
  session: SessionSummary;
  workspaceId: string;
  onClose: () => void;
}

/** radio 哨兵值：目标「未分组」（moveToGroup(null)） */
const UNGROUPED = '__ungrouped__';

export function MoveToGroupDialog({ session, workspaceId, onClose }: Props) {
  const refreshSessionList = useSessionStore((s) => s.refreshSessionList);
  const [groups, setGroups] = useState<SessionGroupRow[]>([]);
  const [selected, setSelected] = useState<string>(session.groupId ?? UNGROUPED);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void ipc.sessionGroup.list(workspaceId).then(setGroups).catch((e: Error) => setError(e.message));
  }, [workspaceId]);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let target = selected === UNGROUPED ? null : selected;
      const name = newName.trim();
      if (name !== '') {
        const created = await ipc.sessionGroup.create(workspaceId, name);
        target = created.id;
      }
      await ipc.session.moveToGroup(session.id, target);
      refreshSessionList();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`移动「${session.title}」到分组`} width={360}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <fieldset className="flex flex-col gap-1.5">
          {groups.map((g) => (
            <label
              key={g.id}
              className="flex items-center gap-2 text-sm text-secondary px-2 py-1.5 rounded hover:bg-surface-3"
            >
              <input
                type="radio"
                name="move-group"
                aria-label={g.name}
                checked={selected === g.id && newName === ''}
                onChange={() => {
                  setSelected(g.id);
                  setNewName('');
                }}
              />
              <span>{g.name}</span>
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm text-secondary px-2 py-1.5 rounded hover:bg-surface-3">
            <input
              type="radio"
              name="move-group"
              aria-label="未分组"
              checked={selected === UNGROUPED && newName === ''}
              onChange={() => {
                setSelected(UNGROUPED);
                setNewName('');
              }}
            />
            <span>未分组</span>
          </label>
        </fieldset>
        <div className="border-t border-subtle pt-2 flex items-center gap-2">
          <FolderPlus size={14} strokeWidth={1.75} className="text-tertiary shrink-0" aria-hidden />
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="或新建分组（优先于上方选择）"
            aria-label="新建分组名称"
          />
        </div>
        {error && (
          <div className="text-status-error text-sm" role="alert">
            {error}
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" type="button" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? '移动中…' : '移动'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
