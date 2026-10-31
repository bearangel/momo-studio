// renderer/src/components/im/InFlightPanel.tsx
//
// 在途任务面板（spec 2026-10-13 §9）：会话头部入口 + 徽标在途数 + 打开期间 2s 轮询刷新。
// 单链取消复用 dispatch:cancelChain（by taskId，P2-D 入口）；轮询真值优先于乐观态——
// 取消不本地移除行，链是否仍在列表完全由下一帧 listInFlight 真值决定。
// subAgentName null（成员已删 / D1 解析失败）→ 降级渲染短 taskId（前 8 位）。
//
// 注：brief 骨架的徽标前景 text-status-error-foreground 在 token 表中不存在（会静默
// 生成空样式），按 Button danger 既有惯例改为 text-inverse——唯一偏离 verbatim 处。
// D8（2026-10-31）：行内「第 N 轮」后渲染「活动 Ns 前」停滞指示（LastActivity，
// streamSessionId→messageId 反查 stream.store.lastEventAt；等待授权行不叠加）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Square, Zap, ShieldQuestion } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useWriteGrantStore } from '../../stores/write-grant.store';
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore } from '../../stores/stream.store';
import { LastActivity } from './LastActivity';
import type { InFlightChainView, WriteBlockedEvent } from '../../ipc/types';

