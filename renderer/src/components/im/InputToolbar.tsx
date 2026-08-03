// renderer/src/components/im/InputToolbar.tsx
//
// 输入框上方工具条：本次放成员切换按钮，预留扩展位（附件/表情等未来功能）。
// 纯展示组件，状态由 MiddlePanel 管理（showMembers + onToggleMembers）。
import { cn } from '../../lib/cn';

interface Props {
  /** 成员浮层是否打开（按钮高亮） */
  showMembers: boolean;
  /** 切换成员浮层 */
  onToggleMembers: () => void;
  /** 无选中房间时禁用 */
  disabled: boolean;
}

export function InputToolbar({ showMembers, onToggleMembers, disabled }: Props) {
  return (
    <div className="flex items-center gap-2 px-3 py-1 border-t border-border-subtle bg-bg-secondary">
      <button
        type="button"
        onClick={onToggleMembers}
        disabled={disabled}
        aria-label="成员"
        title="查看成员"
        aria-pressed={showMembers}
        className={cn(
          'inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          showMembers
            ? 'bg-accent-blue/20 text-accent-blue'
            : 'text-neutral-400 hover:bg-bg-tertiary hover:text-neutral-200',
        )}
      >
        <span>👥</span>
        <span>成员</span>
      </button>
      {/* 预留扩展位：附件、表情等未来功能 */}
    </div>
  );
}
