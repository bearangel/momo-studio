// renderer/src/components/layout/MiddlePanel.tsx
// 中间面板：根据 activeView 渲染对应视图。
// files 视图 = 左 FileTree + 右 CodeEditor；其他视图暂保留占位
import { useCallback, useEffect, useState } from 'react';
import { useUiStore } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useEditorStore } from '../../stores/editor.store';
import { useImStore } from '../../stores/im.store';
import { ipc } from '../../ipc/client';
import { FileTree } from '../files/FileTree';
import { CodeEditor } from '../editor/CodeEditor';
import { RoomList } from '../im/RoomList';
import { MessageList } from '../im/MessageList';
import { MessageInput } from '../im/MessageInput';
import { MembersPanel } from '../im/MembersPanel';
import { InputToolbar } from '../im/InputToolbar';
import { RoomToolBudgetBadge } from '../im/RoomToolBudgetBadge';
import { AgentsView } from '../agent/AgentsView';
import { SettingsView } from '../settings/SettingsView';
import { ResourceLibraryView } from '../resource-library/ResourceLibraryView';
import { ResizableSidebar } from '../common/ResizableSidebar';

export function MiddlePanel() {
  const activeView = useUiStore((s) => s.activeView);
  const workspace = useWorkspaceStore((s) => s.getActive());
  const openFile = useEditorStore((s) => s.openFile);
  const activeRoomId = useImStore((s) => s.activeRoomId);
  const rooms = useImStore((s) => s.rooms);
  const [showMembers, setShowMembers] = useState(false);

  // 切换房间时关闭成员浮层，避免新房间显示旧成员
  useEffect(() => {
    setShowMembers(false);
  }, [activeRoomId]);

  // 点击文件 → 通过 IPC 读取内容 → 打开到编辑器 tab
  const handleSelectFile = useCallback(
    async (filePath: string) => {
      if (!workspace) return;
      const content = await ipc.file.read(workspace.id, filePath);
      openFile(filePath, content);
    },
    [workspace, openFile],
  );

  // 资源库视图（v1.7：原 marketplace 视图统一为资源库，三源合并）：浏览/搜索/安装 agent/mcp/skill，不需要 workspace 上下文
  if (activeView === 'marketplace') {
    return <ResourceLibraryView />;
  }

  // 无 workspace 时显示引导
  if (!workspace) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500">
        <div className="text-center">
          <div className="text-4xl mb-2">📁</div>
          <p className="text-sm">创建或选择一个工作空间开始</p>
        </div>
      </div>
    );
  }

  // files 视图：左侧文件树 + 右侧编辑器
  if (activeView === 'files') {
    return (
      <div className="flex-1 flex">
        <ResizableSidebar storageKey="files-sidebar" minWidth={180} maxWidth={500} defaultWidth={256} collapsedLabel="文件">
          <FileTree onSelectFile={handleSelectFile} />
        </ResizableSidebar>
        <CodeEditor />
      </div>
    );
  }

  // im 视图：左侧房间列表 + 中间消息流和工具条和输入框 + 成员浮层（按需）
  if (activeView === 'im') {
    const activeRoom = rooms.find((r) => r.roomId === activeRoomId);
    return (
      <div className="flex-1 flex min-w-0">
        <ResizableSidebar storageKey="im-sidebar" minWidth={180} maxWidth={400} defaultWidth={240} collapsedLabel="会话">
          <RoomList />
        </ResizableSidebar>
        <div className="flex-1 flex flex-col min-w-0 relative">
          {/* 房间头部：房间名 + 工具上限徽标 */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle bg-bg-secondary">
            <span className="text-sm text-neutral-100 truncate flex-1">
              {activeRoom ? activeRoom.name : '未选择房间'}
            </span>
            {activeRoomId && <RoomToolBudgetBadge roomId={activeRoomId} />}
          </div>
          <MessageList />
          <InputToolbar
            showMembers={showMembers}
            onToggleMembers={() => setShowMembers((v) => !v)}
            disabled={!activeRoomId}
          />
          <MessageInput />
          {showMembers && activeRoomId && (
            <>
              {/* 透明 backdrop：点击关闭浮层（仅覆盖 chat 列，不影响 RoomList） */}
              <div
                className="absolute inset-0 z-20"
                onClick={() => setShowMembers(false)}
                data-testid="members-backdrop"
              />
              <MembersPanel />
            </>
          )}
        </div>
      </div>
    );
  }

  // agents 视图：Tab 容器（本工作空间 / Agent 库）
  if (activeView === 'agents') {
    return <AgentsView />;
  }

  // settings 视图：Git Policy 配置 + 审计日志
  if (activeView === 'settings') {
    return <SettingsView />;
  }

  // 兜底（所有 ViewKey 已在上方分支处理，理论上不可达）
  return (
    <div className="flex-1 flex items-center justify-center text-neutral-500">
      <p className="text-sm">未知视图</p>
    </div>
  );
}
