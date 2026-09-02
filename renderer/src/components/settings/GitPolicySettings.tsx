// renderer/src/components/settings/GitPolicySettings.tsx
//
// Workspace 级 Git Policy 配置面板：
//   - 允许 agent commit 开关
//   - 默认分支 / fallback 分支模板
//   - commit message 校验级别（strict / warning / none）
//   - commit pattern 列表（增删）
//   - 实时预览：输入 commit message 立即显示是否合规
//
// 编辑的是本地 draft，"保存"才写回主进程。预览校验复用与 electron 端
// commit-validator 等价的纯逻辑（命中任一 pattern 即合规），避免每次按键都走 IPC。
import { useEffect, useState, type FormEvent } from 'react';
import { X, CircleCheck, CircleX } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { type GitPolicy, type CommitPattern, type CommitValidation } from '../../ipc/types';
import { defaultGitPolicy } from '../../lib/git-policy';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Checkbox } from '../ui/Checkbox';
import { cn } from '../../lib/cn';

interface Props {
  workspaceId: string;
}

const VALIDATION_OPTIONS: Array<{ value: CommitValidation; label: string; desc: string }> = [
  { value: 'strict', label: 'strict', desc: '不合规直接拒绝提交' },
  { value: 'warning', label: 'warning', desc: '不合规仅告警，仍允许提交' },
  { value: 'none', label: 'none', desc: '不校验' },
];

/** 与 electron 端 validateCommitMessage 等价的纯函数，供实时预览复用。 */
function previewValidate(message: string, policy: GitPolicy): { valid: boolean; error?: string } {
  if (policy.commitMessage.validation === 'none' || message.trim() === '') {
    return { valid: true };
  }
  for (const p of policy.commitMessage.patterns) {
    let re: RegExp;
    try {
      re = new RegExp(p.regex);
    } catch {
      continue;
    }
    if (re.test(message)) return { valid: true };
  }
  const expected = policy.commitMessage.patterns.map((p) => p.example).join(' 或 ');
  return { valid: false, error: `不符合规则。期望格式: ${expected}` };
}

