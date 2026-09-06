// renderer/src/components/layout/ViewSidebar.tsx
//
// 统一侧边栏：按 activeView 分发侧边栏内容。
//   im → RoomList；files → FileTree（onSelectFile 内部直连 editor.store + ipc）；
//   tasks → TaskSidebarPanel；agents/marketplace/settings → null（主区全宽）。
// v2.2：收起 = 完全消失（return null，废弃 48px 图标轨）；宽度从 ui.store.sidebarWidths
// 按视图独立透传；拖拽提交绑 setSidebarWidth。Ctrl/Cmd+B 监听仍在 MainLayout。
import { useCallback } from 'react';
import { useUiStore, SIDEBAR_VIEWS, SIDEBAR_WIDTH_DEFAULT, type SidebarViewKey } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useEditorStore } from '../../stores/editor.store';
import { ipc } from '../../ipc/client';
import { RoomList } from '../im/RoomList';
import { SessionSidebarHeader } from '../im/SessionSidebarHeader';
import { FileTree } from '../files/FileTree';
import { TaskSidebarPanel } from '../task-board/TaskSidebarPanel';
import { Sidebar } from './Sidebar';

/** 有侧边栏的三个视图的文案（VIEW_META 同时承担「哪些视图有侧边栏」判定） */
const VIEW_LABELS: Partial<Record<string, string>> = {
  im: '会话',
  files: '文件',
  tasks: '看板',
};

export function ViewSidebar() {
  const activeView = useUiStore((s) => s.activeView);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  // 非侧边栏视图取默认值兜底（下方 label 判定后不会用到）
  const width = useUiStore((s) =>
    (SIDEBAR_VIEWS as readonly string[]).includes(s.activeView)
      ? s.sidebarWidths[s.activeView as SidebarViewKey]
      : SIDEBAR_WIDTH_DEFAULT,
  );
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

  const label = VIEW_LABELS[activeView];
  // 无侧边栏视图（agents/marketplace/settings）或收起 → 完全消失
  if (!label || collapsed) return null;
  const viewKey = activeView as SidebarViewKey;

  return (
    <Sidebar
      label={label}
      width={width}
      onWidthCommit={(w) => setSidebarWidth(viewKey, w)}
      onCollapse={toggleSidebar}
    >
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
