// renderer/src/components/im/SessionSidebarHeader.tsx
//
// v25 Task 14：会话区头部双常驻按钮（spec §6.2）。
//   Bolt 快速会话：ws 已设默认 agent → 免弹窗直达 createQuickSession；
//     未设默认 → 弹 DefaultAgentPickerDialog（选成员→设默认→onContinue 继续建会，
//     Picker 自带 ws 无成员引导文案）；store needsDefaultAgent（NO_DEFAULT_AGENT
//     错误态，如默认 agent 已被移出）同样触发 Picker。
//   Users 协作会话：挂载 CollabSessionDialog（T13 就绪）。
//
// T13 移交约定：Picker 在其 try 块内调用 onContinue 且不 await——消费方（本组件）
// 必须自行 catch 自己的错误，否则会成为未处理 rejection / 被 Picker 误显示。
import { useEffect, useState } from 'react';
import { Bolt, Users } from 'lucide-react';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSessionStore } from '../../stores/session.store';
import { DefaultAgentPickerDialog } from './DefaultAgentPickerDialog';
import { CollabSessionDialog } from './CollabSessionDialog';

export function SessionSidebarHeader() {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const createQuickSession = useSessionStore((s) => s.createQuickSession);
  const needsDefaultAgent = useSessionStore((s) => s.needsDefaultAgent);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);

  // needsDefaultAgent 错误态触发：store 在下次 createQuickSession 开始时复位标记，
  // effect 按翻转触发，不会重复弹（setPickerOpen 幂等）
  useEffect(() => {
    if (needsDefaultAgent) setPickerOpen(true);
  }, [needsDefaultAgent]);

  const handleQuick = async (): Promise<void> => {
    if (!workspace) return;
    if (workspace.defaultAgentInstanceId) {
      // 已设默认 → 免弹窗直达（spec §6.2）；错误由 store 内部消化（返回 false）
      await createQuickSession(workspace.id);
    } else {
      setPickerOpen(true);
    }
  };

  const handlePickerContinue = async (): Promise<void> => {
    if (!workspace) return;
    // 先关弹窗再建会：消费方错误不影响 Picker 展示
    setPickerOpen(false);
    try {
      await createQuickSession(workspace.id);
    } catch (err) {
      // 自 catch（T13 移交）：store action 异常不外溢为未处理 rejection
      console.error('快速会话创建失败:', err);
    }
  };

  return (
    <div className="flex gap-1.5 m-2 shrink-0">
      <button
        type="button"
        aria-label="快速会话"
        title="快速会话：直达工作空间默认 agent（未设置时先选择）"
        onClick={() => void handleQuick()}
        className="flex-1 text-xs px-2 py-1.5 rounded bg-surface-active text-accent-600 dark:text-accent-300 hover:opacity-90 transition-colors flex items-center justify-center gap-1"
      >
        <Bolt size={12} strokeWidth={1.75} aria-hidden />
        快速会话
      </button>
      <button
        type="button"
        aria-label="协作会话"
        title="协作会话：选择单个 agent 或团队"
        onClick={() => setCollabOpen(true)}
        className="flex-1 text-xs px-2 py-1.5 rounded bg-surface-2 text-secondary hover:text-primary transition-colors flex items-center justify-center gap-1"
      >
        <Users size={12} strokeWidth={1.75} aria-hidden />
        协作会话
      </button>

      {pickerOpen && workspace && (
        <DefaultAgentPickerDialog
          workspaceId={workspace.id}
          onContinue={() => void handlePickerContinue()}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {collabOpen && <CollabSessionDialog onClose={() => setCollabOpen(false)} />}
    </div>
  );
}
