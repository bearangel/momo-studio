// renderer/src/components/layout/MiddlePanel.tsx
// 中间面板：根据 activeView 渲染主区内容。
// P2 Task 3：im/files 的内嵌 ResizableSidebar 移除——RoomList/FileTree 由
// ViewSidebar 统一承载，本组件只负责各视图的主区。
import { useEffect, useState } from 'react';
import { Folder, Plus } from 'lucide-react';
import { useUiStore } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSessionStore } from '../../stores/session.store';
import { Button } from '../ui/Button';
import { CodeEditor } from '../editor/CodeEditor';
import { MessageList } from '../im/MessageList';
import { MentionInput } from '../im/MentionInput';
import { HumanRequestPanel } from '../im/HumanRequestPanel';
import { MembersPanel } from '../im/MembersPanel';
import { InputToolbar } from '../im/InputToolbar';
import { RoomToolBudgetBadge } from '../im/RoomToolBudgetBadge';
import { ExportChatButton } from '../im/ExportChatButton';
import { TaskProgressButton } from '../im/TaskProgressButton';
import { InFlightPanel } from '../im/InFlightPanel';
import { RemoteSessionPanel } from '../hub/RemoteSessionPanel';
import { RemoteSessionStatusInline } from '../hub/RemoteSessionStatusInline';
import { isLocalExecution } from '../../lib/is-local-execution';
import { useHubStore } from '../../stores/hub.store';
import { useHumanStore } from '../../stores/human.store';
import { useTaskStore } from '../../stores/task.store';
import { ipc } from '../../ipc/client';
import type { TaskRow } from '../../ipc/types';
import { AgentsView } from '../agent/AgentsView';
import { SettingsView } from '../settings/SettingsView';
import { ResourceLibraryView } from '../resource-library/ResourceLibraryView';
import { TaskBoardView } from '../task-board/TaskBoardView';
import { WorkgroupView } from '../workgroup/WorkgroupView';
import { CreateWorkspaceDialog } from '../workspace/CreateWorkspaceDialog';
import { EmptyState } from '../ui/EmptyState';
import { SidebarRestoreButton } from './SidebarRestoreButton';
// v2.7 Task 8：浏览器侧栏 chrome（占位区由主进程 WebContentsView 叠加渲染）
import { BrowserSidebar } from '../workspace/BrowserSidebar';
import { PanelPageView } from '../plugins/PanelPageView';

/**
 * 本机执行待验收轻提示（D1-C / D4-B，2026-11-19）：本机 manual 任务提交后
 * 会话不弹跨节点验收卡（excludeKinds 排除），但「待验收」必须有可发现入口——
 * 一条系统级 notice，点击直达看板任务详情（验收通过 / 打回）。auto 任务
 * （巡检）提交即收口，不产生 pending acceptance，自然不显示。
 */
function LocalAcceptanceNotice({ sessionId, taskId }: { sessionId: string; taskId: string }): React.JSX.Element | null {
  const rows = useHumanStore((s) => s.pendingBySession.get(sessionId));
  const pendingAcceptance = (rows ?? []).some((r) => r.kind === 'acceptance' && r.status === 'pending');
  if (!pendingAcceptance) return null;
  return (
    <div
      className="shrink-0 border-t border-subtle bg-surface-1 px-4 py-2"
      data-testid="local-acceptance-notice"
    >
      <div className="flex items-center gap-2 rounded-[10px] border border-subtle border-l-2 border-l-status-warning bg-surface-1 px-3 py-2 text-xs text-secondary">
        <span className="text-primary">已提交验收</span>
        <span>交付等待裁决（本机任务不在会话内裁决）</span>
        <button
          type="button"
          className="ml-auto shrink-0 rounded-md border border-subtle px-2.5 py-1 text-xs text-accent-300 hover:bg-surface-3"
          onClick={() => {
            useUiStore.getState().setActiveView('tasks');
            useTaskStore.getState().setSelectedTaskId(taskId);
          }}
        >
          前往看板裁决 →
        </button>
      </div>
    </div>
  );
}

/** 本机任务执行会话的人工请求排除面（2026-11-19）：验收卡不出现——裁决归看板 */
const LOCAL_TASK_EXCLUDED_KINDS = ['acceptance'] as const;

