// renderer/src/components/hub/RemoteSessionView.tsx
//
// 远端执行会话全宽视图（spec 2026-11-17 §7.2，D1 全宽一等会话形态）：
// - 数据面：remote-session.view store（帧流 upsert / legacy 降级双路径）
// - 帧渲染：text → 气泡（streaming 光标）；tool → ToolCallChip（本地同构，D3）；
//   user/steer → 用户气泡（steer 带「指令」徽标）；pendingSteers 乐观尾渲染
// - legacy 降级：沿 RemoteSessionDrawer 旧样式（parseToolRow 文本行）——旧 worker
//   无回显时不断流；头部「简版回放」提示
// - 交互平移现抽屉契约：触顶加载更早 / Esc 退出 / 断开降不透明度
// 退役对应：RemoteSessionDrawer / RemoteSessionEntry（CONTRACT #1-#10 随删）。
import { useEffect } from 'react';
import { Bot, ChevronUp, CircleCheck, Eye, Monitor, Wrench } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useRemoteSessionStore } from '../../stores/remote-session.view';
import { useUiStore } from '../../stores/ui.store';
import { useHubViewStore } from '../../stores/hub-view.store';
import { ToolCallChip } from '../im/ToolCallChip';
import { RemoteSteerComposer } from './RemoteSteerComposer';
import type { HubViewFrame, HubViewMessage } from '../../ipc/types';

const TOOL_START_RE = /^调用工具 (\S+)$/;
const TOOL_END_RE = /^工具 (\S+) 完成/;

function parseToolRow(content: string): { name: string; excerpt: string } | null {
  const start = TOOL_START_RE.exec(content);
  if (start) return { name: start[1]!, excerpt: '' };
  const end = TOOL_END_RE.exec(content);
  if (end) return { name: end[1]!, excerpt: content };
  return null;
}

function formatHHmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 流式光标判定：streaming 帧（构造上至多一个——聚合端保证）且在线 */
function isStreamingTail(frame: HubViewFrame, live: boolean): boolean {
  return live && frame.streaming === true;
}

function RemoteToolChip({ frame }: { frame: HubViewFrame }): React.JSX.Element {
  const tool = frame.tool;
  if (tool === undefined) return <></>;
  const inFlight = tool.result === undefined;
  return (
    <ToolCallChip
      toolName={tool.name}
      argsExcerpt={tool.argsExcerpt}
      result={tool.result}
      success={tool.success ?? true}
      isExecuting={inFlight}
      resultTruncated={tool.truncated}
      tone={tool.success === undefined ? 'neutral' : 'auto'}
    />
  );
}

/** 帧气泡（text/user/steer）——形态沿本地会话气泡语义 token */
function FrameBubble({ frame, streamingTail }: { frame: HubViewFrame; streamingTail: boolean }): React.JSX.Element {
  const isUserSide = frame.role === 'user';
  if (isUserSide) {
    return (
      <div className="ml-auto w-fit max-w-[86%] rounded-[10px] bg-accent-500 px-[11px] py-[7px] text-[13px] leading-[1.6] text-inverse">
        <span className="whitespace-pre-wrap break-words">{frame.content}</span>
        {frame.kind === 'steer' && (
          <span className="mt-[3px] block text-right text-[10px] text-inverse opacity-70">指令</span>
        )}
      </div>
    );
  }
  return (
    <div>
      <div className="mb-[3px] flex items-center gap-[5px] text-[10px] text-tertiary">
        <Bot size={11} strokeWidth={1.75} aria-hidden />
        {formatHHmm(frame.at)}
        {streamingTail && <span className="text-[10px] text-tertiary">生成中…</span>}
      </div>
      <div className="rounded-[10px] border border-subtle bg-surface-2 px-[11px] py-[7px] text-[13px] leading-[1.7] text-primary">
        <span className="whitespace-pre-wrap break-words">{frame.content}</span>
        {streamingTail && <span className="remote-stream-cursor" aria-hidden />}
      </div>
    </div>
  );
}

/** legacy 降级行（沿抽屉 CONTRACT #5/#6 形态） */
function LegacyRow({ m }: { m: HubViewMessage }): React.JSX.Element {
  const tool = parseToolRow(m.content);
  if (tool !== null) {
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-2 py-1 text-[11px] text-secondary" title={tool.excerpt || undefined}>
        <Wrench size={12} strokeWidth={1.75} className="shrink-0 text-tertiary" aria-hidden />
        调用工具
        <span className="font-mono text-[10.5px] text-primary">{tool.name}</span>
        <CircleCheck size={12} strokeWidth={1.75} className="shrink-0 text-status-success" aria-hidden />
        <span className="ml-auto shrink-0 text-[10px] text-tertiary">{formatHHmm(m.at)}</span>
      </div>
    );
  }
  if (m.role === 'user') {
    return (
      <div className="ml-auto w-fit max-w-[86%] rounded-[10px] bg-accent-500 px-[11px] py-[7px] text-[12.5px] leading-[1.6] text-inverse">
        <span className="whitespace-pre-wrap break-words">{m.content}</span>
        <span className="mt-[3px] block text-right text-[10px] text-inverse opacity-70">{formatHHmm(m.at)}</span>
      </div>
    );
  }
  return (
    <div className="rounded-[10px] border border-subtle bg-surface-2 px-[11px] py-[7px] text-[12.5px] leading-[1.6] text-primary">
      <span className="whitespace-pre-wrap break-words">{m.content}</span>
    </div>
  );
}

