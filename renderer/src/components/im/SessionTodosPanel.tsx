// renderer/src/components/im/SessionTodosPanel.tsx
//
// 会话 todo 聚合视图（spec docs/specs/2026-09-18-session-hygiene-batch-design.md §2c）：
// 会话主区消息列表上方挂载，把各 agent（PM + 子 agent）分散在各自消息流里的
// 清单聚合成会话级总览——用户/agent 可见历史各轮清单（§2b：不做跨轮携带，
// 连续性由本视图承担）。
//
// 数据流：session.store 消息 + stream.store 聚合态 → collectSessionTodos 纯函数；
// 无清单时整体返回 null（隐藏，不占布局）。条目渲染复用 TodoList（条目单源，
// 与气泡内联清单/头部任务浮层同款三态图标）。
import { useMemo } from 'react';
import { ListTodo } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore } from '../../stores/stream.store';
import { useBotNameMap } from '../../lib/useBotNames';
import { collectSessionTodos, type SessionTodoEntry } from '../../lib/session-todos';
import { TodoList } from './TodoList';
import { Badge } from '../ui/Badge';

interface Props {
  sessionId: string;
}

/** 单个 agent 分组：组头（agent 名 + 子 agent 标注 + N/M 完成）+ 清单条目 */
function TodoGroup({ entry }: { entry: SessionTodoEntry }) {
  const doneCount = entry.todos.filter((t) => t.status === 'completed').length;
  return (
    <section aria-label={`${entry.agentName} 的任务清单`}>
      <header className="flex items-center gap-1.5 px-2 text-xs">
        <ListTodo size={13} strokeWidth={1.75} aria-hidden className="shrink-0 text-secondary" />
        <span className="font-medium text-primary">{entry.agentName}</span>
        {entry.isSubAgent && (
          <Badge tone="neutral" className="h-4 px-1.5 text-[11px]">
            子 agent
          </Badge>
        )}
        <span className="ml-auto text-tertiary">
          {doneCount}/{entry.todos.length} 完成
        </span>
      </header>
      <TodoList todos={entry.todos} />
    </section>
  );
}

export function SessionTodosPanel({ sessionId }: Props) {
  const messages = useSessionStore((s) => s.messagesBySession.get(sessionId));
  const streams = useStreamStore((s) => s.streams);
  const botNameMap = useBotNameMap();

  const entries = useMemo(
    () => collectSessionTodos(messages ?? [], streams, botNameMap),
    [messages, streams, botNameMap],
  );

  // 无任何清单 → 整体隐藏（spec §2c：无清单时整体隐藏）
  if (entries.length === 0) return null;

  return (
    <div
      data-testid="session-todos-panel"
      className="max-h-[30vh] overflow-y-auto border-b border-subtle bg-surface-1 px-2 py-1.5 text-[13px] space-y-1.5"
    >
      {entries.map((entry) => (
        <TodoGroup key={entry.messageId} entry={entry} />
      ))}
    </div>
  );
}
