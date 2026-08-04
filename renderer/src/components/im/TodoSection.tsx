// renderer/src/components/im/TodoSection.tsx
//
// v1.5 任务面板：把 agent 的 TodoItem[] 渲染为可折叠列表（含完成进度）。
// 流式中（isStreaming=true）默认展开；流式结束后 useEffect 自动折叠为收起态。
// 空数组返回 null，不占任何 DOM 节点。
//
// 集成位置：AgentStreamBubble / SubAgentSection 的 ThinkingSection 之后、ToolCallChip 之前。
// 数据来源：stream.todos（StreamState），由 todo_update chunk 全量替换。
import { useEffect, useState } from 'react';
import type { TodoItem } from '../../ipc/types';

interface Props {
  todos: TodoItem[];
  isStreaming: boolean;
}

export function TodoSection({ todos, isStreaming }: Props) {
  const [expanded, setExpanded] = useState(isStreaming);

  useEffect(() => {
    if (!isStreaming) setExpanded(false);
  }, [isStreaming]);

  if (todos.length === 0) return null;

  const doneCount = todos.filter((t) => t.status === 'completed').length;
  const totalCount = todos.length;
  const progressPct = Math.round((doneCount / totalCount) * 100);

  return (
    <div
      style={{
        margin: '8px 0',
        border: '1px solid #333',
        borderRadius: 4,
        overflow: 'hidden',
        fontSize: 13,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          width: '100%',
          padding: '6px 12px',
          background: 'rgba(255,255,255,0.04)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          border: 'none',
          color: 'inherit',
        }}
      >
        <span style={{ fontWeight: 500 }}>📋 任务</span>
        <span style={{ color: '#888', fontSize: 12 }}>
          {doneCount}/{totalCount}（{progressPct}%）{expanded ? '▼' : '▶'}
        </span>
      </button>
      {expanded && (
        <ul style={{ padding: '8px 12px', margin: 0, listStyle: 'none' }}>
          {todos.map((t, i) => {
            const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '○';
            // 状态视觉：completed 划线+半透明；in_progress 蓝色加粗；pending 默认。
            // 用 Tailwind 标准 utility class（非任意值），便于测试通过 class 断言。
            const stateCls =
              t.status === 'completed'
                ? 'line-through opacity-60'
                : t.status === 'in_progress'
                  ? 'text-blue-400 font-medium'
                  : '';
            return (
              <li
                key={t.id}
                className={`flex gap-2 ${stateCls}`}
                style={{ marginBottom: i === todos.length - 1 ? 0 : 4 }}
              >
                <span aria-hidden>{icon}</span>
                <span>
                  {i + 1}. {t.subject}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
