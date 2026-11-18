// 远端运行状态内联（2026-11-18 头部统一）：实时/断连徽标 + 执行节点 · run · 工作区
// + 旧 worker 简版回放 chip——挂在会话标题右侧，省掉面板内独立状态条一行。
import { Eye, Monitor } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useRemoteSessionStore } from '../../stores/remote-session.view';

export function RemoteSessionStatusInline({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const st = useRemoteSessionStore();
  // 会话不匹配即不渲染：切会话瞬间 store 仍可能残留上一条目标态
  if (st.target === null || st.task?.executionSessionId !== sessionId) return null;
  const online = st.live && st.hubOnline;

  return (
    <span
      className="flex min-w-0 items-center gap-2"
      data-testid="remote-session-status-inline"
    >
      {online ? (
        <span className="inline-flex h-5 shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full bg-status-success-tint px-2 text-[11px] font-medium text-status-success">
          <span className="remote-live-dot" aria-hidden />
          实时
        </span>
      ) : (
        <span className="inline-flex h-5 shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full bg-surface-3 px-2 text-[11px] font-medium text-tertiary">
          <span className="h-[6px] w-[6px] rounded-full bg-text-disabled" aria-hidden />
          已断开 · 重连后恢复
        </span>
      )}
      <Monitor size={12} strokeWidth={1.75} className="shrink-0 text-tertiary" aria-hidden />
      <span className={cn('truncate text-[11px]', online ? 'text-secondary' : 'text-tertiary')}>
        {`${st.target.nodeName} · run #${st.target.runNo} · ${st.target.workspaceName}`}
      </span>
      {!st.wire2 && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded bg-surface-3 px-1.5 py-[1px] text-[10px] text-tertiary">
          <Eye size={10} strokeWidth={1.75} aria-hidden />
          简版回放
        </span>
      )}
    </span>
  );
}