export function InFlightPanel({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [chains, setChains] = useState<InFlightChainView[]>([]);
  // F3（2026-10-14 授权等待可见性）：等待授权的流位图——面板行区分「执行中/等待授权」
  const waitingByStream = useWriteGrantStore((s) => s.waitingByStream);
  const clearWaiting = useWriteGrantStore((s) => s.clearWaiting);

  const refresh = useCallback(async () => {
    // renderer 面按 preload 契约传位置参数（preload 内部序列化 {sessionId} 上线；
    // 若在此传对象会被当作 sessionId 本体 → 主进程过滤失效返回全部会话链）
    const rows = await ipc.dispatch.listInFlight(sessionId);
    setChains(rows);
  }, [sessionId]);

  // P1-2（2026-10-15 会话验收）：徽标计数不能只在面板 open 时刷新——关闭态恒 0
  // 会让后台 dispatch 进行中用户毫无感知。挂载/会话切换即拉一次；打开瞬间即拉
  // （打开面板立刻见数据）；关闭态 10s 低频轮询（徽标是提示性，≤10s 延迟足够），
  // 打开态维持 2s 轮询不变。
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);
  useEffect(() => {
    const interval = setInterval(() => void refresh(), open ? 2_000 : 10_000);
    return () => clearInterval(interval);
  }, [open, refresh]);

  // F3 行内处置：授权（本会话作用域）——key 缺失或空 dirs 时按钮禁用兜底
  const grantWaiting = (ev: WriteBlockedEvent): void => {
    if (ev.sessionId === null || ev.dirs.length === 0) return;
    void ipc.sandbox
      .grantWrite({ scope: 'session', key: ev.sessionId, dirs: ev.dirs })
      .then(() => clearWaiting(ev.streamSessionId ?? ''))
      .catch(() => {});
  };
  // F3 行内处置：拒绝——广播解除子进程等待（sessionId null 也有效：dirs 匹配在子进程侧）
  const denyWaiting = (ev: WriteBlockedEvent): void => {
    void ipc.sandbox.denyWrite({ sessionId: ev.sessionId, dirs: ev.dirs }).catch(() => {});
    clearWaiting(ev.streamSessionId ?? '');
  };

  // D8 最后活动指示数据源：streamSessionId → messageId 反查（子 agent 消息行的
  // streamSessionId 字段，AgentStreamBubble 同款反查链）→ streams Map 的 lastEventAt
  const sessionMessages = useSessionStore((s) => s.messagesBySession.get(sessionId));
  const messageIdByStreamId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of sessionMessages ?? []) {
      if (m.streamSessionId) map.set(m.streamSessionId, m.id);
    }
    return map;
  }, [sessionMessages]);
  // key 形态 selector（P1-1 惯例）：tracked lastEventAt 无变化不重渲染面板
  const lastEventAtKey = useStreamStore((s) => {
    const parts: string[] = [];
    for (const c of chains) {
      const mid = c.subStreamSessionId != null ? messageIdByStreamId.get(c.subStreamSessionId) : undefined;
      parts.push((mid !== undefined ? s.streams.get(mid)?.lastEventAt : undefined)?.toString() ?? '-');
    }
    return parts.join(',');
  });
  const lastEventAtByTaskId = useMemo(() => {
    const streams = useStreamStore.getState().streams;
    const map = new Map<string, number>();
    for (const c of chains) {
      if (c.subStreamSessionId == null) continue;
      const mid = messageIdByStreamId.get(c.subStreamSessionId);
      const lastEventAt = mid !== undefined ? streams.get(mid)?.lastEventAt : undefined;
      if (lastEventAt !== undefined) map.set(c.taskId, lastEventAt);
    }
    return map;
    // lastEventAtKey 门控：tracked 值无变化不重算（streams 非响应式读取）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chains, messageIdByStreamId, lastEventAtKey]);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`在途任务 ${chains.length} 个`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex cursor-pointer items-center text-secondary hover:text-primary"
      >
        <Zap size={16} strokeWidth={1.75} aria-hidden />
        {open === false && chains.length > 0 && (
          <span className="absolute -right-1.5 -top-1.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-status-error px-0.5 text-[9px] font-medium text-inverse">{chains.length}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-20 w-72 rounded border border-subtle bg-surface-1 p-2 shadow-lg">
          <p className="mb-1.5 text-xs font-medium text-primary">在途子任务（{chains.length}）</p>
          {chains.length === 0 && <p className="py-2 text-center text-xs text-tertiary">当前没有运行中的子任务</p>}
          {chains.map((c) => {
            const waiting = c.subStreamSessionId != null ? waitingByStream.get(c.subStreamSessionId) : undefined;
            const ev = waiting?.event;
            const lastEventAt = lastEventAtByTaskId.get(c.taskId);
            return (
              <div key={c.taskId} className="flex items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-surface-active">
                {ev !== undefined ? (
                  <ShieldQuestion size={11} strokeWidth={1.75} aria-hidden className="shrink-0 text-status-warning" />
                ) : (
                  <Loader2 size={11} strokeWidth={1.75} aria-hidden className="animate-spin text-accent-500" />
                )}
                <span className="text-secondary">{c.subAgentName ?? c.taskId.slice(0, 8)}</span>
                {ev !== undefined ? (
                  <span className="text-status-warning">等待授权</span>
                ) : (
                  <>
                    <span className="text-tertiary">第 {c.round} 轮</span>
                    {/* D8：最后活动指示——等待授权行不叠加（该分支已排除） */}
                    {lastEventAt !== undefined && <LastActivity lastEventAt={lastEventAt} />}
                  </>
                )}
                <span className="ml-auto text-tertiary">{Math.round((Date.now() - c.startedAt) / 60000)}m</span>
                {ev !== undefined ? (
                  <>
                    <button
                      type="button"
                      aria-label={`授权 ${c.subAgentName ?? c.taskId.slice(0, 8)} 的写入`}
                      disabled={ev.sessionId === null || ev.dirs.length === 0}
                      onClick={() => grantWaiting(ev)}
                      className="shrink-0 cursor-pointer rounded bg-status-success-tint px-1.5 py-0.5 text-[10px] text-status-success disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      授权
                    </button>
                    <button
                      type="button"
                      aria-label={`拒绝 ${c.subAgentName ?? c.taskId.slice(0, 8)} 的写入`}
                      onClick={() => denyWaiting(ev)}
                      className="shrink-0 cursor-pointer rounded bg-status-error-tint px-1.5 py-0.5 text-[10px] text-status-error"
                    >
                      拒绝
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    aria-label={`停止 ${c.subAgentName ?? c.taskId.slice(0, 8)} 的任务`}
                    className="cursor-pointer text-tertiary hover:text-status-error"
                    onClick={() => void ipc.dispatch.cancelChain({ taskId: c.taskId })}
                  >
                    <Square size={11} strokeWidth={1.75} aria-hidden />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
