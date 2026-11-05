// renderer/src/components/im/InputToolbar.tsx
//
// 输入框上方工具条（2026-11-05 工具条可视化，预览合同
// .omo/previews/2026-11-05-session-toolbar-visual-selectors.html）：
//   - 五个选择按钮（定序）：Agent / 技能 / 文件 / 会话 / 任务——点击经
//     bumpMentionTrigger(kind) 聚焦输入框并打开限定单组的选择菜单（菜单本体、
//     触发符插入、组过滤都在 MentionInput；此处只发信号）
//   - 成员按钮贴右（ml-auto 分区：选择类 vs 会话管理）
//   - 创建任务按钮下线（CreateTaskButton 已删；创建入口保留在任务看板与消息流 chip）
//   - 按钮激活态：mentionScope === kind（菜单打开期间高亮，随菜单关闭解除）
import {
  Bot,
  FileText,
  MessagesSquare,
  Pin,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useSessionStore, type MentionTriggerKind } from '../../stores/session.store';

interface Props {
  /** 成员浮层是否打开（按钮高亮） */
  showMembers: boolean;
  /** 切换成员浮层 */
  onToggleMembers: () => void;
  /** 无选中会话时禁用 */
  disabled: boolean;
}

/** 五个选择按钮（预览合同定序；图标与菜单组图标同源 GroupIcon） */
const SELECTORS: ReadonlyArray<{
  kind: MentionTriggerKind;
  label: string;
  title: string;
  Icon: LucideIcon;
}> = [
  { kind: 'agent', label: 'Agent', title: '选择要 @ 的 agent', Icon: Bot },
  { kind: 'skill', label: '技能', title: '选择技能', Icon: Zap },
  { kind: 'file', label: '文件', title: '引用文件 / 从电脑导入', Icon: FileText },
  { kind: 'session', label: '会话', title: '引用其他会话', Icon: MessagesSquare },
  { kind: 'task', label: '任务', title: '引用任务', Icon: Pin },
];

export function InputToolbar({ showMembers, onToggleMembers, disabled }: Props) {
  const mentionScope = useSessionStore((s) => s.mentionScope);
  const readOnly = useSessionStore((s) => s.activeSessionReadOnly);
  const selDisabled = disabled || readOnly;

  return (
    <div className="flex items-center gap-2 px-3 py-1 border-t border-subtle bg-surface-1">
      {SELECTORS.map(({ kind, label, title, Icon }) => (
        <button
          key={kind}
          type="button"
          onClick={() => useSessionStore.getState().bumpMentionTrigger(kind)}
          disabled={selDisabled}
          aria-label={label}
          title={title}
          aria-pressed={mentionScope === kind}
          className={cn(
            'inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
            'disabled:cursor-not-allowed disabled:opacity-40',
            mentionScope === kind
              ? 'bg-surface-active text-accent-600 dark:text-accent-300'
              : 'text-secondary hover:bg-surface-3 hover:text-primary',
          )}
        >
          <Icon size={12} strokeWidth={1.75} aria-hidden />
          <span>{label}</span>
        </button>
      ))}
      <button
        type="button"
        onClick={onToggleMembers}
        disabled={disabled}
        aria-label="成员"
        title="查看成员"
        aria-pressed={showMembers}
        className={cn(
          'ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-40',
          showMembers
            ? 'bg-surface-active text-accent-600 dark:text-accent-300'
            : 'text-secondary hover:bg-surface-3 hover:text-primary',
        )}
      >
        <Users size={12} strokeWidth={1.75} aria-hidden />
        <span>成员</span>
      </button>
    </div>
  );
}
