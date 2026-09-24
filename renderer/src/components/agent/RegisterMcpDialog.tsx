// renderer/src/components/agent/RegisterMcpDialog.tsx
// P2.4：快速创建 MCP（spec §4，D7 原地升级——文件/组件名保留）。
// 传输二态（Segmented）：本地 stdio（名称/命令/参数一行一个/高级：env+cwd）；
// 远程 streamable HTTP（名称/URL https/高级：headers）。切换清空对方态字段。
// env/headers 用 KeyValueRows（D5）；同名二段确认（D2：预检命中 → 警示条 +
// 「确认覆盖」，改任一字段重置）。提交 → resource:registerMcp → mcp:start →
// onSuccess 刷新 + onClose。
// P2.5 Task 3：edit 模式（spec §3.4/D4）——mount 经 getMcpEditView 预填全
// 字段，提交分流 updateMcpEntry（保 id/source/installed_at 的 UPDATE）。
// name 是 agent 引用键，编辑不可改；编辑语义即覆盖自身，跳过同名二段确认。
// version '1.0.0' 是 electron 缺省值不回显（提交省略→主进程回落 1.0.0，
// 与非缺省回显回传恰好闭环，避免全字段 UPDATE 静默降级）。
import { useEffect, useState, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Segmented } from '../ui/Segmented';
import { KeyValueRows, type KVRow } from '../ui/KeyValueRows';

type Transport = 'stdio' | 'http';

const TRANSPORT_OPTIONS = [
  { value: 'stdio' as const, label: '本地（stdio）' },
  { value: 'http' as const, label: '远程（HTTP）' },
];

/** 行数组 → Record：key/value 任一为空的行静默剔除（spec §4.2） */
function rowsToRecord(rows: KVRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k && r.value !== '') out[k] = r.value;
  }
  return out;
}

/** Record → 行数组（编辑预填用）：空对象给一行空行——与初始态一致 */
function recordToRows(rec: Record<string, string>): KVRow[] {
  const entries = Object.entries(rec);
  if (entries.length === 0) return [{ key: '', value: '' }];
  return entries.map(([key, value]) => ({ key, value }));
}

