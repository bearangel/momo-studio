// renderer/src/components/im/SessionTodoBar.tsx
//
// 会话底部常驻任务条 v2（spec 2026-09-18-session-todo-bar-ux-refine-design.md）：
//   - 活清单：默认显示最新一份候选（流式优先，新轮次 todowrite 直接替换）
//   - 默认折叠：摘要行 = 图标 + n/m + 进度条 + ▶ 当前进行项；点击或 Ctrl+T 切换；
//     展开列表 max-h 32vh 内部滚动；用户展开选择跨替换保持
//   - 页签仅当 ≥2 候选同时 streaming；点击固定，固定候选由流式转终态自动解除
//     （v1 prevPinnedStatusRef 语义保留）；全部转终态页签消失
//   - 历史 ▾：候选 >1 时出现；点击临时查看快照 + 返回最新；候选增员 / 新流式
//     开始 / 切会话自动退出历史查看
//   - ✕ 关闭：隐藏；候选增员才重现；切会话重置全部交互状态（v1 语义不变）
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, History, ListTodo, Play, X } from 'lucide-react';
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

  // v1 语义：手动固定（null=自动）与 ✕ 关闭
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // v2：默认折叠（跨候选替换保持）；历史临时查看；历史下拉开关
  const [expanded, setExpanded] = useState(false);
  const [historyViewId, setHistoryViewId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // 候选集推导（时间序，含子 agent 消息）——与 v1 相同
  const candidates = useMemo<TodoCandidate[]>(() => {
    const list: TodoCandidate[] = [];
    for (const msg of messages ?? []) {
      if (msg.sender === 'owner') continue;
      const stream = streams.get(msg.id);
      if (stream && stream.todos.length > 0) {
        list.push({ messageId: msg.id, sender: msg.sender, stream });
      }
    }
    return list;
  }, [messages, streams]);

  const streamingCandidates = useMemo(
    () => candidates.filter((c) => c.stream.status === 'streaming'),
    [candidates],
  );
  // v2：仅多流式并行才出现页签
  const showTabs = streamingCandidates.length >= 2;

  const candidateIds = useMemo(() => candidates.map((c) => c.messageId).join(','), [candidates]);
  const streamingIds = useMemo(
    () => streamingCandidates.map((c) => c.messageId).join(','),
    [streamingCandidates],
  );

  // 固定候选「由流式转入终态」→ 解除固定（固定已完成历史候选不受影响——wasStreaming 守卫）
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

  // 候选增员 → 清 dismissed（v1）+ 退出历史查看（v2 spec §3）
  const prevIdsRef = useRef<string>(candidateIds);
  useEffect(() => {
    const prev = new Set(prevIdsRef.current.split(',').filter(Boolean));
    const grew = candidateIds
      .split(',')
      .filter(Boolean)
      .some((id) => !prev.has(id));
    if (grew) {
      setDismissed(false);
      setHistoryViewId(null);
    }
    prevIdsRef.current = candidateIds;
  }, [candidateIds]);

  // 新流式开始（出现此前不在流式集合中的候选）→ 退出历史查看（v2 spec §3）
  const prevStreamingIdsRef = useRef<string>(streamingIds);
  useEffect(() => {
    const prev = new Set(prevStreamingIdsRef.current.split(',').filter(Boolean));
    const anyNew = streamingIds
      .split(',')
      .filter(Boolean)
      .some((id) => !prev.has(id));
    if (anyNew) setHistoryViewId(null);
    prevStreamingIdsRef.current = streamingIds;
  }, [streamingIds]);

  // 切会话：全部交互状态重置（v2 在 v1 基础上加 expanded / historyViewId / historyOpen）
  const prevSessionRef = useRef<string | null>(activeSessionId);
  useEffect(() => {
    if (prevSessionRef.current !== activeSessionId) {
      prevSessionRef.current = activeSessionId;
      setPinnedId(null);
      setDismissed(false);
      setExpanded(false);
      setHistoryViewId(null);
      setHistoryOpen(false);
    }
  }, [activeSessionId]);

  // Ctrl+T 切换展开（已核实全仓库无快捷键冲突；capture 阶段拦截默认行为）。
  // 任务条可见（非 dismissed 且有候选）时才注册监听——隐藏态不翻转展开，
  // 避免重现时意外展开（v2 终审 Important 项）
  const barVisible = !dismissed && candidates.length > 0;
  useEffect(() => {
    if (!barVisible) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        setExpanded((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [barVisible]);

  if (dismissed || candidates.length === 0) return null;

  // 激活候选：历史查看 > 固定 > 最后流式 > 最后候选（最新活清单）
  const historyView =
    historyViewId !== null ? candidates.find((c) => c.messageId === historyViewId) : undefined;
  const active: TodoCandidate =
    historyView ??
    pinned ??
    [...streamingCandidates].reverse()[0] ??
    candidates[candidates.length - 1]!;
  const isHistory = historyView !== undefined;

  const todos = active.stream.todos;
  const doneCount = todos.filter((t) => t.status === 'completed').length;
  const totalCount = todos.length;
  const progressPct = Math.round((doneCount / totalCount) * 100);
  const currentSubject = todos.find((t) => t.status === 'in_progress')?.subject ?? null;

  const doneOf = (c: TodoCandidate): string => {
    const done = c.stream.todos.filter((t) => t.status === 'completed').length;
    return `${done}/${c.stream.todos.length}`;
  };

  return (
    <div className="border-t border-subtle bg-surface-1 px-3 py-1.5" data-testid="session-todo-bar">
      {/* 页签行：仅 ≥2 候选同时流式（v2——历史候选不再占位） */}
      {showTabs && (
        <div className="mb-1 flex flex-wrap gap-1" role="tablist" aria-label="活跃 agent 页签">
          {streamingCandidates.map((c) => {
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
                <span className="h-1.5 w-1.5 rounded-full bg-accent-500" aria-hidden />
                {resolveBotName(c.sender, botNameMap)} {doneOf(c)}
              </button>
            );
          })}
        </div>
      )}

      {/* 摘要行：整行点击切换展开；历史/关闭按钮 stopPropagation */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        data-testid="todo-summary"
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          // 只处理摘要行自身的键盘事件——嵌套按钮（返回最新/历史待办/关闭）的
          // Enter/Space 必须走按钮原生激活，不能被这里吞掉（Task 1 审查修订）
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        className="flex min-h-[26px] cursor-pointer items-center gap-2 text-xs"
      >
        {isHistory ? (
          <span className="flex flex-1 min-w-0 items-center gap-2 text-secondary">
            <History size={13} strokeWidth={1.75} aria-hidden className="shrink-0" />
            <span className="truncate">
              正在查看历史 · {resolveBotName(active.sender, botNameMap)} {doneOf(active)}
            </span>
            <button
              type="button"
              aria-label="返回最新"
              onClick={(e) => {
                e.stopPropagation();
                setHistoryViewId(null);
              }}
              className="shrink-0 text-accent-600 hover:underline dark:text-accent-300"
            >
              返回最新
            </button>
          </span>
        ) : (
          <>
            <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-primary">
              <ListTodo size={13} strokeWidth={1.75} aria-hidden />
              任务
              <span className="font-normal text-secondary">
                {doneCount}/{totalCount}
              </span>
            </span>
            <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-surface-3" aria-hidden>
              <span
                className="block h-full rounded-full bg-accent-500"
                style={{ width: `${progressPct}%` }}
              />
            </span>
            {currentSubject !== null && (
              <span className="inline-flex min-w-0 flex-1 items-center gap-1 text-secondary">
                <Play
                  size={11}
                  strokeWidth={1.75}
                  aria-hidden
                  className="shrink-0 text-accent-500"
                />
                <span className="truncate">{currentSubject}</span>
              </span>
            )}
            <span className="ml-auto shrink-0 text-tertiary" aria-hidden>
              {expanded ? (
                <ChevronDown size={12} strokeWidth={1.75} />
              ) : (
                <ChevronRight size={12} strokeWidth={1.75} />
              )}
            </span>
          </>
        )}

        {candidates.length > 1 && (
          <button
            type="button"
            aria-label="历史待办"
            title="查看历史待办清单"
            onClick={(e) => {
              e.stopPropagation();
              setHistoryOpen((v) => !v);
            }}
            className="shrink-0 rounded p-0.5 text-tertiary hover:text-primary"
          >
            <History size={14} strokeWidth={1.75} aria-hidden />
          </button>
        )}
        <button
          type="button"
          aria-label="关闭会话任务条"
          title="关闭（新待办出现时自动恢复）"
          onClick={(e) => {
            e.stopPropagation();
            setDismissed(true);
          }}
          className="shrink-0 rounded p-0.5 text-tertiary hover:text-primary"
        >
          <X size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      {/* 历史下拉：列出除当前激活外的全部候选（限高滚动） */}
      {historyOpen && (
        <div
          data-testid="todo-history-menu"
          className="mt-1 max-h-40 overflow-y-auto rounded border border-subtle bg-surface-2 py-1 text-xs"
        >
          {candidates
            .filter((c) => c.messageId !== active.messageId)
            .map((c) => (
              <button
                key={c.messageId}
                type="button"
                onClick={() => {
                  setHistoryViewId(c.messageId);
                  setExpanded(true);
                  setHistoryOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-1 text-left text-secondary transition-colors hover:bg-surface-3 hover:text-primary"
              >
                <History size={11} strokeWidth={1.75} aria-hidden className="shrink-0 text-tertiary" />
                <span className="truncate">{resolveBotName(c.sender, botNameMap)}</span>
                <span className="ml-auto shrink-0 text-tertiary">{doneOf(c)}</span>
              </button>
            ))}
        </div>
      )}

      {/* 展开列表：限高内部滚动（v2 痛点 1 对症） */}
      {expanded && (
        <div className="max-h-[32vh] overflow-y-auto" data-testid="todo-list-scroll">
          <TodoSection todos={todos} />
        </div>
      )}
    </div>
  );
}
