// renderer/src/components/hub/RemoteSessionPanel.tsx
//
// 远端执行会话面板体（spec §12 D1 修订：跟踪会话面板直连）——住进标准会话面板壳
// （MiddlePanel 判 kind='task_execution' 时以本组件替换 MessageList+InputToolbar）。
// 内容：状态条（实时/断开/简版徽标 + run 号 + 节点）+ 穿插时间线（远端帧 + 本地
// 镜像里程碑，按时间戳、同毫秒镜像先行）+ RemoteSteerComposer。
// 生命周期由挂载驱动：mount → resolveTrackingTask → store.open；unmount → close。
// 降级矩阵：miss 占位重试 / 旧 worker legacy 行穿插镜像 / 断开保留已到帧。
import { useEffect } from 'react';
import { Bot, ChevronUp, CircleCheck, Eye, Milestone, Monitor, Wrench } from 'lucide-react';
import { cn } from '../../lib/cn';
import { ipc } from '../../ipc/client';
import { resolveTrackingTask } from '../../lib/resolve-tracking-task';
import { useRemoteSessionStore } from '../../stores/remote-session.view';
import { ToolCallChip } from '../im/ToolCallChip';
import { RemoteSteerComposer } from './RemoteSteerComposer';
import type { HubViewFrame, HubViewMessage, ImMessage } from '../../ipc/types';

const TOOL_START_RE = /^调用工具 (\S+)$/;
const TOOL_END_RE = /^工具 (\S+) 完成/;
const MIRROR_BODY_MAX = 60;

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

function isStreaming(frame: HubViewFrame, live: boolean): boolean {
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

/** 本地镜像里程碑细行（spec §12.2：系统样式居中细行） */
function MirrorRow({ m }: { m: ImMessage }): React.JSX.Element {
  const body = m.body.length > MIRROR_BODY_MAX ? `${m.body.slice(0, MIRROR_BODY_MAX)}…` : m.body;
  return (
    <div className="mx-auto flex max-w-[80%] items-center gap-1.5 text-[10.5px] text-tertiary" data-testid="remote-mirror-row">
      <Milestone size={11} strokeWidth={1.75} className="shrink-0" aria-hidden />
      <span className="shrink-0">{formatHHmm(m.createdAt)}</span>
      <span className="truncate">{body}</span>
    </div>
  );
}

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

type TimelineEntry =
  | { t: number; kind: 'frame'; frame: HubViewFrame }
  | { t: number; kind: 'mirror'; mirror: ImMessage };

/** 穿穿插缝（同毫秒镜像先行——稳定序防抖动） */
function mergeTimeline(frames: HubViewFrame[], mirrorRows: ImMessage[], legacy: HubViewMessage[]): Array<TimelineEntry | { kind: 'legacy'; legacy: HubViewMessage; t: number }> {
  const entries: Array<TimelineEntry | { kind: 'legacy'; legacy: HubViewMessage; t: number }> = [
    ...frames.map((f) => ({ t: f.at, kind: 'frame' as const, frame: f })),
    ...mirrorRows.map((m) => ({ t: m.createdAt, kind: 'mirror' as const, mirror: m })),
    ...legacy.map((l) => ({ t: l.at, kind: 'legacy' as const, legacy: l })),
  ];
  return entries.sort((a, b) => a.t - b.t || (a.kind === 'mirror' ? -1 : 1));
}

export function RemoteSessionPanel({ sessionId, workspaceId }: { sessionId: string; workspaceId: string }): React.JSX.Element {
  const st = useRemoteSessionStore();
  const online = st.live && st.hubOnline;

  // 生命周期挂会话选中（spec §12.1）：mount 解析任务开订；unmount 退订
  //（StrictMode 双挂载安全：close 后 remount 重新 open）
  useEffect(() => {
    void (async () => {
      const task = await resolveTrackingTask({ id: sessionId, kind: 'task_execution', taskId: null, workspaceId });
      if (task !== null) {
        void useRemoteSessionStore.getState().open(task);
      }
    })();
    return () => {
      useRemoteSessionStore.getState().close();
    };
  }, [sessionId, workspaceId]);

  const timeline = mergeTimeline(st.frames, st.mirrorRows, st.wire2 ? [] : st.legacy);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-canvas" data-testid="remote-session-panel">
      {/* 状态条（壳外标题由会话面板负责——此处只承载远端态徽标） */}
      <div className="flex items-center gap-2 border-b border-subtle bg-surface-1 px-4 py-1.5">
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
        <Monitor size={12} strokeWidth={1.75} className="shrink-0 text-tertiary" aria-hidden />
        <span className={cn('truncate text-[11px]', online ? 'text-secondary' : 'text-tertiary')}>
          {st.target !== null ? `${st.target.nodeName} · run #${st.target.runNo} · ${st.target.workspaceName}` : '…'}
        </span>
        {!st.wire2 && st.phase === 'ready' && (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded bg-surface-3 px-1.5 py-[1px] text-[10px] text-tertiary">
            <Eye size={10} strokeWidth={1.75} aria-hidden />简版回放
          </span>
        )}
      </div>

      {/* 流域：穿插时间线 */}
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
          <div className="flex flex-col items-center gap-3 py-6 text-xs text-tertiary">
            <p>未找到执行会话（任务可能尚未开始）</p>
            <button
              type="button"
              className="cursor-pointer rounded-md border border-subtle bg-surface-1 px-3 py-1 text-[11.5px] text-secondary hover:bg-surface-2"
              onClick={() => {
                useRemoteSessionStore.getState().close();
                void (async () => {
                  const task = await resolveTrackingTask({ id: sessionId, kind: 'task_execution', taskId: null, workspaceId });
                  if (task !== null) void useRemoteSessionStore.getState().open(task);
                })();
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
            {timeline.length === 0 && st.pendingSteers.length === 0 && (
              <p className="py-4 text-center text-xs text-tertiary">（会话暂无事件）</p>
            )}
            {timeline.map((e) => {
              if (e.kind === 'mirror') return <MirrorRow key={`m-${e.mirror.id}`} m={e.mirror} />;
              if (e.kind === 'legacy') return <LegacyRow key={`l-${e.legacy.seq}`} m={e.legacy} />;
              return e.frame.kind === 'tool'
                ? <RemoteToolChip key={`f-${e.frame.frameId}`} frame={e.frame} />
                : <FrameBubble key={`f-${e.frame.frameId}`} frame={e.frame} streamingTail={isStreaming(e.frame, online)} />;
            })}
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

      {/* composer=steer（spec §12.4） */}
      <RemoteSteerComposer />
    </div>
  );
}
