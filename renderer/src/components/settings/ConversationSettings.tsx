// renderer/src/components/settings/ConversationSettings.tsx
//
// 会话设置面板：全局工具调用上限配置（留空=无限 -1 / 0=禁用 / N=上限）
// + 变更账本保留配额（journalQuotaMb，v2.5）。
// 工具上限输入仅接受非负整数——键入负号/小数点/非数字即时剥除（2026-11-09
// 起默认无限，无限=留空，不再依赖键入 -1）。
// 房间级配置可在房间头部徽标里单独覆盖。
// 挂载时通过 ipc.settings.getGlobal 拉取，保存时 ipc.settings.updateGlobal。
// P3 E1：追加「任务」小节——返工上限（失焦保存，主进程夹取后回显）。
import { useState, useEffect, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import type { GlobalSettings } from '../../ipc/types';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

/** 仅保留数字字符（负号/小数点/其他全剥除） */
function sanitizeDigits(raw: string): string {
  return raw.replace(/[^\d]/g, '');
}

/**
 * 任务小节（P3 E1）：返工上限数字输入（1-50 缺省 10）——失焦保存，
 * 主进程夹取后回显归一化值（HubSettingsPanel 委派节同款交互）。
 * 与上方「保存」按钮相互独立（各自 IPC 通道，互不阻塞）。
 */
function TaskMaxRunsSection() {
  const [draft, setDraft] = useState('');
  const [current, setCurrent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void ipc.task
      .getMaxRuns()
      .then((n) => {
        setCurrent(n);
        setDraft(String(n));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const save = (raw: string): void => {
    if (current === null) return; // 未加载完成不落库
    const trimmed = raw.trim();
    if (trimmed === '') {
      setDraft(String(current)); // 清空 = 放弃修改，回退当前生效值
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n === current) return;
    void ipc.task
      .setMaxRuns(n)
      .then((normalized) => {
        setCurrent(normalized);
        setDraft(String(normalized));
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="flex flex-col gap-2 border-t border-subtle pt-4">
      <h3 className="text-sm font-medium text-primary">任务</h3>
      <Input
        label="返工上限"
        type="number"
        min={1}
        max={50}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => save(e.target.value)}
        placeholder="10"
        style={{ width: 128 }}
      />
      <p className="text-xs text-tertiary leading-relaxed">
        同一任务最大执行尝试数（含返工），超出转失败。<br />
        范围 1-50，默认 10；修改即时保存。
      </p>
      {error !== null && (
        <p className="text-xs text-status-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function ConversationSettings() {
  // '' = 无限（存 -1）；草稿为字符串以支持逐字符 sanitize 与留空语义
  const [maxToolCallsStr, setMaxToolCallsStr] = useState('');
  // v2.5 变更账本配额（MB）；undefined = 未配置（留空，走主进程默认 200）
  const [journalQuotaMb, setJournalQuotaMb] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);

  useEffect(() => {
    void ipc.settings.getGlobal().then((s: GlobalSettings) => {
      setMaxToolCallsStr(s.maxToolCalls === -1 ? '' : String(s.maxToolCalls));
      setJournalQuotaMb(s.journalQuotaMb);
      setLoading(false);
    });
  }, []);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await ipc.settings.updateGlobal({
        maxToolCalls: maxToolCallsStr === '' ? -1 : Number(maxToolCallsStr),
        ...(journalQuotaMb !== undefined ? { journalQuotaMb } : {}),
      });
      setMaxToolCallsStr(updated.maxToolCalls === -1 ? '' : String(updated.maxToolCalls));
      setJournalQuotaMb(updated.journalQuotaMb);
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
    <div className="flex flex-col gap-4">
      <form onSubmit={handleSave} className="flex flex-col gap-4">
        <h2 className="text-base text-primary">会话设置</h2>

        <Input
          label="工具调用上限（全局默认）"
          type="text"
          inputMode="numeric"
          value={maxToolCallsStr}
          onChange={(e) => {
            const next = sanitizeDigits(e.target.value);
            // sanitize 结果与受控态同值时 React 不重渲染，需即时回写 DOM 才能剥掉负号等非法字符
            if (e.target.value !== next) e.target.value = next;
            setMaxToolCallsStr(next);
          }}
          placeholder="无限"
          style={{ width: 128 }}
        />
        <p className="text-xs text-tertiary leading-relaxed">
          留空 = 无限制（默认）<br />
          0 = 禁用工具调用（纯对话模式）<br />
          正整数 = 最多调用 N 次<br />
          每个房间可单独覆盖此值。
        </p>

        <Input
          label="变更保留（MB）"
          type="number"
          value={journalQuotaMb ?? ''}
          onChange={(e) =>
            setJournalQuotaMb(e.target.value === '' ? undefined : Number(e.target.value))
          }
          min={50}
          placeholder="200"
          style={{ width: 128 }}
        />
        <p className="text-xs text-tertiary leading-relaxed">
          agent 文件变更账本的磁盘占用上限（按工作空间计量）<br />
          超限后按最旧任务组滚动清理；留空 = 默认 200。
        </p>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
          {savedAt && <span className="text-xs text-status-success">已保存</span>}
        </div>
      </form>
      <TaskMaxRunsSection />
    </div>
  );
}
