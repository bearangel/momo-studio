// renderer/src/components/resource-library/McpConfigDialog.tsx
// P2.2 Task 7：已装远程 MCP 配置编辑弹窗——ResourceDetail「配置」按钮打开，
// mount 调 ipc.resource.getMcpConfig 加载，按 bare 两态渲染：
//   - schema 模式（bare=false）：url Input + 按 schema.properties 渲染字段
//     （values 回显）；提交 { url, config, schema 透传 }
//   - 裸模式（bare=true，schema 键缺省）：url 整条 + headers 动态键值行（可增删）；
//     提交 { url, config: {}, headers }（整包覆盖——删光行即清空）
//
// 契约要点（勿扩）：
//   - D9（spec §9）：schema 模式 url 预填 view.url.split('?')[0]——url 里带着
//     x-from=query 字段拼出的 query，原样预填会让 composeRemoteConfig 追加第二个
//     同名参数，连接发双份
//   - url 非 https 禁提交（spec §7 前端防线；主进程双防线兜底）
//   - McpConfigView.schema 可选：bare=true 时键缺省（非 undefined 值）
//   - headers 仅裸模式生效；config 值 trim 后空串剔除（同安装语义）
//
// 交互照抄 McpConnectDialog / UploadSkillDialog 的锁定模式：提交期间禁用全部
// 可交互元素（Esc / 遮罩关闭同样锁死）；失败红字留在弹窗可重试；成功后自关。
// 提交走 onSubmit（View 层接线 ipc.resource.updateMcpConfig(name, input)）。
import { useEffect, useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { ipc } from '../../ipc/client';
import type { McpConfigUpdateInput, McpConfigView } from '../../ipc/types';

/** placeholder=description 截断上限（与 McpConnectDialog 同参） */
const PLACEHOLDER_MAX = 64;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 提交锁定期传给 Dialog 的关闭回调（Esc / 遮罩点击 no-op） */
const noop = (): void => undefined;

/** headers 动态行（键值成对编辑；空键行提交时剔除） */
interface HeaderRow {
  key: string;
  value: string;
}

interface Props {
  /** MCP 定义名（getMcpConfig 入参——ResourceItem.slug，非展示名） */
  name: string;
  /** 展示名（弹窗标题「配置 {serverName}」） */
  serverName: string;
  /** 提交（View 层接线 updateMcpConfig；reject 时红字留在弹窗） */
  onSubmit: (input: McpConfigUpdateInput) => Promise<void>;
  onClose: () => void;
}

export function McpConfigDialog({ name, serverName, onSubmit, onClose }: Props) {
  const [view, setView] = useState<McpConfigView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ipc.resource
      .getMcpConfig(name)
      .then((v) => {
        if (cancelled) return;
        setView(v);
        // D9：schema 模式预填剥 query 的 base url；裸模式 url 整条回显
        setUrl(v.bare ? v.url : (v.url.split('?')[0] ?? ''));
        setValues(v.values);
        setHeaderRows(Object.entries(v.headers).map(([key, value]) => ({ key, value })));
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  const fields = view && !view.bare && view.schema ? Object.entries(view.schema.properties ?? {}) : [];
  const required = view && !view.bare && view.schema ? new Set(view.schema.required ?? []) : new Set<string>();

  const missingRequired = fields.some(
    ([fieldName]) => required.has(fieldName) && !(values[fieldName] ?? '').trim(),
  );
  const lockAll = submitting;
  const canSubmit = url.trim().startsWith('https://') && !missingRequired && !lockAll;

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!canSubmit || !view) return;
    setSubmitting(true);
    setError(null);
    try {
      if (view.bare) {
        // 裸模式：headers 整包覆盖（空键行剔除；清空全部行 = 清空 headers）
        const headers: Record<string, string> = {};
        for (const row of headerRows) {
          const k = row.key.trim();
          if (k) headers[k] = row.value.trim();
        }
        await onSubmit({ url: url.trim(), config: {}, headers });
      } else {
        // schema 模式：必填 + 非空可选项（空可选项不下发）；headers 键缺省（仅裸模式生效）
        const config: Record<string, string> = {};
        for (const [fieldName] of fields) {
          const v = (values[fieldName] ?? '').trim();
          if (v || required.has(fieldName)) config[fieldName] = v;
        }
        await onSubmit({
          url: url.trim(),
          config,
          ...(view.schema ? { schema: view.schema } : {}),
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const setRow = (index: number, patch: Partial<HeaderRow>): void => {
    setHeaderRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  return (
    <Dialog open onClose={lockAll ? noop : onClose} title={`配置 ${serverName}`} width={448}>
      {loadError ? (
        <div className="flex flex-col gap-3">
          <div className="text-status-error text-sm break-all">{loadError}</div>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
          </div>
        </div>
      ) : !view ? (
        <div className="text-center text-tertiary text-sm py-8">加载中…</div>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
          <Input
            label="服务地址"
            type="text"
            placeholder="https://…"
            value={url}
            disabled={lockAll}
            onChange={(e) => setUrl(e.target.value)}
          />
          {fields.map(([fieldName, prop]) => (
            <Input
              key={fieldName}
              label={prop.title ?? fieldName}
              placeholder={prop.description ? truncate(prop.description, PLACEHOLDER_MAX) : undefined}
              type="text"
              value={values[fieldName] ?? ''}
              disabled={lockAll}
              onChange={(e) => setValues((prev) => ({ ...prev, [fieldName]: e.target.value }))}
            />
          ))}
          {view.bare && (
            <div className="flex flex-col gap-2">
              <div className="text-sm text-secondary">Headers</div>
              {headerRows.map((row, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    aria-label="Header 名"
                    type="text"
                    placeholder="名称"
                    className="flex-1"
                    value={row.key}
                    disabled={lockAll}
                    onChange={(e) => setRow(index, { key: e.target.value })}
                  />
                  <Input
                    aria-label="Header 值"
                    type="text"
                    placeholder="值"
                    className="flex-1"
                    value={row.value}
                    disabled={lockAll}
                    onChange={(e) => setRow(index, { value: e.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="删除 Header"
                    disabled={lockAll}
                    onClick={() => setHeaderRows((prev) => prev.filter((_, i) => i !== index))}
                    className="shrink-0"
                  >
                    <X size={14} strokeWidth={1.75} aria-hidden />
                  </Button>
                </div>
              ))}
              <Button
                variant="secondary"
                size="sm"
                disabled={lockAll}
                onClick={() => setHeaderRows((prev) => [...prev, { key: '', value: '' }])}
                className="self-start"
              >
                <Plus size={12} strokeWidth={1.75} aria-hidden />
                添加 Header
              </Button>
            </div>
          )}
          {error && <div className="text-status-error text-sm break-all">{error}</div>}
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="ghost" type="button" onClick={onClose} disabled={lockAll}>
              取消
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
