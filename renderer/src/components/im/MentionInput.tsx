// renderer/src/components/im/MentionInput.tsx
//
// 现役消息输入框（P3 Task 3：@ + # 双语法输入框替换 MessageInput）。
//   - 输入 @ 触发 agent 菜单：数据源 session.store.members（当前会话成员），
//     仅列 lastRunning 在线成员；选择时记录 instanceId，
//     发送经 session.store.sendMessage(body, mentionedInstanceIds) 透传
//   - 输入 #T 触发任务菜单：数据源 task.store.tasks（仅 draft/pending/assigned），
//     选择后向正文插入 #T-xxx 文本——后端 conflict-detector 从正文解析任务引用，
//     不进 sendMessage 载荷（纯 renderer affordance）
//   - 手动键入 @ 文本（不经菜单选择）不注册 mention——与原 MessageInput 一致
//   - 空态 parity：无激活会话禁用 + placeholder 提示；发送失败恢复正文与 mentions
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useSessionStore } from '../../stores/session.store';
import { useTaskStore } from '../../stores/task.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { SessionMemberInfo, TaskRow, TaskStatus } from '../../ipc/types';

type MenuKind = 'agent' | 'task';

/** # 菜单只展示未完结任务（task.store.load 已按此过滤拉取，此处保留作防御） */
const PENDING_TASK_STATUSES: ReadonlyArray<TaskStatus> = ['draft', 'pending', 'assigned'];
/** 菜单最多展示条目数（pending 任务可能较多） */
const MENU_LIMIT = 10;

