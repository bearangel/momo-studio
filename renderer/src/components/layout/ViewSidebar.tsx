// renderer/src/components/layout/ViewSidebar.tsx
//
// 统一侧边栏：按 activeView 分发侧边栏内容。
//   im → RoomList；files → FileTree（onSelectFile 内部直连 editor.store + ipc）；
//   tasks → TaskSidebarPanel；agents/marketplace/settings → null（主区全宽）。
// v2.2：收起 = 完全消失（return null，废弃 48px 图标轨）且按视图独立；宽度从
// ui.store.sidebarWidths 按视图独立透传；拖拽提交绑 setSidebarWidth。Ctrl/Cmd+B 在 MainLayout。
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
import { PanelHost } from '../plugins/PanelHost';
import { usePluginPanelsStore, panelKeyOf } from '../../stores/plugin-panels.store';

/** 有侧边栏的四个视图的文案（VIEW_META 同时承担「哪些视图有侧边栏」判定） */
const VIEW_LABELS: Partial<Record<string, string>> = {
  im: '会话',
  files: '文件',
  tasks: '看板',
  workgroups: '工作组',
};

export function ViewSidebar() {
  const activeView = useUiStore((s) => s.activeView);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  // 收起状态按视图独立（v2.2 优化）：非侧边栏视图恒 false（下方 label 判定后不会用到）
  const collapsed = useUiStore((s) =>
    (SIDEBAR_VIEWS as readonly string[]).includes(s.activeView)
      ? s.sidebarCollapsed[s.activeView as SidebarViewKey]
      : false,
  );
  // 非侧边栏视图取默认值兜底（下方 label 判定后不会用到）
  const width = useUiStore((s) =>
    (SIDEBAR_VIEWS as readonly string[]).includes(s.activeView)
      ? s.sidebarWidths[s.activeView as SidebarViewKey]
      : SIDEBAR_WIDTH_DEFAULT,
  );
  const workspace = useWorkspaceStore((s) => s.getActive());
  const openFile = useEditorStore((s) => s.openFile);
  const showBinaryNotice = useEditorStore((s) => s.showBinaryNotice);

  // 与 MiddlePanel 原 files 分支逻辑一致：IPC 读文件 → 打开编辑器 tab。
  // 2026-10-23 ④：二进制文件改走 VS Code 式占位卡（编辑区显式按钮触发外部
  // 打开），不再点击即静默拉起系统应用。
  const handleSelectFile = useCallback(
    async (filePath: string) => {
      if (!workspace) return;
      const result = await ipc.file.readForEditor(workspace.id, filePath);
      if (result.kind === 'binary') {
        showBinaryNotice(filePath);
        return;
      }
      openFile(filePath, result.content);
    },
    [workspace, openFile, showBinaryNotice],
  );

  // 面板模式（P4）：activeKey 非空 → 侧栏槽整体让给 PanelHost（主区不动）
  const panels = usePluginPanelsStore((s) => s.panels);
  const activePanelKey = usePluginPanelsStore((s) => s.activeKey);
  const deactivatePanel = usePluginPanelsStore((s) => s.deactivate);
  const panelWidth = usePluginPanelsStore((s) => s.width);
  const setPanelWidth = usePluginPanelsStore((s) => s.setWidth);
  const activePanel =
    activePanelKey === null
      ? null
      : (panels.find((p) => panelKeyOf(p) === activePanelKey && p.placement === 'sidebar') ?? null);
  if (activePanel) {
    return (
      <Sidebar
        label={activePanel.title}
        width={panelWidth}
        onWidthCommit={setPanelWidth}
        onCollapse={deactivatePanel}
      >
        <PanelHost panel={activePanel} onExit={deactivatePanel} />
      </Sidebar>
    );
  }

  const label = VIEW_LABELS[activeView];
  // 无侧边栏视图（agents/marketplace/settings）或收起 → 完全消失
  if (!label || collapsed) return null;
  const viewKey = activeView as SidebarViewKey;

  return (
    <Sidebar
      label={label}
      width={width}
      onWidthCommit={(w) => setSidebarWidth(viewKey, w)}
      onCollapse={() => toggleSidebar(viewKey)}
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
      {activeView === 'workgroups' && (
        // M2.1 T2 占位骨架：组列表/成员 presence 由 Task 3 的 WorkgroupSidebar 填充
        <div className="flex flex-1 items-center justify-center p-4 text-center">
          <p className="text-xs text-tertiary" data-testid="workgroup-sidebar-stub">
            工作组侧栏占位（Task 3 填充）
          </p>
        </div>
      )}
    </Sidebar>
  );
}
