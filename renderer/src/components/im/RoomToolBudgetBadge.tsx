// renderer/src/components/im/RoomToolBudgetBadge.tsx
//
// 房间工具调用上限徽标：显示当前房间的有效工具调用上限。
// 点击打开 popup 修改面板（继承全局 / 禁用 / 无限制 / 自定义）。
// 需同时加载房间级配置（getRoom）和全局默认（getGlobal）以显示"继承全局 (N次)"。
//
// 有效值优先级：room_settings.max_tool_calls（非 null）→ global_settings.maxToolCalls。
// 徽标文案：-1 → "∞"，0 → "禁用"，N → "N次"。
import { useState, useEffect } from 'react';
import { ipc } from '../../ipc/client';
import type { GlobalSettings, SessionSettings } from '../../ipc/types';

interface Props {
  roomId: string;
}

type Choice = 'inherit' | 'disabled' | 'unlimited' | 'custom';

export function RoomToolBudgetBadge({ roomId }: Props) {
  const [roomValue, setRoomValue] = useState<number | null>(null);
  const [globalDefault, setGlobalDefault] = useState(10);
  const [editing, setEditing] = useState(false);
  // popup 内的草稿状态，保存时才提交
  const [draftChoice, setDraftChoice] = useState<Choice>('inherit');
  const [draftCustom, setDraftCustom] = useState('10');
  const [saving, setSaving] = useState(false);

  // 房间切换时重新加载
  useEffect(() => {
    setRoomValue(null);
    setEditing(false);
    void ipc.settings.getSession(roomId).then((s: SessionSettings) => {
      setRoomValue(s.maxToolCalls);
    });
    void ipc.settings.getGlobal().then((s: GlobalSettings) => {
      setGlobalDefault(s.maxToolCalls);
    });
  }, [roomId]);

  const effective = roomValue ?? globalDefault;
  const badgeLabel = effective === -1 ? '∞' : effective === 0 ? '禁用' : `${effective}次`;

  /** 把当前 roomValue 映射成 popup 打开时的初始 choice */
  const choiceFromValue = (v: number | null): Choice => {
    if (v === null) return 'inherit';
    if (v === 0) return 'disabled';
    if (v === -1) return 'unlimited';
    return 'custom';
  };

  const openPopup = () => {
    const c = choiceFromValue(roomValue);
    setDraftChoice(c);
    setDraftCustom(String(c === 'custom' ? roomValue : globalDefault));
    setEditing(true);
  };

  const handleSave = async () => {
    const val: number | null =
      draftChoice === 'inherit'
        ? null
        : draftChoice === 'disabled'
          ? 0
          : draftChoice === 'unlimited'
            ? -1
            : Number(draftCustom);
    setSaving(true);
    try {
      const updated = await ipc.settings.updateSession(roomId, { maxToolCalls: val });
      setRoomValue(updated.maxToolCalls);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={openPopup}
        title="工具调用上限"
        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-neutral-400 hover:bg-bg-tertiary hover:text-neutral-200"
      >
        <span>🔧</span>
        <span>{badgeLabel}</span>
      </button>

      {editing && (
        <>
          {/* 透明 backdrop：点击关闭 popup */}
          <div className="fixed inset-0 z-40" onClick={() => setEditing(false)} data-testid="badge-backdrop" />
          <div className="absolute top-full right-0 mt-1 z-50 bg-bg-tertiary border border-border-subtle rounded-lg p-3 shadow-xl"
            style={{ minWidth: 200 }}>
            <div className="text-xs text-neutral-500 mb-2">工具调用上限</div>
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-xs text-neutral-300 cursor-pointer">
                <input type="radio" checked={draftChoice === 'inherit'}
                  onChange={() => setDraftChoice('inherit')} />
                继承全局 ({globalDefault}次)
              </label>
              <label className="flex items-center gap-2 text-xs text-neutral-300 cursor-pointer">
                <input type="radio" checked={draftChoice === 'disabled'}
                  onChange={() => setDraftChoice('disabled')} />
                禁用工具 (0)
              </label>
              <label className="flex items-center gap-2 text-xs text-neutral-300 cursor-pointer">
                <input type="radio" checked={draftChoice === 'unlimited'}
                  onChange={() => setDraftChoice('unlimited')} />
                无限制 (∞)
              </label>
              <label className="flex items-center gap-2 text-xs text-neutral-300">
                <input type="radio" checked={draftChoice === 'custom'}
                  onChange={() => {
                    setDraftChoice('custom');
                    if (draftCustom === '') setDraftCustom(String(globalDefault));
                  }} />
                自定义：
                <input type="number" value={draftCustom} min={0}
                  disabled={draftChoice !== 'custom'}
                  onChange={(e) => setDraftCustom(e.target.value)}
                  style={{ width: 60 }}
                  className="bg-bg-secondary border border-border-subtle rounded px-1.5 py-0.5 text-neutral-100 disabled:opacity-40" />
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-3">
              <button type="button" onClick={() => setEditing(false)}
                className="text-xs px-2 py-1 text-neutral-400 hover:text-neutral-200">取消</button>
              <button type="button" onClick={handleSave} disabled={saving}
                className="text-xs px-3 py-1 rounded bg-accent-blue text-white disabled:opacity-50">
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