export function MiddlePanel() {
  const activeView = useUiStore((s) => s.activeView);
  const workspace = useWorkspaceStore((s) => s.getActive());
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const [showMembers, setShowMembers] = useState(false);
  // 0-ws 兜底引导的新建对话框开关（T2：Dialog 形态取代嵌入表单）
  const [wsDialogOpen, setWsDialogOpen] = useState(false);
  // 验收卡满屏（V1）：切会话即还原
  const [acceptanceFullscreen, setAcceptanceFullscreen] = useState(false);
  // 2026-11-19 任务会话形态分流：执行节点==本节点 → 本地形态（MessageList +
  // 验收卡 + 补充指令框）；目标为其它节点 → RemoteSessionPanel（跨节点跟踪）。
  // 判定键 = 委派目标 vs 本节点 id（hub status 快照；快照未拉取时兜底拉一次）
  const hubStatus = useHubStore((s) => s.status);
  const activeSessionKind = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.kind ?? null);
  // 任务行按 executionSessionId 精确直查（archived:'all'）——不依赖 task.store
  // 看板数据源（含来源过滤/归档排除；循环实例验收即归档，看板 store 里没有，
  // 2026-11-19 实测：依赖它会让归档实例会话全部误走远端面板）
  const [executionTask, setExecutionTask] = useState<TaskRow | null>(null);
  useEffect(() => {
    // 不以会话 kind 为前提（2026-11-19 实机）：任务可绑「指定会话」执行，会话
    // kind 是 chat——以 kind 设闸会让这类执行会话查不到任务、验收卡漏排除。
    // 每次切会话一次轻量反查（无关联任务返回空数组）。
    if (!activeSessionId) {
      setExecutionTask(null);
      return;
    }
    let cancelled = false;
    void ipc.task
      .list({ executionSessionId: activeSessionId, archived: 'all' })
      .then((rows) => {
        if (!cancelled) setExecutionTask(rows[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setExecutionTask(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);
  const localExecution = executionTask !== null && isLocalExecution(executionTask, hubStatus?.nodeId ?? null);
  useEffect(() => {
    if (activeSessionKind !== 'task_execution' || hubStatus !== null) return;
    // hub 面板未挂载过（status 快照缺）时的兜底拉取——判定需要本节点 id
    void ipc.hub
      .getStatus()
      .then((st) => useHubStore.setState({ status: st }))
      .catch(() => undefined);
  }, [activeSessionKind, hubStatus]);

  // 切换会话时关闭成员浮层，避免新会话显示旧成员
  useEffect(() => {
    setShowMembers(false);
  }, [activeSessionId]);

  // 资源库视图（v1.7：原 marketplace 视图统一为资源库，三源合并）：浏览/搜索/安装 agent/mcp/skill，不需要 workspace 上下文
  if (activeView === 'marketplace') {
    return <ResourceLibraryView />;
  }

  // workgroups 视图（M2.1 T2）：工作组是节点级能力，不依赖工作空间——
  // 必须在 workspace 守卫之前分发（D2 治愈：新设备未建工作空间也能接入 hub）
  if (activeView === 'workgroups') {
    return <WorkgroupView />;
  }

  // settings 视图（M2.2 P2-8）：设置页不依赖工作空间（11 分类中 8 个为全局：
  // 模型服务/默认模型/会话设置/插件/外观/安全沙箱/momo-hub/关于）——分发必须
  // 先于 workspace 守卫，0-ws 态可进设置；workspace 级分类（记忆/浏览器/
  // 审计日志）由 SettingsView 内部占位提示（Git 策略 2026-11-09 下线）
  if (activeView === 'settings') {
    return <SettingsView />;
  }

  // 0-ws 主区引导（T2 改造，spec 2026-11-13 §4.3：嵌入表单退役——正常入口是
  // App 级 WorkspaceGate，此处仅防御性兜底；按钮 + Dialog 形态，取消语义成立）
  if (!workspace) {
    return (
      <div className="flex flex-1 items-center justify-center bg-canvas p-6">
        <div className="flex w-full max-w-md flex-col items-center gap-5">
          <EmptyState
            icon={Folder}
            title="创建或选择一个工作空间开始"
            description="工作空间是 agent 协作与文件沙箱的根目录；也可先在左侧活动栏进入「工作组」接入节点网络"
          />
          <Button
            type="button"
            onClick={() => setWsDialogOpen(true)}
          >
            <Plus size={14} strokeWidth={1.75} aria-hidden /> 新建工作空间
          </Button>
          {wsDialogOpen && (
            <CreateWorkspaceDialog
              onClose={() => {
                setWsDialogOpen(false);
                void useWorkspaceStore.getState().load();
              }}
            />
          )}
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
          {/* 会话头部：会话名 + 工具上限徽标（收起时首位停靠恢复按钮） */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-subtle bg-surface-1">
            <SidebarRestoreButton />
            <span className="min-w-0 max-w-[46%] truncate text-sm text-primary">
              {activeSession ? activeSession.title : '未选择房间'}
            </span>
            {activeSession?.kind === 'task_execution' && !localExecution && activeSessionId && (
              <RemoteSessionStatusInline sessionId={activeSessionId} />
            )}
            <span className="flex-1" />
            {activeSessionId && <RoomToolBudgetBadge sessionId={activeSessionId} />}
            {activeSessionId && <ExportChatButton sessionId={activeSessionId} />}
            {activeSessionId && <TaskProgressButton sessionId={activeSessionId} />}
            {/* P2-D：在途子任务面板入口（2s 轮询 + 单链取消，spec 2026-10-13 §9） */}
            {activeSessionId && <InFlightPanel sessionId={activeSessionId} />}
          </div>
          {localExecution && executionTask !== null && activeSessionId ? (
            <LocalAcceptanceNotice sessionId={activeSessionId} taskId={executionTask.id} />
          ) : null}
          {activeSession?.kind === 'task_execution' && !localExecution ? (
            <RemoteSessionPanel
              sessionId={activeSession.id}
              workspaceId={activeSession.workspaceId}
              footerExpanded={acceptanceFullscreen}
              footerSlot={
                activeSessionId ? (
                  <HumanRequestPanel
                    sessionId={activeSessionId}
                    onAcceptanceFullscreenChange={setAcceptanceFullscreen}
                  />
                ) : null
              }
            />
          ) : (
            <>
              <MessageList />
              <InputToolbar
                showMembers={showMembers}
                onToggleMembers={() => setShowMembers((v) => !v)}
                disabled={!activeSessionId}
              />
            </>
          )}
          {/* 会话请求面板（任务生命周期 v2 T22）：composer 上方唯一人工行动入口，
              未决时出现；普通会话在此挂载；任务执行会话经 RemoteSessionPanel 的
              footerSlot 承载（流域 → 动作区 → 指令输入框，spec §12.3） */}
          {activeSessionId && !(activeSession?.kind === 'task_execution' && !localExecution) && (
            <HumanRequestPanel
              sessionId={activeSessionId}
              // 本机执行会话（2026-11-19）：验收卡不出现——本地执行无跨节点交付
              // 审查语义，裁决在看板任务详情（TaskDetailPanel #21 accept/reject）；
              // 判定键 = 关联任务本机执行（而非 activeSession.kind——「指定会话」
              // 模式的任务跑在你手工建的 chat 会话里，kind 是 chat）；执行中的
              // tool_gate/question/manual_action 照常保留（执行交互）
              excludeKinds={localExecution ? LOCAL_TASK_EXCLUDED_KINDS : undefined}
            />
          )}
          {/* 输入面：普通会话与本机任务会话同构（消息即与执行 agent 对话——执行中
              车道被占时 RouterService 自动走 steer 注入）；远端跟踪会话的输入面
              是面板内 steer composer */}
          {!(activeSession?.kind === 'task_execution' && !localExecution) && <MentionInput />}
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
        {/* v2.7 Task 8：浏览器侧栏（spec §2.1 布局——chat 列右侧兄弟节点；
            chrome 属 renderer，页面内容由主进程按占位区 rect 叠加） */}
        <BrowserSidebar workspaceId={workspace.id} />
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

  // plugin 视图（工作空间维度 v1.1）：插件 page 面板的主区独立页面
  if (activeView === 'plugin') {
    return <PanelPageView />;
  }

  // 兜底（所有 ViewKey 已在上方分支处理，理论上不可达）
  return (
    <div className="flex flex-1 items-center justify-center bg-canvas">
      <p className="text-sm text-tertiary">未知视图</p>
    </div>
  );
}
