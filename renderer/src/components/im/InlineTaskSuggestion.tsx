// renderer/src/components/im/InlineTaskSuggestion.tsx
//
// agent inline 建议组件（B 子系统 B7）。
// agent 在回复中识别到值得跟踪的工作单元时，由 system prompt 指示在末尾输出特殊标记，
// renderer 解析后渲染此 chip。用户点击"创建任务"打开 CreateTaskDialog 并预填建议字段。
// v2.1：💡 → Lightbulb + token accent；📌 创建任务 → Button secondary sm + ListPlus；
// wrapperStyle → my-2 flex items-center gap-2 rounded border border-accent-500/40 bg-surface-active px-2 py-1.5。
import { useState } from 'react';
import { Lightbulb, ListPlus } from 'lucide-react';
import { Button } from '../ui/Button';
import { CreateTaskDialog } from './CreateTaskDialog';

interface InlineTaskSuggestionProps {
  workspaceId: string;
  sourceSessionId: string;
  sourceMessageId: string;
  suggestedTitle: string;
  suggestedDescription?: string;
  assigneeAgentId?: string;
}

export function InlineTaskSuggestion(props: InlineTaskSuggestionProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2 flex items-center gap-2 rounded border border-accent-500/40 bg-surface-active px-2 py-1.5">
      <span className="inline-flex items-center gap-1 text-xs text-accent-600 dark:text-accent-300">
        <Lightbulb size={12} strokeWidth={1.75} aria-hidden />
        要把这个转成任务吗？
      </span>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <ListPlus size={12} strokeWidth={1.75} aria-hidden />
        创建任务
      </Button>
      <CreateTaskDialog
        open={open}
        onClose={() => setOpen(false)}
        onCreated={() => {}}
        workspaceId={props.workspaceId}
        preset={{
          title: props.suggestedTitle,
          description: props.suggestedDescription,
          sourceSessionId: props.sourceSessionId,
          sourceMessageId: props.sourceMessageId,
          assigneeAgentId: props.assigneeAgentId,
        }}
      />
    </div>
  );
}