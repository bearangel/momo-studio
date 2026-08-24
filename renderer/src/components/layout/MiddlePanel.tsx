// renderer/src/components/layout/MiddlePanel.tsx
// 中间面板：根据 activeView 渲染主区内容。
// P2 Task 3：im/files 的内嵌 ResizableSidebar 移除——RoomList/FileTree 由
// ViewSidebar 统一承载，本组件只负责各视图的主区。
import { useEffect, useState } from 'react';
import { useUiStore } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSessionStore } from '../../stores/session.store';
import { CodeEditor } from '../editor/CodeEditor';
import { MessageList } from '../im/MessageList';
import { MentionInput } from '../im/MentionInput';
import { MembersPanel } from '../im/MembersPanel';
import { InputToolbar } from '../im/InputToolbar';
import { RoomToolBudgetBadge } from '../im/RoomToolBudgetBadge';
import { ExportChatButton } from '../im/ExportChatButton';
import { AgentsView } from '../agent/AgentsView';
import { SettingsView } from '../settings/SettingsView';
import { ResourceLibraryView } from '../resource-library/ResourceLibraryView';
import { TaskBoardView } from '../task-board/TaskBoardView';

export function MiddlePanel() {
  const activeView = useUiStore((s) => s.activeView);
  const workspace = useWorkspaceStore((s) => s.getActive());
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const [showMembers, setShowMembers] = useState(false);

  // 切换会话时关闭成员浮层，避免新会话显示旧成员
  useEffect(() => {
    setShowMembers(false);
  }, [activeSessionId]);

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

  // files 视图：文件树在 ViewSidebar，主区仅编辑器
  if (activeView === 'files') {
    return (
      <div className="flex-1 flex">
        <CodeEditor />
      </div>
    );
  }

  // im 视图：会话列表在 ViewSidebar，主区 = 消息流 + 工具条 + 输入框 + 成员浮层（按需）
  if (activeView === 'im') {
    const activeSession = sessions.find((s) => s.id === activeSessionId);
    return (
      <div className="flex-1 flex min-w-0">
        <div className="flex-1 flex flex-col min-w-0 relative">
          {/* 会话头部：会话名 + 工具上限徽标 */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle bg-bg-secondary">
            <span className="text-sm text-neutral-100 truncate flex-1">
              {activeSession ? activeSession.title : '未选择房间'}
            </span>
            {activeSessionId && <RoomToolBudgetBadge sessionId={activeSessionId} />}
            {activeSessionId && <ExportChatButton sessionId={activeSessionId} />}
          </div>
          <MessageList />
          <InputToolbar
            showMembers={showMembers}
            onToggleMembers={() => setShowMembers((v) => !v)}
            disabled={!activeSessionId}
            workspaceId={workspace.id}
            activeSessionId={activeSessionId ?? undefined}
          />
          <MentionInput />
          {showMembers && activeSessionId && (
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

  // tasks 视图：任务看板（D 子系统 D7）——筛选/列表在 ViewSidebar，主区 = 状态栏 + 详情
  if (activeView === 'tasks') {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <TaskBoardView workspaceId={workspace.id} />
      </div>
    );
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
