// renderer/src/components/layout/ViewSidebar.tsx
//
// 统一侧边栏（P2 Task 3）：按 activeView 分发侧边栏内容。
//   im → RoomList；files → FileTree（onSelectFile 内部直连 editor.store + ipc）；
//   tasks → TaskSidebarPanel；agents/marketplace/settings → null（主区全宽）。
// 折叠态 48px 仅图标（Sidebar 承载），展开 260px。Ctrl/Cmd+B 监听在 MainLayout。
import { useCallback, type ReactNode } from 'react';
import { MessageSquare, Folder, SquareKanban } from 'lucide-react';
import { useUiStore, type ViewKey } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useEditorStore } from '../../stores/editor.store';
import { ipc } from '../../ipc/client';
import { RoomList } from '../im/RoomList';
import { SessionSidebarHeader } from '../im/SessionSidebarHeader';
import { FileTree } from '../files/FileTree';
import { TaskSidebarPanel } from '../task-board/TaskSidebarPanel';
import { Sidebar } from './Sidebar';

interface ViewMeta {
  icon: ReactNode;
  label: string;
}

/** 有侧边栏的三个视图的图标/文案（其余视图返回 null） */
const VIEW_META: Partial<Record<ViewKey, ViewMeta>> = {
  im: { icon: <MessageSquare size={17} strokeWidth={1.75} aria-hidden />, label: '会话' },
  files: { icon: <Folder size={17} strokeWidth={1.75} aria-hidden />, label: '文件' },
  tasks: { icon: <SquareKanban size={17} strokeWidth={1.75} aria-hidden />, label: '看板' },
};

export function ViewSidebar() {
  const activeView = useUiStore((s) => s.activeView);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const workspace = useWorkspaceStore((s) => s.getActive());
  const openFile = useEditorStore((s) => s.openFile);

  // 与 MiddlePanel 原 files 分支逻辑一致：IPC 读文件 → 打开编辑器 tab
  const handleSelectFile = useCallback(
    async (filePath: string) => {
      if (!workspace) return;
      const content = await ipc.file.read(workspace.id, filePath);
      openFile(filePath, content);
    },
    [workspace, openFile],
  );

  const meta = VIEW_META[activeView];
  if (!meta) return null;

  return (
    <Sidebar collapsed={collapsed} icon={meta.icon} label={meta.label} onToggle={toggleSidebar}>
      {activeView === 'im' && (
        // 会话区：头部双常驻入口（⚡/👥，spec §6.2）+ 列表（图标语义派生）
        <>
          <SessionSidebarHeader />
          <RoomList />
        </>
      )}
      {activeView === 'files' && <FileTree onSelectFile={handleSelectFile} />}
      {activeView === 'tasks' && <TaskSidebarPanel />}
    </Sidebar>
  );
}