export function MentionInput() {
  const [text, setText] = useState('');
  const [menuType, setMenuType] = useState<MenuKind | null>(null);
  const [query, setQuery] = useState('');
  // @ 目标 instanceId 列表（菜单选择时记录，发送后清空；失败恢复）
  const [pendingMentions, setPendingMentions] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const members = useSessionStore((s) => s.members);
  const sendMessage = useSessionStore((s) => s.sendMessage);
  const loadSessions = useSessionStore((s) => s.loadSessions);
  // 只读态（有效成员全失效，spec §7）与聚焦信号（新建会话后聚焦，spec §6.2）
  const readOnly = useSessionStore((s) => s.activeSessionReadOnly);
  const inputFocusTick = useSessionStore((s) => s.inputFocusTick);
  const workspace = useWorkspaceStore((s) => s.getActive());
  const { tasks, load: loadTasks } = useTaskStore();

  // 新建会话成功（inputFocusTick 递增）→ 聚焦输入框，⚡ 免弹窗直达后立即可输入
  useEffect(() => {
    if (inputFocusTick > 0) textareaRef.current?.focus();
  }, [inputFocusTick]);

  // 会话级草稿：切换会话时保存当前草稿、恢复目标会话草稿（无则空）。
  // 此前 text 是组件本地 state，切会话后内容残留串台。
  const draftsRef = useRef<Map<string, string>>(new Map());
  const prevSessionRef = useRef<string | null>(activeSessionId);
  useEffect(() => {
    if (prevSessionRef.current === activeSessionId) return;
    if (prevSessionRef.current !== null) draftsRef.current.set(prevSessionRef.current, text);
    const next = activeSessionId !== null ? (draftsRef.current.get(activeSessionId) ?? '') : '';
    setText(next);
    setMenuType(null);
    setQuery('');
    prevSessionRef.current = activeSessionId;
    // text 刻意不入依赖：仅在会话切换边界执行存取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // # 菜单数据接线：task.store 此前仅 TaskBoardView（tasks 视图）加载，
  // IM 视图挂载时主动拉取当前 workspace 的待处理任务
  useEffect(() => {
    if (workspace) void loadTasks(workspace.id);
  }, [workspace, loadTasks]);

  // 在线成员判定与 MembersPanel 同源：lastRunning = 用户最近运行意图
  const filteredMembers =
    menuType === 'agent'
      ? members
          .filter((m) => m.lastRunning)
          .filter((m) => {
            if (!query) return true;
            return m.agentName.toLowerCase().includes(query.toLowerCase());
          })
          .slice(0, MENU_LIMIT)
      : [];

  const filteredTasks =
    menuType === 'task'
      ? tasks
          .filter(
            (t) =>
              PENDING_TASK_STATUSES.includes(t.status) &&
              (!query ||
                t.id.toLowerCase().includes(query.toLowerCase()) ||
                t.title.toLowerCase().includes(query.toLowerCase())),
          )
          .slice(0, MENU_LIMIT)
      : [];

  /** 光标前缀触发检测：@ 接 slug 局部 / # 接 T-数字局部（输入事件时刻取光标值，防中间输入漂移） */
  const detectTrigger = (newValue: string, cursorPos: number): void => {
    const before = newValue.slice(0, cursorPos);
    const atMatch = before.match(/(?:^|\s)@([A-Za-z0-9-]*)$/);
    // 任务 trigger 允许 T-/数字 的任意局部输入，有效性在 filteredTasks 按 id/title 过滤
    const taskMatch = before.match(/(?:^|\s)#([A-Za-z0-9-]*)$/);
    if (atMatch) {
      setMenuType('agent');
      setQuery(atMatch[1] ?? '');
    } else if (taskMatch) {
      setMenuType('task');
      setQuery(taskMatch[1] ?? '');
    } else {
      setMenuType(null);
      setQuery('');
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setText(newValue);
    detectTrigger(newValue, e.target.selectionStart ?? newValue.length);
  };

  /** 替换光标前最近的 @xxx / #T-xxx 局部输入为完整标记；尾随空格防继续输入粘连破坏 mention 边界 */
  const insertMention = (marker: string): void => {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = text.slice(0, pos);
    const after = text.slice(pos);
    // 局部匹配字符集与 detectTrigger 一致（覆盖 '@'、'#T' 等未敲完的局部输入）
    const newValue =
      before.replace(
        /(?:^|\s)(@[A-Za-z0-9-]*$|#[A-Za-z0-9-]*$)/,
        (match, partial: string) => match.replace(partial, marker),
      ) + ' ' + after;
    setText(newValue);
    setMenuType(null);
    setQuery('');
    // 焦点与光标回到标记末尾（菜单按钮点击会移走焦点）
    setTimeout(() => {
      ta.focus();
      const newPos = newValue.length - after.length;
      ta.setSelectionRange(newPos, newPos);
    }, 0);
  };

  const selectMember = (m: SessionMemberInfo): void => {
    insertMention(`@${m.agentName}`);
    setPendingMentions((prev) =>
      prev.includes(m.instanceId) ? prev : [...prev, m.instanceId],
    );
  };

  const selectTask = (t: TaskRow): void => {
    insertMention(`#${t.id}`);
  };

  const handleSend = async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || !activeSessionId) return;
    const mentions = pendingMentions.length > 0 ? [...pendingMentions] : undefined;
    setText('');
    setPendingMentions([]);
    setMenuType(null);
    setQuery('');
    try {
      await sendMessage(trimmed, mentions);
      await loadSessions();
    } catch {
      // 发送失败恢复正文与 mentions，用户可修改后重发
      setText(trimmed);
      if (mentions) setPendingMentions(mentions);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuType !== null && e.key === 'Escape') {
      setMenuType(null);
      return;
    }
    // 输入法组合期（中文拼音选字等）的 Enter 是选字确认不是发送——
    // isComposing 或历史 keyCode 229（Safari 等 IME 事件）都跳过
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // 菜单激活时 Enter 不发送（避免选菜单途中误发），Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey && menuType === null) {
      e.preventDefault();
      void handleSend();
    }
  };

  /** instanceId → 展示名（mention chip 用；不在成员列表时回退 id） */
  const mentionDisplayName = (instanceId: string): string => {
    return members.find((m) => m.instanceId === instanceId)?.agentName ?? instanceId;
  };

  return (
    <div className="border-t border-border-subtle bg-bg-secondary p-3 relative">
      {menuType === 'agent' && filteredMembers.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 mb-1 bg-bg-tertiary border border-border-subtle rounded-lg shadow-xl py-1 max-h-48 overflow-auto z-50">
          <div className="px-3 py-1 text-xs text-neutral-500">选择要 @ 的 agent</div>
          {filteredMembers.map((m) => (
            <button
              key={m.instanceId}
              type="button"
              onClick={() => selectMember(m)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-bg-primary flex items-center gap-2"
            >
              <span>{m.iconEmoji || '🤖'}</span>
              <span className="truncate">{m.agentName}</span>
            </button>
          ))}
        </div>
      )}

      {menuType === 'task' && filteredTasks.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 mb-1 bg-bg-tertiary border border-border-subtle rounded-lg shadow-xl py-1 max-h-48 overflow-auto z-50">
          <div className="px-3 py-1 text-xs text-neutral-500">选择要引用的任务</div>
          {filteredTasks.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => selectTask(t)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-bg-primary flex items-center gap-2"
            >
              <span>📌</span>
              <span className="truncate">
                #{t.id} · {t.title}
              </span>
            </button>
          ))}
        </div>
      )}

      {pendingMentions.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {pendingMentions.map((instanceId) => (
            <button
              key={instanceId}
              type="button"
              onClick={() =>
                setPendingMentions((prev) => prev.filter((m) => m !== instanceId))
              }
              className="text-xs px-2 py-0.5 rounded bg-accent-blue/20 text-accent-blue hover:bg-red-500/20 hover:text-red-400"
            >
              @{mentionDisplayName(instanceId)} ×
            </button>
          ))}
        </div>
      )}

      {readOnly && (
        <div className="mb-2 text-xs text-neutral-500">🔒 会话成员已全部移出，会话只读（历史可查看）</div>
      )}

      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={!activeSessionId || readOnly}
        placeholder={
          readOnly
            ? '会话只读'
            : activeSessionId
              ? '输入消息，Enter 发送。输入 @ 提到 agent，# 引用任务'
              : '请先选择房间'
        }
        rows={2}
        className="w-full resize-none rounded-md bg-bg-tertiary border border-border-subtle px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:border-accent-blue focus:outline-none disabled:opacity-50"
      />
    </div>
  );
}
