// renderer/src/components/hub/RemoteSteerComposer.tsx
//
// 远端会话 composer（spec 2026-11-17 §7.3，D「复用会话框」收口）：输入即 steer——
// 发送按钮「发送指令」，Enter 提交（Shift+Enter 换行）；乐观气泡与回流消解在
// RemoteSessionView 帧尾（store.pendingSteers）。门控：终态禁用 + 占位
// 「任务已结束」；未开始/离线的发送失败由 store 落 failed 人话（hub 既有文案）。
// 形态对齐 MentionInput 视觉语言（textarea + 右下发送钮）；退役 SteerEntry（CONTRACT #11-16）。
import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft } from 'lucide-react';
import { cn } from '../../lib/cn';
import { isTerminalStatus } from '../../lib/board';
import { useRemoteSessionStore } from '../../stores/remote-session.view';
import { loadSteerDraft, saveSteerDraft } from '../im/composer-drafts';
import type { TaskRow } from '../../ipc/types';

/** steer 上限（码点）——沿 SteerEntry 常量（hub 侧 1..4000 同界） */
const STEER_MAX_CODEPOINTS = 4000;

export function RemoteSteerComposer({
  sessionId,
  /** 受控模式（2026-11-19 本机任务会话）：任务与发送直连（task:get + task:steer
   *  本机分支），不经 remote-session store——本机形态无帧流/订阅，乐观气泡省略
   *  （steer 消息由子进程 drain 落库 → MessageList 推送可见）。 */
  task: controlledTask,
  send: controlledSend,
}: {
  sessionId: string;
  task?: TaskRow | null;
  send?: (text: string) => Promise<unknown>;
}): React.JSX.Element | null {
  const controlled = controlledSend !== undefined;
  const storeTask = useRemoteSessionStore((s) => s.task);
  const storeSendSteer = useRemoteSessionStore((s) => s.sendSteer);
  const task = controlled ? (controlledTask ?? null) : storeTask;
  const sendSteer = controlled ? controlledSend : storeSendSteer;
  // 草稿存模块级仓（composer-drafts）：面板切换卸载（MiddlePanel 条件渲染）
  // 后重挂载原样恢复（2026-11-19 与会话框同源修复）；useState 初始值即恢复值
  const [text, setText] = useState(() => loadSteerDraft(sessionId));
  const [sending, setSending] = useState(false);
  // 切会话（sessionId prop 变化，不卸载）：换仓恢复目标会话草稿
  const prevSessionRef = useRef(sessionId);
  useEffect(() => {
    if (prevSessionRef.current === sessionId) return;
    prevSessionRef.current = sessionId;
    setText(loadSteerDraft(sessionId));
  }, [sessionId]);
  // 写穿：text 变化即落仓（空串删除条目），卸载/重挂载零额外保存逻辑
  useEffect(() => {
    saveSteerDraft(sessionId, text);
  }, [sessionId, text]);

  const terminal = task !== null && isTerminalStatus(task.status);
  const awaitingDecision = task !== null && task.status === 'submitted';
  /** 不可 steer 的两态直接不渲染（spec 2026-11-18 DEC-10 修订）：
   *  待裁决期决策归验收卡，执行方本机无 steer 权——留死输入框只会误导。
   *  受控模式（本机任务会话）in 行不藏：执行在本机，操作者补充指令合法
   *  （2026-11-19 本机 steer 分支语义）。 */
  const hidden = awaitingDecision || (!controlled && task !== null && task.delegationRole === 'in');
  const disabled = terminal;
  const codepoints = Array.from(text).length;
  const overLimit = codepoints > STEER_MAX_CODEPOINTS;
  const canSend = !disabled && !sending && text.trim() !== '' && !overLimit;

  const submit = (): void => {
    // 受控模式无 store 任务行也可发（门控由受控 task 终态承担）
    if (!canSend || (!controlled && task === null)) return;
    setSending(true);
    void sendSteer(text.trim()).finally(() => {
      setText('');
      setSending(false);
    });
  };

  if (hidden) return null;

  return (
    <div className="shrink-0 border-t border-subtle bg-surface-1 px-4 py-2.5" data-testid="remote-steer-composer">
      <div className="relative rounded-[10px] border border-strong bg-surface-1 focus-within:border-focus">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={disabled}
          rows={2}
          placeholder={terminal ? '任务已结束' : '补充指令…（Enter 发送 · Shift+Enter 换行）'}
          className="w-full resize-none rounded-[10px] bg-transparent px-3 py-2 pr-16 text-[13px] leading-[1.6] text-primary placeholder:text-tertiary focus:outline-none disabled:cursor-not-allowed"
          data-testid="remote-steer-input"
        />
        <button
          type="button"
          aria-label="发送指令"
          onClick={submit}
          disabled={!canSend}
          className={cn(
            'absolute bottom-2 right-2 inline-flex h-[26px] cursor-pointer items-center gap-1 rounded-md px-2.5 text-[11.5px] font-medium',
            canSend
              ? 'bg-accent-500 text-inverse hover:bg-accent-600'
              : 'cursor-not-allowed bg-surface-3 text-disabled',
          )}
        >
          <CornerDownLeft size={12} strokeWidth={1.75} aria-hidden />
          {sending ? '发送中…' : '发送指令'}
        </button>
      </div>
      <div className="mt-1 flex justify-end text-[10px] text-tertiary">
        <span className={cn(overLimit && 'text-status-error')}>{codepoints}/{STEER_MAX_CODEPOINTS}</span>
      </div>
    </div>
  );
}
