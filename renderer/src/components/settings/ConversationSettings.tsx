// renderer/src/components/settings/ConversationSettings.tsx
//
// 会话设置面板：全局工具调用上限配置（-1=无限 / 0=禁用 / N=上限）。
// 房间级配置可在房间头部徽标里单独覆盖。
// 挂载时通过 ipc.settings.getGlobal 拉取，保存时 ipc.settings.updateGlobal。
import { useState, useEffect, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import type { GlobalSettings } from '../../ipc/types';

export function ConversationSettings() {
  const [maxToolCalls, setMaxToolCalls] = useState(10);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);

  useEffect(() => {
    void ipc.settings.getGlobal().then((s: GlobalSettings) => {
      setMaxToolCalls(s.maxToolCalls);
      setLoading(false);
    });
  }, []);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await ipc.settings.updateGlobal({ maxToolCalls });
      setMaxToolCalls(updated.maxToolCalls);
      setSavedAt(true);
      setTimeout(() => setSavedAt(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-4 text-neutral-400 text-sm">加载中...</div>;
  }

  return (
    <form onSubmit={handleSave} className="flex flex-col gap-4">
      <h2 className="text-neutral-100 text-base">会话设置</h2>

      <label className="text-sm text-neutral-300 flex flex-col gap-1">
        工具调用上限（全局默认）
        <input
          type="number"
          value={maxToolCalls}
          onChange={(e) => setMaxToolCalls(Number(e.target.value))}
          min={-1}
          style={{ width: 128 }}
          className="bg-bg-tertiary border border-border-subtle rounded px-2 py-1 text-neutral-100"
        />
      </label>
      <p className="text-xs text-neutral-500 leading-relaxed">
        0 = 禁用工具调用（纯对话模式）<br />
        -1 = 无限制<br />
        正整数 = 最多调用 N 次<br />
        每个房间可单独覆盖此值。
      </p>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="text-sm px-4 py-1.5 rounded bg-accent-blue text-white disabled:opacity-50"
        >
          {saving ? '保存中...' : '保存'}
        </button>
        {savedAt && <span className="text-xs text-green-400">已保存</span>}
      </div>
    </form>
  );
}