export function GitPolicySettings({ workspaceId }: Props) {
  const [draft, setDraft] = useState<GitPolicy | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const p = await ipc.gitPolicy.get(workspaceId);
        if (!cancelled) {
          setDraft(p);
          setDirty(false);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // patch helper：更新 draft 的任意路径并标记 dirty
  function update(patch: (p: GitPolicy) => void): void {
    setDraft((prev) => {
      if (!prev) return prev;
      const next: GitPolicy = JSON.parse(JSON.stringify(prev)) as GitPolicy;
      patch(next);
      return next;
    });
    setDirty(true);
  }

  async function handleSave(): Promise<void> {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await ipc.gitPolicy.set(workspaceId, draft);
      setDirty(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleReset(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const def = defaultGitPolicy();
      await ipc.gitPolicy.set(workspaceId, def);
      setDraft(def);
      setDirty(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!draft) {
    return <div className="text-sm text-tertiary py-4">加载 Git Policy…</div>;
  }

  const previewResult = previewValidate(preview, draft);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-primary">Git Policy</h3>
          <p className="text-xs text-tertiary">约束 agent 在本工作空间的 commit 行为</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => void handleReset()} disabled={saving}>
            恢复默认
          </Button>
          <Button size="sm" onClick={() => void handleSave()} disabled={saving || !dirty}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>

      {error && <div className="text-sm text-status-error">{error}</div>}

      {/* 基础开关 */}
      <Checkbox
        label="允许 agent 自动 commit"
        checked={draft.allowAgentCommits}
        onChange={(e) => update((p) => (p.allowAgentCommits = e.target.checked))}
      />

      {/* 分支配置 */}
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="默认分支"
          value={draft.defaultBranch}
          onChange={(e) => update((p) => (p.defaultBranch = e.target.value))}
        />
        <Input
          label="Fallback 分支模板"
          value={draft.fallbackBranchPattern}
          onChange={(e) => update((p) => (p.fallbackBranchPattern = e.target.value))}
        />
      </div>

      {/* 校验级别 */}
      <Select
        label="Commit 校验级别"
        value={draft.commitMessage.validation}
        onChange={(e) =>
          update((p) => (p.commitMessage.validation = e.target.value as CommitValidation))
        }
      >
        {VALIDATION_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label} — {o.desc}
          </option>
        ))}
      </Select>

      {/* Pattern 列表 */}
      <PatternEditor
        patterns={draft.commitMessage.patterns}
        onChange={(patterns) => update((p) => (p.commitMessage.patterns = patterns))}
      />

      {/* 实时预览 */}
      <div className="flex flex-col gap-1.5 border-t border-subtle pt-3">
        <label className="text-sm text-secondary">实时预览</label>
        <textarea
          value={preview}
          onChange={(e) => setPreview(e.target.value)}
          rows={2}
          placeholder="输入 commit message 测试是否合规…"
          className="px-3 py-2 rounded-md border border-subtle bg-surface-2 text-primary focus:border-focus focus:outline-none text-sm"
        />
        {preview.trim() !== '' && (
          <div
            className={cn(
              'text-xs px-2 py-1 rounded inline-flex items-center gap-1 w-fit',
              previewResult.valid
                ? 'bg-status-success-tint text-status-success'
                : 'bg-status-error-tint text-status-error',
            )}
          >
            {previewResult.valid ? (
              <>
                <CircleCheck size={12} strokeWidth={1.75} aria-hidden />
                合规
              </>
            ) : (
              <>
                <CircleX size={12} strokeWidth={1.75} aria-hidden />
                {previewResult.error ?? '不合规'}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

interface PatternEditorProps {
  patterns: CommitPattern[];
  onChange: (patterns: CommitPattern[]) => void;
}

function PatternEditor({ patterns, onChange }: PatternEditorProps) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<CommitPattern>({ code: '', name: '', regex: '', example: '' });

  function commitAdd(e: FormEvent): void {
    e.preventDefault();
    if (!form.code.trim() || !form.regex.trim()) return;
    onChange([...patterns, { ...form }]);
    setForm({ code: '', name: '', regex: '', example: '' });
    setAdding(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-sm text-secondary">Commit Patterns（命中任一即合规）</label>
        <Button size="sm" variant="ghost" onClick={() => setAdding((v) => !v)}>
          {adding ? '取消' : '+ 添加'}
        </Button>
      </div>

      {patterns.length === 0 && !adding && (
        <div className="text-xs text-disabled">（无 pattern，strict 模式下任何 commit 都会被拒）</div>
      )}

      <ul className="flex flex-col gap-1.5">
        {patterns.map((p, idx) => (
          <li
            key={`${p.code}-${idx}`}
            className="flex items-start gap-2 px-2 py-1.5 rounded border border-subtle bg-surface-2"
          >
            <code className="text-xs text-accent-600 dark:text-accent-300 mt-0.5 shrink-0">{p.code}</code>
            <div className="flex-1 min-w-0 text-xs">
              <div className="text-primary">{p.name}</div>
              <div className="text-tertiary font-mono truncate">{p.regex}</div>
              <div className="text-tertiary">例：{p.example}</div>
            </div>
            <button
              type="button"
              className="text-xs text-tertiary hover:text-status-error shrink-0 inline-flex items-center"
              onClick={() => onChange(patterns.filter((_, i) => i !== idx))}
              aria-label="删除 pattern"
            >
              <X size={12} strokeWidth={1.75} aria-hidden />
            </button>
          </li>
        ))}
      </ul>

      {adding && (
        <form onSubmit={commitAdd} className="grid grid-cols-2 gap-2 p-2 rounded border border-subtle bg-surface-2">
          <Input
            label="代号 code"
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            placeholder="S"
          />
          <Input
            label="名称"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="故事任务"
          />
          <Input
            label="正则 regex"
            value={form.regex}
            onChange={(e) => setForm((f) => ({ ...f, regex: e.target.value }))}
            placeholder="^S\d{8}\s+.+"
          />
          <Input
            label="示例"
            value={form.example}
            onChange={(e) => setForm((f) => ({ ...f, example: e.target.value }))}
            placeholder="S12345678 描述"
          />
          <div className="col-span-2 flex justify-end">
            <Button size="sm" type="submit" disabled={!form.code.trim() || !form.regex.trim()}>
              确认添加
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
