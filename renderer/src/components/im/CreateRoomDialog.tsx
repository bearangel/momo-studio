// 新建房间对话框：名称 + 类型（私聊/群组）+ 邀请对象
import { useState, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** 可邀请对象（当前 workspace 的 agent bot userId 列表） */
  inviteCandidates: { userId: string; displayName: string }[];
}

export function CreateRoomDialog({ open, onClose, onCreated, inviteCandidates }: Props) {
  const [name, setName] = useState('');
  const [isDirect, setIsDirect] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  if (!open) return null;

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await ipc.im.createRoom({ name: name.trim(), isDirect, inviteUserIds: selected });
      onCreated();
      onClose();
      setName(''); setSelected([]); setIsDirect(false);
    } catch (err) {
      alert(`创建失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}
        className="bg-bg-secondary border border-border-subtle rounded-lg p-6 w-[380px] flex flex-col gap-3">
        <h3 className="text-neutral-100 text-base">新建房间</h3>
        <label className="text-xs text-neutral-400">房间名
          <input value={name} onChange={(e) => setName(e.target.value)} required
            className="mt-1 w-full bg-bg-tertiary border border-border-subtle rounded px-2 py-1 text-sm text-neutral-100" />
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-300">
          <input type="checkbox" checked={isDirect} onChange={(e) => setIsDirect(e.target.checked)} />
          私聊（单人对单）
        </label>
        <div className="text-xs text-neutral-400">邀请对象（当前 workspace 的 agent）
          <div className="mt-1 flex flex-col gap-1 max-h-40 overflow-auto">
            {inviteCandidates.length === 0 && <span className="text-neutral-500">暂无可邀请 agent</span>}
            {inviteCandidates.map((c) => (
              <label key={c.userId} className="flex items-center gap-2 text-sm text-neutral-300">
                <input type="checkbox" checked={selected.includes(c.userId)} onChange={() => toggle(c.userId)} />
                {c.displayName}
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-2">
          <button type="button" onClick={onClose} className="text-xs px-3 py-1 text-neutral-400 hover:text-neutral-200">取消</button>
          <button type="submit" className="text-xs px-3 py-1 rounded bg-accent-blue text-white">创建</button>
        </div>
      </form>
    </div>
  );
}