export function RegisterMcpDialog({
  onClose,
  onSuccess,
  edit,
}: {
  onClose: () => void;
  onSuccess: () => void;
  /** 编辑模式：name 指向已注册 MCP（mount 拉视图预填；名称锁定） */
  edit?: { name: string };
}) {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const [transport, setTransport] = useState<Transport>('stdio');
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [cwd, setCwd] = useState('');
  const [url, setUrl] = useState('');
  const [envRows, setEnvRows] = useState<KVRow[]>([{ key: '', value: '' }]);
  const [headerRows, setHeaderRows] = useState<KVRow[]>([{ key: '', value: '' }]);
  // 同名二段确认态：null=一段；命中后存同名（警示条展示 + 按钮变「确认覆盖」）
  const [overwriteWarning, setOverwriteWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 编辑视图加载中（mount 起，视图就位或失败止——期间表单体渲染占位）
  const [loadingEdit, setLoadingEdit] = useState<boolean>(Boolean(edit));

  // edit 模式 mount 预填：getMcpEditView 全字段回显（cancelled 防卸载后 setState）
  useEffect(() => {
    if (!edit) return;
    let cancelled = false;
    ipc.resource
      .getMcpEditView(edit.name)
      .then((view) => {
        if (cancelled) return;
        setTransport(view.transport === 'streamable_http' ? 'http' : 'stdio');
        setName(view.name);
        // 缺省版本 '1.0.0' 不回显——提交省略后主进程回落同值，闭环不降级
        setVersion(view.version === '1.0.0' ? '' : view.version);
        setCommand(view.command);
        setArgsText(view.args.join('\n'));
        setCwd(view.cwd ?? '');
        setUrl(view.url ?? '');
        setEnvRows(recordToRows(view.env));
        setHeaderRows(recordToRows(view.headers));
      })
      .catch((err) => {
        if (!cancelled) setError(`读取 MCP 配置失败：${(err as Error).message}`);
      })
      .finally(() => {
        if (!cancelled) setLoadingEdit(false);
      });
    return () => {
      cancelled = true;
    };
  }, [edit]);

  const urlInvalid = transport === 'http' && url.trim() !== '' && !url.trim().startsWith('https://');
  const valid =
    transport === 'stdio'
      ? name.trim() !== '' && command.trim() !== ''
      : name.trim() !== '' && url.trim().startsWith('https://');

  const switchTransport = (next: Transport): void => {
    if (next === transport) return;
    setTransport(next);
    setOverwriteWarning(null);
    // 清空对方态专属字段（防脏数据残留误提交，spec §4.1）
    if (next === 'http') {
      setCommand(''); setArgsText(''); setCwd(''); setEnvRows([{ key: '', value: '' }]);
    } else {
      setUrl(''); setHeaderRows([{ key: '', value: '' }]);
    }
  };

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!valid) return;
    const trimmedName = name.trim();
    if (!activeWorkspaceId) { setError('未激活的工作空间，无法启动 MCP'); return; }
    // 一段态先做同名预检（与 JSON 导入流同手法）；list 失败不阻塞（主进程覆盖语义兜底）。
    // 编辑模式跳过——UPDATE 语义即覆盖自身条目，不存在「覆盖他人」歧义
    if (!edit && overwriteWarning === null) {
      try {
        const installed = await ipc.resource.list({ type: 'mcp' });
        const names = new Set(installed.map((i) => i.slug));
        if (names.has(trimmedName)) { setOverwriteWarning(trimmedName); return; }
      } catch { /* 预检失败放行 */ }
    }
    setSubmitting(true);
    setError(null);
    try {
      const parsedArgs = argsText.split('\n').map((s) => s.trim()).filter(Boolean);
      const payload = transport === 'http'
        ? {
            version: version.trim() || undefined,
            command: '',
            transport: 'streamable_http' as const,
            url: url.trim(),
            headers: rowsToRecord(headerRows),
          }
        : {
            version: version.trim() || undefined,
            command: command.trim(),
            args: parsedArgs,
            env: rowsToRecord(envRows),
            cwd: cwd.trim() || undefined,
          };
      if (edit) {
        await ipc.resource.updateMcpEntry(edit.name, payload);
      } else {
        await ipc.resource.registerMcp({ name: trimmedName, ...payload });
      }
      await ipc.mcp.start(activeWorkspaceId, edit ? edit.name : trimmedName);
      onSuccess();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const submitLabel = edit
    ? (submitting ? '保存中…' : '保存')
    : overwriteWarning !== null ? '确认覆盖' : submitting ? '注册中…' : '注册并启动';

  return (
    <Dialog open onClose={onClose} title={edit ? '编辑 MCP' : '快速创建 MCP'} width={448}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {loadingEdit ? (
          <div className="text-center text-tertiary text-sm py-8">加载中…</div>
        ) : (
        <>
        <Segmented
          options={TRANSPORT_OPTIONS}
          value={transport}
          onChange={switchTransport}
          aria-label="传输类型"
        />
        {/* 名称是 agent 引用键（defaultMcps[].ref），编辑模式锁定不可改 */}
        <Input label="名称" value={name} onChange={(e) => { setOverwriteWarning(null); setName(e.target.value); }} placeholder="如：github" autoFocus disabled={Boolean(edit)} />
        <Input label="版本" value={version} onChange={(e) => { setOverwriteWarning(null); setVersion(e.target.value); }} placeholder="如：1.0.0（可选）" />

        {transport === 'stdio' ? (
          <>
            <Input label="命令" value={command} onChange={(e) => { setOverwriteWarning(null); setCommand(e.target.value); }} placeholder="如：npx" />
            <div className="flex flex-col gap-1">
              <label htmlFor="mcp-args" className="text-sm text-secondary">参数</label>
              <textarea
                id="mcp-args"
                value={argsText}
                onChange={(e) => { setOverwriteWarning(null); setArgsText(e.target.value); }}
                placeholder={'一行一个参数，如：\n-y\n@modelcontextprotocol/server-github'}
                rows={6}
                className="rounded-md border border-subtle bg-surface-2 px-3 py-2 text-[13px] font-mono text-primary placeholder:text-disabled focus:border-focus focus:outline-none resize-y"
              />
            </div>
            <details className="border border-subtle rounded-md px-3 py-2">
              <summary className="text-sm text-secondary cursor-pointer select-none">高级：环境变量与工作目录</summary>
              <div className="flex flex-col gap-2 pt-2">
                <KeyValueRows rows={envRows} onChange={(rows) => { setOverwriteWarning(null); setEnvRows(rows); }} keyPlaceholder="变量名" valuePlaceholder="值" addLabel="添加环境变量" ariaLabel="环境变量" />
                <Input label="工作目录" value={cwd} onChange={(e) => { setOverwriteWarning(null); setCwd(e.target.value); }} placeholder="如：/opt/project（可选，子进程 cwd）" />
              </div>
            </details>
          </>
        ) : (
          <>
            <Input label="URL" value={url} onChange={(e) => { setOverwriteWarning(null); setUrl(e.target.value); }} placeholder="https://mcp.example.com/mcp" />
            {urlInvalid && <div className="text-status-error text-sm">URL 必须以 https:// 开头</div>}
            <details className="border border-subtle rounded-md px-3 py-2">
              <summary className="text-sm text-secondary cursor-pointer select-none">高级：请求头</summary>
              <div className="pt-2">
                <KeyValueRows rows={headerRows} onChange={(rows) => { setOverwriteWarning(null); setHeaderRows(rows); }} keyPlaceholder="Header 名" valuePlaceholder="值" addLabel="添加请求头" ariaLabel="请求头" />
              </div>
            </details>
          </>
        )}

        {overwriteWarning !== null && (
          <div className="text-status-warning text-sm">将覆盖同名服务器：{overwriteWarning}</div>
        )}
        {error && <div className="text-status-error text-sm">{error}</div>}
        <div className="flex gap-2 justify-end mt-2">
          <Button variant="ghost" type="button" onClick={onClose}>取消</Button>
          <Button type="submit" disabled={submitting || !valid}>{submitLabel}</Button>
        </div>
        </>
        )}
      </form>
    </Dialog>
  );
}
