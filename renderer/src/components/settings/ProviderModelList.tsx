// renderer/src/components/settings/ProviderModelList.tsx
//
// 供应商模型列表管理（P2 Task 6）：
// - 每行：model_id（等宽字体）+ 启用开关 + 上下文窗口（可选，压缩重构 Task 1）+ 删除
// - 「获取模型列表」：fetchModels 拉取远端列表 → 逐个 addModel 幂等入库 → 刷新
// - 「手动添加」：内联输入 model_id → addModel
// - 增删后通过 onChanged 通知父组件刷新左列模型数徽标
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { RefreshCw, Plus } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { ProviderModel } from '../../ipc/types';
import { Checkbox } from '../ui/Checkbox';
import { Button } from '../ui/Button';

interface Props {
  providerId: string;
  /** 行数变化（添加/删除/拉取）后的回调——父组件用于刷新模型数徽标 */
  onChanged?: () => void;
}

/** 行内上下文窗口编辑（可选）。空=未知（走内置目录）；正整数=手动覆盖；非法输入回退不提交 */
function ModelWindowInput({
  providerId,
  modelId,
  contextWindow,
  onError,
}: {
  providerId: string;
  modelId: string;
  contextWindow: number | null;
  onError: (msg: string) => void;
}): JSX.Element {
  const [value, setValue] = useState(contextWindow === null ? '' : String(contextWindow));

  const commit = async (raw: string): Promise<void> => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      if (contextWindow !== null) {
        try {
          await ipc.provider.setModelWindow(providerId, modelId, null);
        } catch (err) {
          onError(err instanceof Error ? err.message : String(err));
        }
      }
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== trimmed) {
      setValue(contextWindow === null ? '' : String(contextWindow));
      return;
    }
    if (n === contextWindow) return;
    try {
      await ipc.provider.setModelWindow(providerId, modelId, n);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={`上下文窗口 ${modelId}`}
      title="上下文窗口（token，可选）——留空走内置目录"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={(e) => void commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      placeholder="自动"
      className="w-24 rounded border border-subtle bg-surface-2 px-1.5 py-0.5 text-xs text-secondary font-mono"
    />
  );
}

export function ProviderModelList({ providerId, onChanged }: Props) {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newModelId, setNewModelId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const list = await ipc.provider.listModels(providerId);
    setModels(list);
  }, [providerId]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    reload().finally(() => setLoading(false));
  }, [reload]);

  const handleToggle = async (m: ProviderModel): Promise<void> => {
    try {
      await ipc.provider.setModelEnabled(providerId, m.modelId, !m.enabled);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemove = async (m: ProviderModel): Promise<void> => {
    try {
      await ipc.provider.removeModel(providerId, m.modelId);
      await reload();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleFetchAll = async (): Promise<void> => {
    setFetching(true);
    setError(null);
    try {
      const ids = await ipc.provider.fetchModels(providerId);
      for (const id of ids) {
        await ipc.provider.addModel(providerId, id);
      }
      await reload();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
  };

  const handleAdd = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const modelId = newModelId.trim();
    if (!modelId) return;
    try {
      await ipc.provider.addModel(providerId, modelId);
      setNewModelId('');
      setAdding(false);
      await reload();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="rounded-lg border border-subtle bg-surface-1 p-4 flex flex-col gap-2" data-testid="provider-model-list">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm text-primary">模型列表</h3>
        <div className="flex items-center gap-2">
          <button type="button" onClick={handleFetchAll} disabled={fetching}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-subtle text-secondary hover:bg-surface-3 disabled:opacity-50">
            {fetching ? '拉取中…' : <><RefreshCw size={12} strokeWidth={1.75} aria-hidden /> 获取模型列表</>}
          </button>
          <button type="button" onClick={() => setAdding((v) => !v)}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-subtle text-secondary hover:bg-surface-3">
            <Plus size={12} strokeWidth={1.75} aria-hidden /> 手动添加
          </button>
        </div>
      </div>

      {adding && (
        <form onSubmit={handleAdd} className="flex items-center gap-2">
          <input
            value={newModelId}
            onChange={(e) => setNewModelId(e.target.value)}
            placeholder="模型 ID，如 glm-5.3"
            autoFocus
            className="flex-1 rounded border border-subtle bg-surface-2 px-2 py-1 text-sm text-primary font-mono"
          />
          <Button type="submit" size="sm">添加</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => { setAdding(false); setNewModelId(''); }}>取消</Button>
        </form>
      )}

      {error && <p className="text-xs text-status-error" role="alert">{error}</p>}
      {loading && <p className="text-xs text-tertiary">加载中…</p>}
      {!loading && models.length === 0 && (
        <p className="text-xs text-tertiary">暂无模型。点击「获取模型列表」从 API 拉取，或「手动添加」。</p>
      )}

      <div className="flex flex-col">
        {models.map((m) => (
          <div key={m.modelId}
            className="flex items-center gap-2 py-1.5 border-b border-subtle last:border-b-0">
            <Checkbox
              checked={m.enabled}
              onChange={() => void handleToggle(m)}
              aria-label={`启用 ${m.modelId}`}
            />
            <code className={`flex-1 text-xs font-mono truncate ${m.enabled ? 'text-primary' : 'text-disabled line-through'}`}>
              {m.modelId}
            </code>
            <ModelWindowInput
              key={`${m.modelId}::${m.contextWindow ?? ''}`}
              providerId={providerId}
              modelId={m.modelId}
              contextWindow={m.contextWindow}
              onError={setError}
            />
            <button type="button" onClick={() => void handleRemove(m)} aria-label={`删除 ${m.modelId}`}
              className="text-xs text-tertiary hover:text-status-error">删除</button>
          </div>
        ))}
      </div>
    </div>
  );
}
