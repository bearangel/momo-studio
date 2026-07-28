// renderer/src/components/workspace/WorkspaceSwitcher.tsx
// 左栏顶部 workspace 切换器：显示当前激活 workspace 图标，
// 点击展开下拉列表切换或新建
import { useEffect, useState } from 'react';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog';
import { cn } from '../../lib/cn';

export function WorkspaceSwitcher() {
  const { workspaces, activeWorkspaceId, load, select } = useWorkspaceStore();
  const [showCreate, setShowCreate] = useState(false);
  const [open, setOpen] = useState(false);

  // 首次挂载时加载 workspace 列表
  useEffect(() => {
    void load();
  }, [load]);

  const active = workspaces.find((w) => w.id === activeWorkspaceId);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-10 h-10 flex items-center justify-center rounded-md text-lg hover:bg-bg-tertiary"
        title={active?.name ?? '选择 workspace'}
      >
        {active?.iconEmoji ?? '\u{1F4C1}'}
      </button>

      {open && (
        <div className="absolute left-14 top-2 bg-bg-secondary border border-border-subtle rounded-lg shadow-xl py-1 min-w-[200px] z-50">
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              type="button"
              onClick={() => {
                select(ws.id);
                setOpen(false);
              }}
              className={cn(
                'w-full text-left px-3 py-2 text-sm hover:bg-bg-tertiary flex items-center gap-2',
                ws.id === activeWorkspaceId && 'bg-accent-blue/20',
              )}
            >
              <span>{ws.iconEmoji}</span>
              <span className="truncate">{ws.name}</span>
            </button>
          ))}
          <div className="border-t border-border-subtle mt-1 pt-1">
            <button
              type="button"
              onClick={() => {
                setShowCreate(true);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-sm text-accent-blue hover:bg-bg-tertiary"
            >
              + 新建 workspace
            </button>
          </div>
        </div>
      )}

      {showCreate && <CreateWorkspaceDialog onClose={() => setShowCreate(false)} />}
    </>
  );
}
