// renderer/src/components/hub/RemoteSessionPanel.tsx
//
// 远端执行会话面板体（spec §12 D1 修订：跟踪会话面板直连）——住进标准会话面板壳
// （MiddlePanel 判 kind='task_execution' 时以本组件替换 MessageList+InputToolbar）。
// 内容：状态条（实时/断开/简版徽标 + run 号 + 节点）+ 穿插时间线（远端帧 + 本地
// 镜像里程碑，按时间戳、同毫秒镜像先行）+ RemoteSteerComposer。
// 生命周期由挂载驱动：mount → resolveTrackingTask → store.open；unmount → close。
// 降级矩阵：miss 占位重试 / 旧 worker legacy 行穿插镜像 / 断开保留已到帧。
import { useEffect, useRef, useState } from 'react';
import { Bot, ChevronUp, CircleCheck, Milestone, Wrench } from 'lucide-react';
import { cn } from '../../lib/cn';
import { resolveTrackingTask } from '../../lib/resolve-tracking-task';
import { useRemoteSessionStore } from '../../stores/remote-session.view';
import { ToolCallChip } from '../im/ToolCallChip';
import { MarkdownBody } from '../im/MarkdownBody';
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
        {/* 正文走统一 Markdown 入口（spec §7.2 与本地气泡同构） */}
        <MarkdownBody>{frame.content ?? ''}</MarkdownBody>
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

export function RemoteSessionPanel({ sessionId, workspaceId, footerSlot, footerExpanded = false }: {
  sessionId: string;
  workspaceId: string;
  /** 面板附属动作区（人工请求/验收卡——spec §12.3 布局：流域 → 动作区 → 指令输入框） */
  footerSlot?: React.ReactNode;
  /** 验收卡满屏（方案 V1）：流域让位、动作区吃满剩余高度 */
  footerExpanded?: boolean;
}): React.JSX.Element {
  const st = useRemoteSessionStore();
  const online = st.live && st.hubOnline;

  // 任务解析失败态（终审 Important 2）：孤儿跟踪会话 / 任务行已删 / list 瞬断
  // ——不得永久「定位执行会话…」，miss 样占位 + 重试
  const [resolveMiss, setResolveMiss] = useState(false);
  // 滚动贴底（2026-11-19 用户实测回归：切换回远端会话停留在顶部）：语义对齐
  // MessageList——首帧就绪/切会话必到底；后续新增帧仅在用户处于底部附近时
  // 跟随（浏览历史不被强行拉底）
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const didInitialScrollRef = useRef<string | null>(null);
  const prevTimelineLenRef = useRef(0);
  const handleStreamScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const resolveAndOpen = (): void => {
    setResolveMiss(false);
    void (async () => {
      const task = await resolveTrackingTask({ id: sessionId, kind: 'task_execution', taskId: null, workspaceId });
      if (task === null) {
        setResolveMiss(true);
        return;
      }
      void useRemoteSessionStore.getState().open(task);
    })();
  };

  // 生命周期挂会话选中（spec §12.1）：mount 解析任务开订；unmount 退订
  //（StrictMode 双挂载安全：close 后 remount 重新 open）
  useEffect(() => {
    resolveAndOpen();
    return () => {
      useRemoteSessionStore.getState().close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resolveAndOpen 为本组件闭包，依赖即 [sessionId, workspaceId]
  }, [sessionId, workspaceId]);

  const timeline = mergeTimeline(st.frames, st.mirrorRows, st.wire2 ? [] : st.legacy);
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || timeline.length === 0) return;
    const isRoomChange = didInitialScrollRef.current !== sessionId;
    const grew = timeline.length > prevTimelineLenRef.current;
    prevTimelineLenRef.current = timeline.length;
    // 首次就绪 / 切会话：必到底；后续增长：仅贴底附近跟随（浏览历史不拉底）
    if (isRoomChange || didInitialScrollRef.current === null || (grew && isNearBottomRef.current)) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
      isNearBottomRef.current = true;
    }
    didInitialScrollRef.current = sessionId;
  }, [timeline, sessionId]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-canvas" data-testid="remote-session-panel">
      {/* 流域：穿插时间线 */}
      <div
        ref={scrollRef}
        onScroll={handleStreamScroll}
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3',
          st.phase === 'ready' && !online && 'opacity-60',
          footerExpanded && 'hidden',
        )}
        data-testid="remote-session-flow"
      >
        {resolveMiss && (
          <div className="flex flex-col items-center gap-3 py-6 text-xs text-tertiary">
            <p>未找到关联的委派任务（任务可能已删除或尚未派发完成）</p>
            <button
              type="button"
              className="cursor-pointer rounded-md border border-subtle bg-surface-1 px-3 py-1 text-[11.5px] text-secondary hover:bg-surface-2"
              onClick={resolveAndOpen}
            >
              重试
            </button>
          </div>
        )}
        {!resolveMiss && st.phase === 'resolving' && (
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
                resolveAndOpen();
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
        {st.phase === 'ready' && st.target === null && (
          // 本机任务执行会话（2026-11-19）：无远端帧流——纯镜像行时间线
          //（执行过程/工具结果全在本地库）；无「加载更早」（镜像一次拉全量）
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1">
            {timeline.length === 0 && (
              <p className="py-4 text-center text-xs text-tertiary">（会话暂无事件）</p>
            )}
            {timeline.map((e) =>
              e.kind === 'mirror' ? <MirrorRow key={`m-${e.mirror.id}`} m={e.mirror} /> : null,
            )}
          </div>
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

      {/* 附属动作区（验收/人工请求——紧贴 composer 之上，随内容自适应但有高度上限） */}
      {footerSlot !== undefined && (
        <div
          className={cn(
            // footerExpanded（验收满屏）内部自管滚动；常态 40vh 上限内滚动——
            // 长选项 question 卡超出槽高时动作区（提交/输入）不得被 overflow-hidden
            // 静默裁掉（2026-11-19 实测 T-063/T-064：矮窗口下按钮不可达）
            'flex flex-col pb-3',
            footerExpanded ? 'min-h-0 flex-1 overflow-hidden' : 'max-h-[40vh] shrink-0 overflow-y-auto',
          )}
        >
          {footerSlot}
        </div>
      )}
      {/* composer=steer（spec §12.4；sessionId 传入 = 草稿仓键） */}
      {/* steer 是跨节点概念——本机任务执行会话不渲染远端指令框（2026-11-19） */}
      {st.task?.routing?.mode !== 'local' && <RemoteSteerComposer sessionId={sessionId} />}
    </div>
  );
}
