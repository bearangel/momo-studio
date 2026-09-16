// renderer/src/components/im/InputToolbar.tsx
//
// 输入框上方工具条：成员切换按钮 + 创建任务按钮（B7）+ 📎 文件引用入口（Task 10），
// 预留更多扩展位。showMembers 状态由 MiddlePanel 管理；📎 点击递增 session.store
// 的 fileTriggerTick（与 inputFocusTick 同型信号），MentionInput 订阅后聚焦并
// 插入 '@/' 触发文件菜单——不引 refs/context 跨组件耦合。
import { Paperclip, Users } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useSessionStore } from '../../stores/session.store';
import { IconButton } from '../ui/IconButton';
import { CreateTaskButton } from './CreateTaskButton';

interface Props {
  /** 成员浮层是否打开（按钮高亮） */
  showMembers: boolean;
  /** 切换成员浮层 */
  onToggleMembers: () => void;
  /** 无选中会话时禁用 */
  disabled: boolean;
  /** 当前 workspace ID（提供时渲染创建任务按钮） */
  workspaceId?: string;
  /** 当前会话 ID（CreateTaskButton 的 sourceSessionId） */
  activeSessionId?: string;
}

export function InputToolbar({
  showMembers,
  onToggleMembers,
  disabled,
  workspaceId,
  activeSessionId,
}: Props) {
  // 会话只读（有效成员全失效）时与 MentionInput 输入框同步禁用 📎
  const readOnly = useSessionStore((s) => s.activeSessionReadOnly);
  return (
    <div className="flex items-center gap-2 px-3 py-1 border-t border-subtle bg-surface-1">
      <button
        type="button"
        onClick={onToggleMembers}
        disabled={disabled}
        aria-label="成员"
        title="查看成员"
        aria-pressed={showMembers}
        className={cn(
          'inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-40',
          showMembers
            ? 'bg-surface-active text-accent-600 dark:text-accent-300'
            : 'text-secondary hover:bg-surface-3 hover:text-primary',
        )}
      >
        <Users size={12} strokeWidth={1.75} aria-hidden />
        <span>成员</span>
      </button>
      {workspaceId && activeSessionId && (
        <CreateTaskButton workspaceId={workspaceId} sourceSessionId={activeSessionId} />
      )}
      <IconButton
        aria-label="引用文件"
        title="引用文件"
        disabled={disabled || readOnly}
        onClick={() => useSessionStore.getState().bumpFileTrigger()}
      >
        <Paperclip size={16} strokeWidth={1.75} aria-hidden />
      </IconButton>
      {/* 预留扩展位：表情等未来功能 */}
    </div>
  );
}
