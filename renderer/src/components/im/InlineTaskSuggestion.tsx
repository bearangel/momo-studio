// renderer/src/components/im/InlineTaskSuggestion.tsx
//
// agent inline 建议组件（B 子系统 B7）。
// agent 在回复中识别到值得跟踪的工作单元时，由 system prompt 指示在末尾输出特殊标记，
// renderer 解析后渲染此 chip。用户点击"创建任务"打开 CreateTaskDialog 并预填建议字段。
import { useState } from 'react';
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
    <div style={wrapperStyle}>
      <span style={{ color: '#3b82f6', fontSize: 12 }}>💡 要把这个转成任务吗？</span>
      <button type="button" onClick={() => setOpen(true)} style={ctaStyle}>
        📌 创建任务
      </button>
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

const wrapperStyle: React.CSSProperties = {
  margin: '8px 0',
  padding: 8,
  backgroundColor: 'rgba(59,130,246,0.1)',
  border: '1px solid #3b82f6',
  borderRadius: 4,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};
const ctaStyle: React.CSSProperties = {
  fontSize: 12,
  padding: '2px 8px',
  background: 'transparent',
  border: '1px solid #3b82f6',
  borderRadius: 4,
  color: '#3b82f6',
  cursor: 'pointer',
};
