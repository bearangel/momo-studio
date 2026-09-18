// renderer/src/components/im/TaskProgressButton.tsx
//
// 会话头部任务按钮（spec docs/specs/2026-09-18-session-todo-header-button-design.md）：
//   - 「导出会话」旁常驻；无顶层清单目标时整体隐藏（子 agent 清单不抢占）
//   - 徽标 n/m = 最新「顶层 + 非用户」含清单消息进度；呼吸灯 = 会话内任一
//     含待办流（含子 agent）streaming
//   - 点击弹浮层：目标清单（实时刷新）+「定位到消息」；Esc / 点外部 / 再点收起；
//     定位 = scrollIntoView + todo-flash 闪烁，浮层关闭
//   - 动效 keyframes 按仓库惯例组件内 <style> 注入（先例 momo-stream-blink）
import { useEffect, useMemo, useRef, useState } from 'react';
import { ListTodo, LocateFixed, X } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore, type StreamState } from '../../stores/stream.store';
import { useBotNameMap, resolveBotName } from '../../lib/useBotNames';
import { cn } from '../../lib/cn';
import { TodoList } from './TodoList';

interface Props {
  sessionId: string;
}

/** 按钮目标：最新顶层含清单消息 */
interface Target {
  messageId: string;
  sender: string;
  stream: StreamState;
}

/** 定位闪烁停留时长（ms）——0.8s × 3 次 */
const FLASH_MS = 2400;

export function TaskProgressButton({ sessionId }: Props) {
  const messages = useSessionStore((s) => s.messagesBySession.get(sessionId));
  const streams = useStreamStore((s) => s.streams);
  const botNameMap = useBotNameMap();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 目标 = 最新「顶层 + 非用户」含清单消息（子 agent 清单留在嵌套区，spec §5）
  const target = useMemo<Target | null>(() => {
    let found: Target | null = null;
    for (const msg of messages ?? []) {
      if (msg.sender === 'owner') continue;
      if (msg.parentStreamSessionId !== null) continue;
      const stream = streams.get(msg.id);
      if (stream && stream.todos.length > 0) {
        found = { messageId: msg.id, sender: msg.sender, stream };
      }
    }
    return found;
  }, [messages, streams]);

  // 呼吸灯 = 会话内任一含待办流 streaming（含子 agent）
  const anyRunning = useMemo(() => {
    for (const msg of messages ?? []) {
      const stream = streams.get(msg.id);
      if (stream && stream.todos.length > 0 && stream.status === 'streaming') return true;
    }
    return false;
  }, [messages, streams]);

  // 会话切换 → 收起浮层（spec §6）
  const prevSessionRef = useRef(sessionId);
  useEffect(() => {
    if (prevSessionRef.current !== sessionId) {
      prevSessionRef.current = sessionId;
      setOpen(false);
    }
  }, [sessionId]);

  // Esc / 点外部收起（capture mousedown 覆盖浮层外任意按下）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e: MouseEvent): void => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick, true);
    };
  }, [open]);

  if (target === null) return null;

  const todos = target.stream.todos;
  const doneCount = todos.filter((t) => t.status === 'completed').length;

  /** 定位到目标气泡：滚动 + 闪烁，浮层收起 */
  const locate = (): void => {
    setOpen(false);
    const el = document.getElementById(`msg-${target.messageId}`);
    if (el === null) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('todo-flash');
    window.setTimeout(() => el.classList.remove('todo-flash'), FLASH_MS);
  };

  return (
    <div ref={rootRef} className="relative">
      {/* keyframes 组件内注入（仓库惯例，同 AgentStreamBubble momo-stream-blink） */}
      <style>{`
@keyframes momo-todo-breath{0%,100%{opacity:.3;transform:scale(.75)}50%{opacity:1;transform:scale(1.2)}}
@keyframes momo-todo-flash{0%,100%{box-shadow:0 0 0 0 transparent}50%{box-shadow:0 0 0 2px rgb(var(--accent-500))}}
.todo-breath-dot{display:inline-block;width:7px;height:7px;border-radius:9999px;animation:momo-todo-breath 1.6s ease-in-out infinite}
.todo-flash{animation:momo-todo-flash .8s ease-in-out 3}
      `}</style>
      <button
        type="button"
        aria-label="查看会话任务"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors',
          open
            ? 'bg-surface-active text-accent-600 dark:text-accent-300'
            : 'text-secondary hover:bg-surface-3 hover:text-primary',
        )}
      >
        <ListTodo size={14} strokeWidth={1.75} aria-hidden />
        任务 {doneCount}/{todos.length}
        {anyRunning && <span className="todo-breath-dot bg-accent-500" aria-hidden />}
      </button>

      {open && (
        <div
          data-testid="task-progress-popover"
          className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-subtle bg-surface-1 p-2 shadow-2xl"
        >
          <div className="flex items-center justify-between px-1 pb-1 text-xs">
            <span className="font-medium text-primary">
              {resolveBotName(target.sender, botNameMap)} · 任务 {doneCount}/{todos.length}
            </span>
            <button
              type="button"
              aria-label="收起任务浮层"
              onClick={() => setOpen(false)}
              className="rounded p-0.5 text-tertiary hover:text-primary"
            >
              <X size={13} strokeWidth={1.75} aria-hidden />
            </button>
          </div>
          <div className="max-h-[32vh] overflow-y-auto">
            <TodoList todos={todos} />
          </div>
          <button
            type="button"
            onClick={locate}
            className="mt-1 inline-flex w-full items-center justify-end gap-1 px-1 text-xs text-accent-600 hover:underline dark:text-accent-300"
          >
            <LocateFixed size={12} strokeWidth={1.75} aria-hidden />
            定位到消息
          </button>
        </div>
      )}
    </div>
  );
}
