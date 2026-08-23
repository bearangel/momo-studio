// 新建房间对话框：名称 + 邀请对象 + 工具调用上限
//
// v2.0 P1 Task 9：底层走 session:create（纯 SQLite，memberAssignmentIds 为
// assignment 实例）。v1.4 的 isDirect（Matrix 私聊标记）无 session 等价概念，随通道退役。
// 创建会话后，若选择非"继承全局"，调用 ipc.settings.updateSession 写入会话级配置。
import { useState, useEffect, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { GlobalSettings } from '../../ipc/types';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** 可邀请对象（当前 workspace 的 agent assignment 列表） */
  inviteCandidates: { assignmentId: string; displayName: string }[];
}

type ToolLimitChoice = 'inherit' | 'disabled' | 'unlimited' | 'custom';

export function CreateRoomDialog({ open, onClose, onCreated, inviteCandidates }: Props) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [toolChoice, setToolChoice] = useState<ToolLimitChoice>('inherit');
  const [customValue, setCustomValue] = useState('10');
  const [globalDefault, setGlobalDefault] = useState(10);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  // 拉取全局默认值，用于"继承全局 (N次)"显示
  useEffect(() => {
    if (!open) return;
    void ipc.settings.getGlobal().then((s: GlobalSettings) => {
      setGlobalDefault(s.maxToolCalls);
      setCustomValue(String(s.maxToolCalls));
    });
  }, [open]);

  if (!open) return null;

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  /** 把选择映射成要写入的 maxToolCalls（null=继承全局，不写入） */
  const resolveMaxToolCalls = (): number | null => {
    switch (toolChoice) {
      case 'inherit':
        return null;
      case 'disabled':
        return 0;
      case 'unlimited':
        return -1;
      case 'custom':
        return Number(customValue);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (!activeWorkspaceId) return;
    const maxToolCalls = resolveMaxToolCalls();
    try {
      const session = await ipc.session.create({
        workspaceId: activeWorkspaceId,
        title: name.trim(),
        memberAssignmentIds: selected,
        kind: 'chat',
      });
      // 非继承全局时，写入会话级配置。
      // 会话已创建成功，settings 写入失败不应阻断流程（会话客观存在）。
      if (maxToolCalls !== null) {
        try {
          await ipc.settings.updateSession(session.id, { maxToolCalls });
        } catch {
          // settings 写入失败仅告警，不阻断会话创建流程
        }
      }
      onCreated();
      onClose();
      setName(''); setSelected([]);
      setToolChoice('inherit');
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
        <div className="text-xs text-neutral-400">邀请对象（当前 workspace 的 agent）
          <div className="mt-1 flex flex-col gap-1 max-h-40 overflow-auto">
            {inviteCandidates.length === 0 && <span className="text-neutral-500">暂无可邀请 agent</span>}
            {inviteCandidates.map((c) => (
              <label key={c.assignmentId} className="flex items-center gap-2 text-sm text-neutral-300">
                <input type="checkbox" checked={selected.includes(c.assignmentId)} onChange={() => toggle(c.assignmentId)} />
                {c.displayName}
              </label>
            ))}
          </div>
        </div>
        <fieldset className="text-xs text-neutral-400 border-t border-border-subtle pt-2">
          <legend className="mb-1">工具调用上限</legend>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm text-neutral-300">
              <input type="radio" name="toollimit" checked={toolChoice === 'inherit'}
                onChange={() => setToolChoice('inherit')} />
              继承全局 ({globalDefault}次)
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-300">
              <input type="radio" name="toollimit" checked={toolChoice === 'disabled'}
                onChange={() => setToolChoice('disabled')} />
              禁用工具 (0)
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-300">
              <input type="radio" name="toollimit" checked={toolChoice === 'unlimited'}
                onChange={() => setToolChoice('unlimited')} />
              无限制 (∞)
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-300">
              <input type="radio" name="toollimit" checked={toolChoice === 'custom'}
                onChange={() => setToolChoice('custom')} />
              自定义：
              <input type="number" value={customValue} min={0}
                disabled={toolChoice !== 'custom'}
                onChange={(e) => setCustomValue(e.target.value)}
                style={{ width: 64 }}
                className="bg-bg-tertiary border border-border-subtle rounded px-2 py-0.5 text-neutral-100 disabled:opacity-40" />
            </label>
          </div>
        </fieldset>
        <div className="flex justify-end gap-2 mt-2">
          <button type="button" onClick={onClose} className="text-xs px-3 py-1 text-neutral-400 hover:text-neutral-200">取消</button>
          <button type="submit" className="text-xs px-3 py-1 rounded bg-accent-blue text-white">创建</button>
        </div>
      </form>
    </div>
  );
}
