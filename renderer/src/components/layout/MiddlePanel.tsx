// renderer/src/components/layout/MiddlePanel.tsx
// 中间面板：根据 activeView 渲染对应视图。
// files 视图 = 左 FileTree + 右 CodeEditor；其他视图暂保留占位
import { useCallback, useState } from 'react';
import { useUiStore } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useEditorStore } from '../../stores/editor.store';
import { ipc } from '../../ipc/client';
import { FileTree } from '../files/FileTree';
import { CodeEditor } from '../editor/CodeEditor';
import { RoomList } from '../im/RoomList';
import { MessageList } from '../im/MessageList';
import { MessageInput } from '../im/MessageInput';
import { AgentList } from '../agent/AgentList';
import { AddAgentDialog } from '../agent/AddAgentDialog';
import { SettingsView } from '../settings/SettingsView';
import { MarketplaceView } from '../marketplace/MarketplaceView';

export function MiddlePanel() {
  const activeView = useUiStore((s) => s.activeView);
  const workspace = useWorkspaceStore((s) => s.getActive());
  const openFile = useEditorStore((s) => s.openFile);
  const [showAddAgent, setShowAddAgent] = useState(false);

  // 点击文件 → 通过 IPC 读取内容 → 打开到编辑器 tab
  const handleSelectFile = useCallback(
    async (filePath: string) => {
      if (!workspace) return;
      const content = await ipc.file.read(workspace.id, filePath);
      openFile(filePath, content);
    },
    [workspace, openFile],
  );

  // marketplace 视图：浏览/搜索/安装 agent/mcp/skill，不需要 workspace 上下文
  if (activeView === 'marketplace') {
    return <MarketplaceView />;
  }

  // 无 workspace 时显示引导
  if (!workspace) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500">
        <div className="text-center">
          <div className="text-4xl mb-2">📁</div>
          <p className="text-sm">创建或选择一个 workspace 开始</p>
        </div>
      </div>
    );
  }

  // files 视图：左侧文件树 + 右侧编辑器
  if (activeView === 'files') {
    return (
      <div className="flex-1 flex">
        <div className="w-64 border-r border-border-subtle bg-bg-secondary overflow-auto">
          <FileTree onSelectFile={handleSelectFile} />
        </div>
        <CodeEditor />
      </div>
    );
  }

  // im 视图：左侧房间列表 + 右侧消息流和输入框
  if (activeView === 'im') {
    return (
      <div className="flex-1 flex">
        <RoomList />
        <div className="flex-1 flex flex-col min-w-0">
          <MessageList />
          <MessageInput />
        </div>
      </div>
    );
  }

  // agents 视图：当前 workspace 的 agent 列表 + 添加对话框
  if (activeView === 'agents') {
    return (
      <>
        <AgentList onAdd={() => setShowAddAgent(true)} />
        {showAddAgent && <AddAgentDialog onClose={() => setShowAddAgent(false)} />}
      </>
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
