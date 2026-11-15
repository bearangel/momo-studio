// renderer/src/components/notices/HumanRequestToast.tsx
//
// 人工请求吐司（任务生命周期 v2 Task S4，CONTRACT #19-23）：agent 侧落人工
// 请求（human:changed kind='inserted'）→ 右下 NoticeStack 同位吐司提醒
// 「等待你确认 · <标题>」+ 会话名，点击跳会话，6s 自动消散 + 手动关。
//
// 订阅裁定：组件自订阅 ipc.human.onChanged（NoticeStack 自订 onBrowserNotice
// 先例）——不经 human.store，避免 store 依赖；请求被答/超时后主进程不另发
// 撤销事件，吐司自然消散（CONTRACT #23）。
//
// session 维度去重（Review Focus #3 / CONTRACT #21）：去重键 sessionId——
// 同会话新请求不叠条，主行改计数变体「等待你确认 · N 项」并重置消散计时；
// inserted 事件按会话天然聚合（本地行与远端镜像行不产生重复事件）。
//
// 数据面：onChanged 载荷无 title/deadline——收到 inserted 时轻量单查
// ipc.human.list({sessionId, status:'pending'})：title 取最新一条（尾行），
// deadline 取最早非空（预警取最急）；不轮询，预警只在渲染期算当前时刻差。
import { useEffect, useState } from 'react';
import { Bell, Clock, X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { HumanRequestRow } from '../../ipc/types';
import { useSessionStore } from '../../stores/session.store';
import { cn } from '../../lib/cn';

/** 消散 TTL——与 NoticeStack NOTICE_TTL_MS 同节奏（CONTRACT #23） */
const TOAST_TTL_MS = 6_000;
/** 同屏上限 + 溢出行（CONTRACT #19，既有形态沿用） */
const MAX_VISIBLE = 4;
/** 临近超时阈值：deadline 距今 <5min 渲染预警变体（CONTRACT #22） */
const WARN_THRESHOLD_MS = 5 * 60_000;

interface SessionToast {
  sessionId: string;
  /** 最新一条请求标题（计数变体下不展示，单查失败回退用） */
  title: string;
  /** 同会话累计请求数（CONTRACT #21 计数变体） */
  count: number;
  /** 该会话 pending 行最早非空 deadline（ms）；null=无 deadline */
  deadlineAt: number | null;
  /** 本条出生时刻——更新换代重置，消散计时锚点（CONTRACT #21 重置计时） */
  createdAt: number;
}

/** pending 行里最早的非空 deadline（预警取最急）；全空返回 null */
function earliestDeadline(rows: HumanRequestRow[]): number | null {
  let min: number | null = null;
  for (const r of rows) {
    if (r.deadlineAt != null && (min === null || r.deadlineAt < min)) min = r.deadlineAt;
  }
  return min;
}

export function HumanRequestToast() {
  const sessions = useSessionStore((s) => s.sessions);
  // 合并态单 state（NoticeStack 同款）：条目与溢出计数在同一纯 updater 内推导
  const [stack, setStack] = useState<{ toasts: SessionToast[]; dropped: number }>({
    toasts: [],
    dropped: 0,
  });

  useEffect(() => {
    const off = ipc.human.onChanged((e) => {
      if (e.kind !== 'inserted') return;
      void (async () => {
        let title: string | null = null;
        let deadlineAt: number | null = null;
        try {
          const rows = await ipc.human.list({ sessionId: e.sessionId, status: 'pending' });
          // list 按 created_at ASC：尾行 = 最新请求；deadline 取最早非空
          title = rows.length > 0 ? (rows[rows.length - 1] as HumanRequestRow).title : null;
          deadlineAt = earliestDeadline(rows);
        } catch {
          // 单查失败不吞事件：title/deadline 退回既有条目值（updater 内 ?? 兜底）
        }
        // Date.now / 计数推导素材在回调体取（每事件恰一次）——updater 重放保持纯
        const createdAt = Date.now();
        setStack((prev) => {
          const idx = prev.toasts.findIndex((t) => t.sessionId === e.sessionId);
          if (idx === -1) {
            // 查询落空且无旧行可退（插入后旋即被答）——不建空吐司
            if (title === null) return prev;
            const appended: SessionToast[] = [
              ...prev.toasts,
              { sessionId: e.sessionId, title, count: 1, deadlineAt, createdAt },
            ];
            if (appended.length <= MAX_VISIBLE) return { toasts: appended, dropped: prev.dropped };
            return {
              toasts: appended.slice(-MAX_VISIBLE),
              dropped: prev.dropped + (appended.length - MAX_VISIBLE),
            };
          }
          const old = prev.toasts[idx] as SessionToast;
          const replaced = [...prev.toasts];
          replaced[idx] = {
            sessionId: e.sessionId,
            title: title ?? old.title,
            count: old.count + 1,
            deadlineAt: deadlineAt ?? old.deadlineAt,
            createdAt,
          };
          return { toasts: replaced, dropped: prev.dropped };
        });
      })();
    });
    return off;
  }, []);

  // 自动消散（CONTRACT #23）：条目各自 6s 到期，单定时器锚最早到期项；更新
  // 换代（createdAt 重置）自然重锚。到期剪除全部过期条目（观察语义与
  // NoticeStack 逐条滑出一致）；清空即溢出计数复位
  useEffect(() => {
    if (stack.toasts.length === 0) return;
    const nextExpiry = Math.min(...stack.toasts.map((t) => t.createdAt + TOAST_TTL_MS));
    const timer = setTimeout(() => {
      setStack((prev) => {
        const now = Date.now();
        const toasts = prev.toasts.filter((t) => t.createdAt + TOAST_TTL_MS > now);
        return { toasts, dropped: toasts.length === 0 ? 0 : prev.dropped };
      });
    }, Math.max(0, nextExpiry - Date.now()));
    return () => clearTimeout(timer);
  }, [stack.toasts]);

  const dismiss = (sessionId: string): void => {
    setStack((prev) => {
      const toasts = prev.toasts.filter((t) => t.sessionId !== sessionId);
      return { toasts, dropped: toasts.length === 0 ? 0 : prev.dropped };
    });
  };

  const jump = (sessionId: string): void => {
    dismiss(sessionId);
    // RoomList 行点击同路径：selectSession 直跳（消息/成员加载由 store 负责）
    void useSessionStore.getState().selectSession(sessionId);
  };

  if (stack.toasts.length === 0 && stack.dropped === 0) return null;

  // 预警只在渲染期算当前时刻差（CONTRACT #22：不轮询——吐司 6s 消散）
  const now = Date.now();

  return (
    <>
      {stack.dropped > 0 && (
        <div
          data-testid="human-request-overflow"
          className="pointer-events-auto self-end rounded border border-subtle bg-surface-1 px-2 py-0.5 text-xs text-tertiary"
        >
          还有 {stack.dropped} 条更早提示
        </div>
      )}
      {stack.toasts.map((t) => {
        const warn = t.deadlineAt != null && t.deadlineAt - now < WARN_THRESHOLD_MS;
        const remainMin =
          t.deadlineAt != null ? Math.max(0, Math.ceil((t.deadlineAt - now) / 60_000)) : 0;
        const sessionTitle = sessions.find((s) => s.id === t.sessionId)?.title ?? null;
        return (
          <div
            key={t.sessionId}
            data-testid="human-request-toast"
            className={cn(
              'pointer-events-auto flex items-start gap-2 rounded-lg border bg-surface-1 p-3 shadow-lg',
              warn ? 'border-status-warning' : 'border-subtle',
            )}
          >
            <Bell
              size={16}
              strokeWidth={1.75}
              aria-hidden
              className={cn('mt-0.5 shrink-0', warn ? 'text-status-warning' : 'text-tertiary')}
            />
            {/* 点击卡片主体 → selectSession 跳会话并消散（CONTRACT #23）；
                主体做成 button（与关闭钮平级不嵌套），键盘可达 */}
            <button
              type="button"
              onClick={() => jump(t.sessionId)}
              className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
            >
              <p className="w-full break-words text-xs font-semibold leading-normal text-primary">
                {t.count > 1 ? `等待你确认 · ${t.count} 项` : `等待你确认 · ${t.title}`}
              </p>
              {(sessionTitle != null || warn) && (
                <p className="flex w-full flex-wrap items-center gap-1.5 text-[11px] leading-normal text-tertiary">
                  {sessionTitle != null && <span className="min-w-0 truncate">{sessionTitle}</span>}
                  {warn && (
                    <span className="inline-flex h-[18px] shrink-0 items-center gap-1 whitespace-nowrap rounded bg-status-warning-tint px-[7px] text-[10.5px] font-medium text-status-warning">
                      <Clock size={11} strokeWidth={1.75} aria-hidden />
                      剩余 {remainMin} 分钟
                    </span>
                  )}
                </p>
              )}
            </button>
            <button
              type="button"
              aria-label="关闭"
              onClick={() => dismiss(t.sessionId)}
              className="mt-0.5 shrink-0 text-tertiary hover:text-primary"
            >
              {/* 尺寸 14 对齐仓库密集内联关闭钮多数派惯例（NoticeStack 同款注释） */}
              <X size={14} strokeWidth={1.75} aria-hidden />
            </button>
          </div>
        );
      })}
    </>
  );
}
