// 供应商注册表 UI：列表 + 添加/编辑/删除/设为默认
import { useEffect, useState } from 'react';
import { useProviderStore } from '../../stores/provider.store';
import { ProviderDialog } from './ProviderDialog';
import type { ModelProvider } from '../../ipc/types';

export function ProviderSettings() {
  const { providers, loading, loadProviders, deleteProvider, setDefault } = useProviderStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ModelProvider | null>(null);

  useEffect(() => { void loadProviders(); }, [loadProviders]);

  const openCreate = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (p: ModelProvider) => { setEditing(p); setDialogOpen(true); };
  const handleDelete = async (p: ModelProvider) => {
    if (confirm(`确定删除供应商「${p.name}」？\n已使用该供应商的 agent 不受影响（持有副本）。`)) {
      await deleteProvider(p.id);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-neutral-100 text-base">模型供应商</h2>
        <button type="button" onClick={openCreate}
          className="text-xs px-3 py-1 rounded bg-accent-blue text-white hover:opacity-90">+ 添加供应商</button>
      </div>
      {loading && <p className="text-sm text-neutral-500">加载中…</p>}
      {!loading && providers.length === 0 && (
        <p className="text-sm text-neutral-500">暂无供应商。点击"添加供应商"创建（如 GLM / DeepSeek / OpenAI）。</p>
      )}
      <div className="flex flex-col gap-2">
        {providers.map((p) => (
          <div key={p.id} className="border border-border-subtle rounded-lg p-3 bg-bg-tertiary flex items-center gap-3">
            <div className="flex-1">
              <div className="text-sm text-neutral-100 flex items-center gap-2">
                {p.name}
                {p.isDefault && <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-blue/20 text-accent-blue">默认</span>}
              </div>
              <div className="text-xs text-neutral-500 truncate">{p.baseUrl}{p.defaultModel ? ` · ${p.defaultModel}` : ''}</div>
            </div>
            <button type="button" onClick={() => setDefault(p.id)} disabled={p.isDefault}
              className="text-xs text-neutral-400 hover:text-neutral-200 disabled:opacity-40">⭐ 设为默认</button>
            <button type="button" onClick={() => openEdit(p)} className="text-xs text-neutral-400 hover:text-neutral-200">编辑</button>
            <button type="button" onClick={() => handleDelete(p)} className="text-xs text-red-400 hover:text-red-300">删除</button>
          </div>
        ))}
      </div>
      <ProviderDialog
        open={dialogOpen}
        editing={editing}
        onClose={() => setDialogOpen(false)}
        onSaved={() => void loadProviders()}
      />
    </div>
  );
}