export function RemoteSessionView(): React.JSX.Element {
  const st = useRemoteSessionStore();
  const remoteSessionView = useUiStore((s) => s.remoteSessionView);
  const closeRemoteSession = useUiStore((s) => s.closeRemoteSession);
  const online = st.live && st.hubOnline;

  // 入口接线（终审 C1）：ui.remoteSessionView.task → store.open——换任务才重新
  // 定位（同任务重挂载幂等）；close 由「收口 effect」统一驱动
  const entryTask = remoteSessionView?.task ?? null;
  const entryTaskId = entryTask?.id ?? null;
  useEffect(() => {
    if (entryTaskId === null) return;
    const s = useRemoteSessionStore.getState();
    if (s.task?.id === entryTaskId && s.phase !== 'resolving') return;
    void useRemoteSessionStore.getState().open(entryTask!);
  }, [entryTaskId, entryTask]);

  // 单飞收口（终审 Important#5）：同节点同会话的「节点查看回放面板」与本视图共享
  // hub 订阅键 (leader,target,session)——后订阅者会覆盖前者的 wire 形态，两开必有一
  // 面静默断流。进入本视图时若回放面板正开着同一会话则关闭它（回放可随时重开）。
  const resolvedTarget = st.target;
  useEffect(() => {
    const hv = useHubViewStore.getState();
    if (hv.replay !== null && hv.targetNodeId !== null && resolvedTarget !== null) {
      if (resolvedTarget.targetNodeId === hv.targetNodeId && resolvedTarget.sessionId === hv.replay.sessionId) {
        hv.close();
      }
    }
  }, [resolvedTarget]);

  // 收口（终审 C6，spec §7.1「切换本地会话/视图即关闭」）：remoteSessionView 置空
  // （closeRemoteSession 被 setActiveView 离开 im / 切会话路径调用）→ store.close
  // 退订清理。组件卸载同样收口（防退订泄漏）。
  useEffect(() => {
    if (remoteSessionView === null) {
      useRemoteSessionStore.getState().close();
    }
  }, [remoteSessionView]);
  useEffect(() => {
    // 仅退订清理——不置空 ui.remoteSessionView（StrictMode 双挂载下卸载清理会
    // 抹掉仍在场的入口态，二次挂载即自杀；ui 态收口由 setActiveView/显式关闭路径负责）
    return () => {
      useRemoteSessionStore.getState().close();
    };
  }, []);

  // Esc 退出（capture——不与宿主视图双触发；抽屉同款）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      st.close();
      closeRemoteSession();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [st, closeRemoteSession]);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-canvas" data-testid="remote-session-view">
      {/* 会话头：实时徽标 + 标题 + run 号（远端身份一目了然） */}
      <div className="flex flex-col gap-0.5 border-b border-subtle bg-surface-1 px-4 py-2">
        <div className="flex items-center gap-2">
          {online ? (
            <span className="inline-flex h-5 shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full bg-status-success-tint px-2 text-[11px] font-medium text-status-success">
              <span className="remote-live-dot" aria-hidden />实时
            </span>
          ) : (
            <span className="inline-flex h-5 shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full bg-surface-3 px-2 text-[11px] font-medium text-tertiary">
              <span className="h-[6px] w-[6px] rounded-full bg-text-disabled" aria-hidden />
              已断开 · 重连后恢复
            </span>
          )}
          <span className={cn('truncate text-[13px] font-semibold', online ? 'text-primary' : 'text-tertiary')}>
            执行会话 · {st.target?.nodeName ?? '…'}
          </span>
          <button
            type="button"
            aria-label="关闭远端会话"
            onClick={() => { st.close(); closeRemoteSession(); }}
            className="ml-auto flex h-[26px] shrink-0 cursor-pointer items-center justify-center rounded-md px-2 text-[11.5px] text-tertiary hover:bg-surface-2 hover:text-primary"
          >
            返回
          </button>
        </div>
        <div className="flex items-center gap-[5px] truncate text-[10.5px] text-tertiary">
          <Monitor size={11} strokeWidth={1.75} className="shrink-0" aria-hidden />
          {st.target !== null
            ? `#${st.task?.id ?? ''} ${st.task?.title ?? ''} · run #${st.target.runNo} · ${st.target.nodeName} · ${st.target.workspaceName}`
            : `#${st.task?.id ?? ''} ${st.task?.title ?? ''}`}
          {!st.wire2 && st.phase === 'ready' && (
            <span className="ml-1 inline-flex items-center gap-1 rounded bg-surface-3 px-1.5 py-[1px] text-[10px] text-tertiary">
              <Eye size={10} strokeWidth={1.75} aria-hidden />简版回放
            </span>
          )}
        </div>
      </div>

      {/* 流域（断开整体降不透明度——抽屉 CONTRACT #5 同款） */}
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3',
          st.phase === 'ready' && !online && 'opacity-60',
        )}
        data-testid="remote-session-flow"
      >
        {st.phase === 'resolving' && (
          <p className="flex items-center justify-center gap-2 py-6 text-xs text-tertiary">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-status-violet border-t-transparent" aria-hidden />
            定位执行会话…
          </p>
        )}
        {st.phase === 'miss' && (
          <div className="flex flex-col items-center gap-3 py-6 text-xs text-tertiary" data-testid="remote-session-miss">
            <p>未找到执行会话（任务可能尚未开始）</p>
            <button
              type="button"
              className="cursor-pointer rounded-md border border-subtle bg-surface-1 px-3 py-1 text-[11.5px] text-secondary hover:bg-surface-2"
              onClick={() => {
                const task = st.task;
                st.close();
                closeRemoteSession();
                if (task) void useRemoteSessionStore.getState().open(task);
                useUiStore.setState({ remoteSessionView: task ? { task } : null, activeView: 'im' });
              }}
            >
              重试
            </button>
          </div>
        )}
        {st.phase === 'error' && (
          <p className="mx-1 rounded-md bg-status-error-tint px-2.5 py-2 text-xs leading-relaxed text-status-error" role="alert">
            {st.errorText}
          </p>
        )}
        {st.phase === 'ready' && st.target !== null && (
          <>
            {st.hasMore && (
              <button
                type="button"
                onClick={() => st.loadEarlier()}
                disabled={st.loadingEarlier}
                data-testid="remote-session-load-earlier"
                className="flex h-7 w-full cursor-pointer items-center justify-center gap-[5px] rounded-md border border-subtle bg-surface-1 text-[11.5px] text-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-55"
              >
                {st.loadingEarlier ? (
                  <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-status-violet border-t-transparent" aria-hidden />
                ) : (
                  <ChevronUp size={14} strokeWidth={1.75} aria-hidden />
                )}
                {st.loadingEarlier ? '加载中…' : '加载更早'}
              </button>
            )}
            {st.wire2 ? (
              <>
                {st.frames.length === 0 && st.pendingSteers.length === 0 && (
                  <p className="py-4 text-center text-xs text-tertiary">（会话暂无事件）</p>
                )}
                {st.frames.map((f) => (
                  <div key={f.frameId}>
                    {f.kind === 'tool'
                      ? <RemoteToolChip frame={f} />
                      : <FrameBubble frame={f} streamingTail={isStreamingTail(f, online)} />}
                  </div>
                ))}
              </>
            ) : (
              <>
                {st.legacy.length === 0 && <p className="py-4 text-center text-xs text-tertiary">（会话暂无事件）</p>}
                {st.legacy.map((m) => <LegacyRow key={m.seq} m={m} />)}
              </>
            )}
            {/* 乐观 steer 气泡（回流消解后移除） */}
            {st.pendingSteers.map((p) => (
              <div key={p.id} className="ml-auto w-fit max-w-[86%]">
                <div className="rounded-[10px] bg-accent-500 px-[11px] py-[7px] text-[13px] leading-[1.6] text-inverse">
                  <span className="whitespace-pre-wrap break-words">{p.text}</span>
                  <span className="mt-[3px] block text-right text-[10px] text-inverse opacity-70">
                    {p.state === 'sending' ? '发送中…' : p.state === 'failed' ? `发送失败：${p.error ?? ''}` : `送达 ${st.target?.nodeName ?? '执行节点'}`}
                  </span>
                </div>
                {p.state === 'failed' && (
                  <div className="mt-1 flex justify-end gap-2 text-[11px]">
                    <button type="button" className="cursor-pointer rounded border border-subtle px-2 py-0.5 text-secondary hover:bg-surface-2" onClick={() => void st.retrySteer(p.id)}>
                      重试
                    </button>
                    <button type="button" className="cursor-pointer rounded border border-subtle px-2 py-0.5 text-secondary hover:bg-surface-2" onClick={() => st.dropSteer(p.id)}>
                      丢弃
                    </button>
                  </div>
                )}
              </div>
            ))}
            {!online && st.liveError !== null && (
              <p className="px-1 py-1.5 text-[11px] text-status-warning" role="alert">{st.liveError}</p>
            )}
          </>
        )}
      </div>

      {/* composer=steer（spec §7.3）：输入即补充指令 */}
      <RemoteSteerComposer />
    </div>
  );
}
