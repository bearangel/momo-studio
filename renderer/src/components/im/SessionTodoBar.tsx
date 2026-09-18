// renderer/src/components/im/SessionTodoBar.tsx
//
// 会话底部常驻任务条（spec docs/specs/2026-09-18-session-todo-bar-design.md）：
//   - 候选集：当前会话 messagesBySession 中 streams.get(msg.id)?.todos.length > 0
//     的 agent 消息（含子 agent 消息——它们留在 store，只是不进顶层消息列表），按
//     数组序（时间序，loadOlder 头部插入）
//   - 单候选：无页签行，直接渲染 TodoSection；多候选：页签行（agent 名 + 各自进度）
//   - 激活页签：自动跟随最后一个 streaming 候选；无流式取最后候选（最新快照）；
//     手动点击固定，固定候选「由流式转入终态」后解除固定恢复自动跟随
//   - ✕ 手动关闭：隐藏；仅当候选集增员（新候选 id 出现）才重现
//   - 切换会话：pinned / dismissed 重置
//
// TodoSection 原样复用（流式展开 / 结束折叠 / 进度百分比）；key=messageId 切页签
// 时重挂载，展开态按新候选的 isStreaming 重新初始化。
import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore, type StreamState } from '../../stores/stream.store';
import { useBotNameMap, resolveBotName } from '../../lib/useBotNames';
import { cn } from '../../lib/cn';
import { TodoSection } from './TodoSection';

/** 一个待办候选：消息 id + 发送者 + 流聚合状态 */
interface TodoCandidate {
  messageId: string;
  sender: string;
  stream: StreamState;
}

export function SessionTodoBar() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const messages = useSessionStore((s) =>
    activeSessionId ? s.messagesBySession.get(activeSessionId) : undefined,
  );
  const streams = useStreamStore((s) => s.streams);
  const botNameMap = useBotNameMap();

  // 手动固定：null=自动跟随；否则固定候选的 messageId
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  // 手动关闭：仅候选集增员才清除（见 prevIdsRef effect）
  const [dismissed, setDismissed] = useState(false);

  // 候选集推导（时间序）
  const candidates = useMemo<TodoCandidate[]>(() => {
    const list: TodoCandidate[] = [];
    for (const msg of messages ?? []) {
      if (msg.sender === 'owner') continue; // 用户消息无流
      const stream = streams.get(msg.id);
      if (stream && stream.todos.length > 0) {
        list.push({ messageId: msg.id, sender: msg.sender, stream });
      }
    }
    return list;
  }, [messages, streams]);

  // 候选 id 逗号串——增员检测与重置判据的依赖项
  const candidateIds = useMemo(() => candidates.map((c) => c.messageId).join(','), [candidates]);

  // 固定候选「由流式转入终态」→ 解除固定（恢复自动跟随）。
  // 只在曾是 streaming 的固定被终结时解除——固定一个已完成的历史候选（回看）
  // 不受影响：prev 状态从 null 直接变 done，不满足 wasStreaming 条件。
  const pinned = pinnedId !== null ? candidates.find((c) => c.messageId === pinnedId) : undefined;
  const prevPinnedStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pinned) {
      prevPinnedStatusRef.current = null;
      return;
    }
    const wasStreaming = prevPinnedStatusRef.current === 'streaming';
    if (wasStreaming && pinned.stream.status !== 'streaming') setPinnedId(null);
    prevPinnedStatusRef.current = pinned.stream.status;
  }, [pinned]);

  // 候选集增员 → 清除 dismissed（新消息的流获得 todos 才重现；
  // 同一候选流式更新不顶回）。mount 时 prevIdsRef 已初始化为当前值，不算增员。
  const prevIdsRef = useRef<string>(candidateIds);
  useEffect(() => {
    const prev = new Set(prevIdsRef.current.split(',').filter(Boolean));
    const grew = candidateIds
      .split(',')
      .filter(Boolean)
      .some((id) => !prev.has(id));
    if (grew) setDismissed(false);
    prevIdsRef.current = candidateIds;
  }, [candidateIds]);

  // 切换会话：重置固定与关闭状态
  const prevSessionRef = useRef<string | null>(activeSessionId);
  useEffect(() => {
    if (prevSessionRef.current !== activeSessionId) {
      prevSessionRef.current = activeSessionId;
      setPinnedId(null);
      setDismissed(false);
    }
  }, [activeSessionId]);

  if (dismissed || candidates.length === 0) return null;

  // 激活候选：固定优先；否则自动跟随（最后一个流式 → 否则最后候选）
  const active: TodoCandidate =
    pinned ??
    [...candidates].reverse().find((c) => c.stream.status === 'streaming') ??
    candidates[candidates.length - 1]!;

  const doneOf = (c: TodoCandidate): string => {
    const done = c.stream.todos.filter((t) => t.status === 'completed').length;
    return `${done}/${c.stream.todos.length}`;
  };

  return (
    <div className="border-t border-subtle bg-surface-1 px-3 py-1.5" data-testid="session-todo-bar">
      <div className="flex min-h-[26px] items-center gap-2">
        {candidates.length > 1 ? (
          <div className="flex flex-1 flex-wrap gap-1" role="tablist" aria-label="会话任务页签">
            {candidates.map((c) => {
              const isActive = c.messageId === active.messageId;
              return (
                <button
                  key={c.messageId}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setPinnedId(c.messageId)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs transition-colors',
                    isActive
                      ? 'bg-surface-active text-accent-600 dark:text-accent-300'
                      : 'border border-subtle text-secondary hover:bg-surface-3 hover:text-primary',
                  )}
                >
                  {c.stream.status === 'streaming' && (
                    <span className="h-1.5 w-1.5 rounded-full bg-accent-500" aria-hidden />
                  )}
                  {resolveBotName(c.sender, botNameMap)} {doneOf(c)}
                </button>
              );
            })}
          </div>
        ) : (
          <span className="flex-1 text-xs text-tertiary">
            {resolveBotName(active.sender, botNameMap)} · 待办
          </span>
        )}
        <button
          type="button"
          aria-label="关闭会话任务条"
          title="关闭（新待办出现时自动恢复）"
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded p-0.5 text-tertiary hover:text-primary"
        >
          <X size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <TodoSection
        key={active.messageId}
        todos={active.stream.todos}
        isStreaming={active.stream.status === 'streaming'}
      />
    </div>
  );
}
