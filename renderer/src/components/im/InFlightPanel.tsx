// renderer/src/components/im/InFlightPanel.tsx
//
// 在途任务面板（spec 2026-10-13 §9）：会话头部入口 + 徽标在途数 + 打开期间 2s 轮询刷新。
// 单链取消复用 dispatch:cancelChain（by taskId，P2-D 入口）；轮询真值优先于乐观态——
// 取消不本地移除行，链是否仍在列表完全由下一帧 listInFlight 真值决定。
// subAgentName null（成员已删 / D1 解析失败）→ 降级渲染短 taskId（前 8 位）。
//
// 注：brief 骨架的徽标前景 text-status-error-foreground 在 token 表中不存在（会静默
// 生成空样式），按 Button danger 既有惯例改为 text-inverse——唯一偏离 verbatim 处。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Square, Zap } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { InFlightChainView } from '../../ipc/types';

export function InFlightPanel({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [chains, setChains] = useState<InFlightChainView[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    // renderer 面按 preload 契约传位置参数（preload 内部序列化 {sessionId} 上线；
    // 若在此传对象会被当作 sessionId 本体 → 主进程过滤失效返回全部会话链）
    const rows = await ipc.dispatch.listInFlight(sessionId);
    setChains(rows);
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    timerRef.current = setInterval(() => void refresh(), 2000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [open, refresh]);

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
          {chains.map((c) => (
            <div key={c.taskId} className="flex items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-surface-active">
              <Loader2 size={11} strokeWidth={1.75} aria-hidden className="animate-spin text-accent-500" />
              <span className="text-secondary">{c.subAgentName ?? c.taskId.slice(0, 8)}</span>
              <span className="text-tertiary">第 {c.round} 轮</span>
              <span className="ml-auto text-tertiary">{Math.round((Date.now() - c.startedAt) / 60000)}m</span>
              <button
                type="button"
                aria-label={`停止 ${c.subAgentName ?? c.taskId.slice(0, 8)} 的任务`}
                className="cursor-pointer text-tertiary hover:text-status-error"
                onClick={() => void ipc.dispatch.cancelChain({ taskId: c.taskId })}
              >
                <Square size={11} strokeWidth={1.75} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
