// renderer/src/components/hub/SteerEntry.tsx
//
// 发起方补充指令入口（P3 S3，spec 2026-11-13 §8.2 steer 槽位；CONTRACT #11-16
// .omo/previews/2026-11-15-task-lifecycle-p3.html）：
// - 入口门控与「查看远端会话」并排同口径（RemoteSessionEntry）：session.
//   delegationRole==='out' 且任务行 delegation_id 在场；另加账本终态隐藏
//   （done/failed/cancelled 无执行可指——预览 ① 定值，hub 侧终态 conflict 同守）
// - 输入浮层：锚定钮下方右对齐 440px + caret；textarea 计数 n/4000（码点），
//   空文本禁发、越限计数转 status-error 并禁发；「执行节点离线时发送将失败」
//   恒显预警行（hub 离线拒——指令时效性强，不缓存重发）
// - 发送：ipc.task.steer → 成功关浮层（里程碑经 pushSessionMessage 落消息流
//   蓝调卡）；失败 ui-Toast 底部居中人话（node_offline 主进程已映射 CONTRACT
//   #18 文案）+ 浮层保持可改可重发；发送中禁双击（取消/Escape 同禁——防
//   在途卸载丢反馈）
// - Esc / 点外部收起（TaskProgressButton 浮层同款 capture 监听）
import { useEffect, useRef, useState } from 'react';
import { Info, MessageSquarePlus, Send } from 'lucide-react';
import { cn } from '../../lib/cn';
import { ipc } from '../../ipc/client';
import { Button } from '../ui/Button';
import { showToast } from '../ui/Toast';
import { TERMINAL_STATUSES } from '../../lib/board';
import { shortNodeId } from './RemoteSessionDrawer';
import type { SessionSummary, TaskRow } from '../../ipc/types';

const STEER_MAX_CODEPOINTS = 4000;

export function SteerEntry({ session }: { session: SessionSummary }) {
  const [task, setTask] = useState<TaskRow | null>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  /** 浮层头目标节点显示名（getNodes 解析；失败/未解析 → 短 id 回退） */
  const [nodeName, setNodeName] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 门控数据：SessionSummary.taskId → 任务行（delegation_id 在场 + 非终态才保留；
  // RemoteSessionEntry 同款本地读）。发送中会话切换浮层收起在下方 Esc effect 一并覆盖
  useEffect(() => {
    let cancelled = false;
    if (session.delegationRole !== 'out' || session.taskId === null) {
      setTask(null);
      return;
    }
    setTask(null);
    void ipc.task.get(session.taskId).then((row) => {
      if (cancelled) return;
      setTask(
        row !== null &&
          row.delegationId !== null &&
          !(TERMINAL_STATUSES as readonly string[]).includes(row.status)
          ? row
          : null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [session.delegationRole, session.taskId]);

  // 打开时解析目标节点显示名（routing 回写的执行节点；getNodes 失败降级短 id）
  useEffect(() => {
    if (!open || task === null) return;
    // routing 回写的执行节点（node 变体必带 / group 变体 D5 回写可选；local 不可达）
    const target = task.routing.mode === 'local' ? null : task.routing.targetNodeId ?? null;
    if (target === null) {
      setNodeName(null);
      return;
    }
    let cancelled = false;
    setNodeName(shortNodeId(target));
    void ipc.hub
      .getNodes()
      .then((nodes) => {
        if (cancelled) return;
        setNodeName(nodes.find((n) => n.nodeId === target)?.nodeName ?? shortNodeId(target));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, task]);

  // Esc / 点外部收起（capture mousedown；发送中忽略——在途卸载会丢 toast 反馈）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !sending) setOpen(false);
    };
    const onClick = (e: MouseEvent): void => {
      if (sending) return;
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
  }, [open, sending]);

  if (task === null) return null;

  const count = Array.from(text).length;
  const overLimit = count > STEER_MAX_CODEPOINTS;
  const canSend = !sending && !overLimit && text.trim() !== '';

  const close = (): void => {
    if (sending) return;
    setOpen(false);
  };

  const handleSend = (): void => {
    if (!canSend || task === null) return;
    setSending(true);
    void ipc.task
      .steer(task.id, text.trim())
      .then(() => {
        // 成功：关浮层 + 清稿；里程碑经主进程 pushSessionMessage 到达消息流
        setText('');
        setSending(false);
        setOpen(false);
      })
      .catch((err: unknown) => {
        setSending(false);
        showToast(err instanceof Error ? err.message : String(err));
      });
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="steer-entry"
        aria-label={`给 ${session.title} 补充指令`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          // CONTRACT #11：与「查看远端会话」并排同规格（h 24 / px 9 / 11.5px·500）
          // + MessageSquarePlus 14；打开态 accent 着色（预览 ② 2A .btn.on）
          'inline-flex h-6 shrink-0 cursor-pointer items-center gap-[5px] rounded-md border px-[9px] text-[11.5px] font-medium',
          open
            ? 'border-focus bg-surface-active text-accent-600 dark:text-accent-300'
            : 'border-strong bg-surface-1 text-primary hover:bg-surface-3',
        )}
      >
        <MessageSquarePlus size={14} strokeWidth={1.75} aria-hidden />
        补充指令
      </button>

      {open && (
        <div
          data-testid="steer-popover"
          className="absolute right-0 top-full z-30 mt-1.5 flex w-[440px] max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border border-subtle bg-surface-1 p-3 shadow-[0_12px_32px_rgba(0,0,0,0.24)]"
        >
          {/* caret（预览 .steer-pop .caret：8px 旋转方块，右 30px 对齐入口钮） */}
          <span
            aria-hidden
            className="absolute -top-[4.5px] right-[30px] h-2 w-2 rotate-45 border-l border-t border-subtle bg-surface-1"
          />
          <div className="flex items-center gap-[7px] text-[12.5px] font-semibold text-primary">
            <MessageSquarePlus size={14} strokeWidth={1.75} className="shrink-0 text-accent-500" aria-hidden />
            补充指令 · 送达{nodeName ?? '执行节点'}
          </div>
          <p className="text-[10.5px] text-tertiary">
            #{task.id} {task.title} · 指令在执行方回合边界注入，不打断当前输出
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="补充指令…"
            data-testid="steer-textarea"
            className="min-h-24 resize-y rounded-md border border-subtle bg-surface-2 px-2.5 py-2 text-xs leading-[1.7] text-primary outline-none placeholder:text-tertiary focus:border-focus"
          />
          <div
            data-testid="steer-count"
            className={cn(
              'flex justify-end text-[10.5px]',
              overLimit ? 'text-status-error' : 'text-tertiary',
            )}
          >
            {count} / {STEER_MAX_CODEPOINTS}
          </div>
          <div className="flex items-center gap-[5px] text-[10.5px] text-tertiary">
            <Info size={11} strokeWidth={1.75} className="shrink-0" aria-hidden />
            执行节点离线时发送将失败
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={close} disabled={sending}>
              取消
            </Button>
            <Button size="sm" onClick={handleSend} disabled={!canSend} data-testid="steer-send">
              <Send size={14} strokeWidth={1.75} aria-hidden />
              {sending ? '发送中…' : '发送指令'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
