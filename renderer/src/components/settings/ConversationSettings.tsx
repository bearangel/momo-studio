// renderer/src/components/settings/ConversationSettings.tsx
//
// 会话设置面板：全局工具调用上限配置（-1=无限 / 0=禁用 / N=上限）。
// 房间级配置可在房间头部徽标里单独覆盖。
// 挂载时通过 ipc.settings.getGlobal 拉取，保存时 ipc.settings.updateGlobal。
import { useState, useEffect, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import type { GlobalSettings } from '../../ipc/types';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

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
    return <div className="p-4 text-secondary text-sm">加载中...</div>;
  }

  return (
    <form onSubmit={handleSave} className="flex flex-col gap-4">
      <h2 className="text-base text-primary">会话设置</h2>

      <Input
        label="工具调用上限（全局默认）"
        type="number"
        value={maxToolCalls}
        onChange={(e) => setMaxToolCalls(Number(e.target.value))}
        min={-1}
        style={{ width: 128 }}
      />
      <p className="text-xs text-tertiary leading-relaxed">
        0 = 禁用工具调用（纯对话模式）<br />
        -1 = 无限制<br />
        正整数 = 最多调用 N 次<br />
        每个房间可单独覆盖此值。
      </p>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? '保存中...' : '保存'}
        </Button>
        {savedAt && <span className="text-xs text-status-success">已保存</span>}
      </div>
    </form>
  );
}
