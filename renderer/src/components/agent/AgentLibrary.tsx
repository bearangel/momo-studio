// renderer/src/components/agent/AgentLibrary.tsx
// Tab 2：Agent 库——管理 agent 定义（builtin / 全局 custom / 本工作空间 custom）
import { useMemo, useState } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { DefinitionEditor } from './DefinitionEditor';
import { AddToWorkspaceDialog } from './AddToWorkspaceDialog';
import { Button } from '../ui/Button';
import { getProviderName } from '../../lib/provider-helpers';
import type { AgentDefinition } from '../../ipc/types';

type EditorState =
  | { mode: 'create' }
  | { mode: 'edit'; def: AgentDefinition }
  | { mode: 'configure'; def: AgentDefinition }
  | null;

export function AgentLibrary() {
  const { definitions, deleteDefinition } = useAgentStore();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [editor, setEditor] = useState<EditorState>(null);
  const [addToWsDef, setAddToWsDef] = useState<AgentDefinition | null>(null);
  const [search, setSearch] = useState('');

  const groups = useMemo(() => {
    const lower = search.toLowerCase();
    const filtered = definitions.filter((d) =>
      !lower ||
      d.name.toLowerCase().includes(lower) ||
      d.slug.toLowerCase().includes(lower) ||
      d.description.toLowerCase().includes(lower),
    );
    return {
      builtin: filtered.filter((d) => d.source === 'builtin'),
      globalCustom: filtered.filter((d) => d.source !== 'builtin' && d.workspaceId === null),
      workspaceScoped: filtered.filter((d) => d.workspaceId === activeWorkspaceId),
    };
  }, [definitions, activeWorkspaceId, search]);

  const handleDelete = async (def: AgentDefinition): Promise<void> => {
    if (!confirm(`确定删除 agent 定义「${def.name}」？\n此操作会停止全部引用此定义的 assignment。\n不可撤销。`)) return;
    try {
      await deleteDefinition(def.id);
    } catch (err) {
      alert(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 flex items-center gap-2 border-b border-border-subtle shrink-0">
        <span className="text-lg font-semibold">📚 Agent 库</span>
        <input
          type="text"
          placeholder="🔍 搜索..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ml-auto px-3 py-1 text-sm bg-bg-tertiary border border-border-subtle rounded text-neutral-100 focus:border-accent-blue focus:outline-none w-64"
        />
        <Button onClick={() => setEditor({ mode: 'create' })}>+ 新建 agent 定义</Button>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        <DefGroup title="内置 agent" defs={groups.builtin} renderItem={(d) => (
          <>
            <ScopeBadge source={d.source} workspaceId={d.workspaceId} />
            <ModelInfo def={d} />
            <button
              type="button"
              onClick={() => setEditor({ mode: 'configure', def: d })}
              className="text-xs hover:text-neutral-200"
            >
              {d.modelProviderId ? '编辑配置' : '配置'}
            </button>
            <button
              type="button"
              onClick={() => setAddToWsDef(d)}
              className="text-xs hover:text-neutral-200"
            >
              + 加入到当前工作空间
            </button>
          </>
        )} />

        <DefGroup title="全局自定义" defs={groups.globalCustom} renderItem={(d) => (
          <>
            <ScopeBadge source={d.source} workspaceId={d.workspaceId} />
            <ModelInfo def={d} />
            <button type="button" onClick={() => setEditor({ mode: 'edit', def: d })} className="text-xs hover:text-neutral-200">编辑</button>
            <button type="button" onClick={() => void handleDelete(d)} className="text-xs hover:text-red-400">删除</button>
            <button type="button" onClick={() => setAddToWsDef(d)} className="text-xs hover:text-neutral-200">+ 加入到当前工作空间</button>
          </>
        )} />

        <DefGroup title="本工作空间私有" defs={groups.workspaceScoped} emptyHint="暂无私有 agent（新建时选「仅本工作空间」即可创建）" renderItem={(d) => (
          <>
            <ScopeBadge source={d.source} workspaceId={d.workspaceId} />
            <ModelInfo def={d} />
            <button type="button" onClick={() => setEditor({ mode: 'edit', def: d })} className="text-xs hover:text-neutral-200">编辑</button>
            <button type="button" onClick={() => void handleDelete(d)} className="text-xs hover:text-red-400">删除</button>
            <button type="button" onClick={() => setAddToWsDef(d)} className="text-xs hover:text-neutral-200">+ 加入到当前工作空间</button>
          </>
        )} />
      </div>

      {editor && (
        <DefinitionEditor
          mode={editor.mode}
          def={'def' in editor ? editor.def : undefined}
          onClose={() => setEditor(null)}
        />
      )}
      {addToWsDef && (
        <AddToWorkspaceDialog preselectedDef={addToWsDef} onClose={() => setAddToWsDef(null)} />
      )}
    </div>
  );
}

function DefGroup({ title, defs, emptyHint, renderItem }: {
  title: string;
  defs: AgentDefinition[];
  emptyHint?: string;
  renderItem: (def: AgentDefinition) => React.ReactNode;
}) {
  if (defs.length === 0 && !emptyHint) return null;
  return (
    <div>
      <div className="text-xs text-neutral-500 px-2 py-1 border-b border-border-subtle">{title}</div>
      {defs.length === 0 ? (
        <div className="text-xs text-neutral-600 px-2 py-2">{emptyHint}</div>
      ) : (
        defs.map((d) => (
          <div key={d.id} className="flex items-center gap-2 px-2 py-2 hover:bg-bg-tertiary/50 rounded group">
            <span className="text-lg">{d.iconEmoji}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-neutral-100 truncate">{d.name}</div>
              <div className="text-xs text-neutral-500">{d.slug}</div>
            </div>
            <div className="flex items-center gap-2 opacity-70 group-hover:opacity-100 shrink-0">
              {renderItem(d)}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function ScopeBadge({ source, workspaceId }: { source: string; workspaceId: string | null }) {
  if (source === 'builtin') {
    return <span className="text-xs px-1.5 py-0.5 rounded bg-bg-tertiary text-neutral-400">内置</span>;
  }
  if (workspaceId === null) {
    return <span className="text-xs px-1.5 py-0.5 rounded bg-bg-tertiary text-neutral-400">全局</span>;
  }
  return <span className="text-xs px-1.5 py-0.5 rounded bg-accent-blue/20 text-accent-blue">工作空间</span>;
}

function ModelInfo({ def }: { def: AgentDefinition }) {
  if (!def.modelProviderId) {
    return <span className="text-xs text-amber-500">⚠️ 未配置</span>;
  }
  return (
    <span className="text-xs text-neutral-500">
      {getProviderName(def.modelProviderId)} · {def.modelName}
    </span>
  );
}
