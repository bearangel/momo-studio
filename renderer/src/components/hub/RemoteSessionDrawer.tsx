// renderer/src/components/hub/RemoteSessionDrawer.tsx
//
// 远端会话只读抽屉（P3 S2，spec 2026-11-13 §7.3/§7.4；CONTRACT #1-10
// .omo/previews/2026-11-15-task-lifecycle-p3.html）：
// - 入口 RemoteSessionEntry：跟踪会话头「查看远端会话」钮——门控 =
//   session.delegationRole==='out' 且任务行 delegation_id 在场（CONTRACT #10）；
//   「补充指令」钮归 S3，本组件不渲染（择简裁定见任务报告）
// - 会话定位链（零协议改动，Review Focus #2——每次打开实时查不缓存）：
//   本地任务行 → hub:taskList 按 delegation_id 反查账本行（targetNodeId/
//   workspaceName/groupId/runNo）→ viewSessions 在执行方同名工作空间内按
//   任务标题匹配取 lastSeq 最高会话（rework 换 run = 新会话同标题，天然取最新）
//   → viewMessages 尾窗 50 条 + viewSubscribe 尾部订阅（groupId 传 delegation
//   组，消 commonGroupId 回退歧义）
//   注：协议 TaskRecord（1.12.0）无 sessionId 字段（hub toRecord 亦不投影），
//   故用 viewSessions 标题匹配反查——依据见任务报告「定位链勘误」节
// - 只读守卫（§7.4）：无 composer、不落本地消息表；底部只读提示条
// - 生命周期：关闭（X / Esc / 蒙层）与组件卸载都恰好一次 view.unsubscribe；
//   onViewAppended 按 sessionId 过滤 + seq 去重追加（沿 hub-view.store 模式，
//   但抽屉用组件内局部状态，不耦合整页回放 store）
// - 断开两源合并：订阅态（subscribe 失败 / 追加停止）∪ hub 连接态
//   （onStateChanged）——断开 = 灰徽标 + 流域降不透明度；hub 重连且订阅断时
//   自动重订 + 从已知尾 seq 补拉（CONTRACT #3「重连后恢复」语义）
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bot, ChevronUp, CircleCheck, Eye, Lock, Monitor, Wrench, X,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { noDragStyle } from '../../lib/platform';
import { formatHHmm } from '../../lib/time';
import { ipc } from '../../ipc/client';
import { humanizeViewError, VIEW_PAGE_SIZE } from '../../stores/hub-view.store';
import type { HubViewMessage, SessionSummary, TaskRow } from '../../ipc/types';

// ── 定位链产物（打开时实时解析； miss → 人话占位）────────────────────────────

interface ResolvedTarget {
  targetNodeId: string;
  workspaceName: string;
  /** delegation 组（view.* 载荷 groupId——协议可选段） */
  groupId: string | null;
  /** 执行尝试号（账本 runNo；缺省 1 兜底） */
  runNo: number;
  /** 执行方节点显示名（getNodes 解析失败 → 短 id） */
  nodeName: string;
  sessionId: string;
}

const MISS_TEXT = '未找到执行会话（任务可能尚未开始）';

/** 工具系统行判定：view-server 事件投影的两形态——调用起始「调用工具 X」与
 *  完成「工具 X 完成[: 摘要]」（CONTRACT #6 非气泡全宽行；结果摘要以 title 呈现） */
const TOOL_START_RE = /^调用工具 (\S+)$/;
const TOOL_END_RE = /^工具 (\S+) 完成/;

function parseToolRow(content: string): { name: string; done: boolean; excerpt: string } | null {
  const start = TOOL_START_RE.exec(content);
  if (start) return { name: start[1]!, done: true, excerpt: '' };
  const end = TOOL_END_RE.exec(content);
  if (end) return { name: end[1]!, done: true, excerpt: content };
  return null;
}

/** 节点短 id（>8 位掐头去尾；S3 SteerEntry 头部节点名降级同源） */
export function shortNodeId(nodeId: string): string {
  return nodeId.length > 8 ? `${nodeId.slice(0, 4)}…${nodeId.slice(-4)}` : nodeId;
}

/** 打开时定位链：taskList 反查账本行 → viewSessions 标题匹配 → 尾窗 + 订阅 */
async function resolveTarget(task: TaskRow): Promise<
  | { kind: 'ok'; target: ResolvedTarget; messages: HubViewMessage[]; hasMore: boolean }
  | { kind: 'miss' }
  | { kind: 'error'; message: string }
> {
  const routingGroupId = task.routing.mode !== 'local' ? task.routing.groupId : null;
  let record: { targetNodeId: string; workspaceName: string; groupId?: string; runNo?: number } | undefined;
  try {
    const { tasks } = await ipc.hub.taskList(
      routingGroupId !== null ? { groupId: routingGroupId } : undefined,
    );
    record = tasks.find((t) => t.taskId === task.delegationId);
  } catch (err) {
    return { kind: 'error', message: humanizeViewError(err) };
  }
  if (!record) return { kind: 'miss' };
  const groupId = record.groupId ?? routingGroupId;
  const viewSeg = groupId !== null ? { groupId } : {};

  let session: { sessionId: string; lastSeq: number } | undefined;
  try {
    const res = await ipc.hub.viewSessions({
      targetNodeId: record.targetNodeId,
      workspaceName: record.workspaceName,
      limit: VIEW_PAGE_SIZE,
      ...viewSeg,
    });
    // 执行方委派会话标题 = 任务书标题（delegation-runner createDelegatedSession）；
    // 清单按 lastSeq 降序——首个命中即最新 run 的会话（旧 run 会话同标题靠后）
    session = res.sessions.find((s) => s.title === task.title);
  } catch (err) {
    return { kind: 'error', message: humanizeViewError(err) };
  }
  if (!session) return { kind: 'miss' };

  let page: { messages: HubViewMessage[]; hasMore: boolean };
  try {
    page = await ipc.hub.viewMessages({
      targetNodeId: record.targetNodeId,
      sessionId: session.sessionId,
      workspaceName: record.workspaceName,
      // 含头窗口（沿 enterReplay 语义）：恰 50 条含头含尾，下限 1 防负越界
      fromSeq: Math.max(1, session.lastSeq - VIEW_PAGE_SIZE + 1),
      limit: VIEW_PAGE_SIZE,
      ...viewSeg,
    });
  } catch (err) {
    return { kind: 'error', message: humanizeViewError(err) };
  }

  let nodeName: string | null = null;
  try {
    const nodes = await ipc.hub.getNodes();
    nodeName = nodes.find((n) => n.nodeId === record.targetNodeId)?.nodeName ?? null;
  } catch {
    // 节点名是展示面——解析失败降级短 id，不阻断抽屉
  }

  return {
    kind: 'ok',
    target: {
      targetNodeId: record.targetNodeId,
      workspaceName: record.workspaceName,
      groupId,
      runNo: record.runNo ?? 1,
      nodeName: nodeName ?? shortNodeId(record.targetNodeId),
      sessionId: session.sessionId,
    },
    messages: page.messages,
    hasMore: page.hasMore,
  };
}

// ── 抽屉本体 ────────────────────────────────────────────────────────────────

interface RemoteSessionDrawerProps {
  task: TaskRow;
  onClose: () => void;
}

export function RemoteSessionDrawer({ task, onClose }: RemoteSessionDrawerProps) {
  const drawerRef = useRef<HTMLElement>(null);
  // 进场动画：mount 后下一帧滑入（TaskDetailDrawer 同款）
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const [phase, setPhase] = useState<'resolving' | 'ready' | 'miss' | 'error'>('resolving');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [target, setTarget] = useState<ResolvedTarget | null>(null);
  const [messages, setMessages] = useState<HubViewMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  /** 尾部订阅在线（subscribe 成功且未显式断开） */
  const [live, setLive] = useState(false);
  /** 订阅中断人话（离线 / forbidden）——null=正常 */
  const [liveError, setLiveError] = useState<string | null>(null);
  /** 最近一批 view.appended 的 seq 集（view-fade-in + 「新入」徽标让位） */
  const [newSeqs, setNewSeqs] = useState<Set<number>>(new Set());
  /** hub 连接态（断开徽标第二源） */
  const [hubOnline, setHubOnline] = useState(true);

  // 稳定引用：事件回调 / 清理路径读最新值，避免闭包过期
  const targetRef = useRef<ResolvedTarget | null>(null);
  const liveRef = useRef(false);
  const messagesRef = useRef<HubViewMessage[]>([]);
  targetRef.current = target;
  liveRef.current = live;
  messagesRef.current = messages;

  // 定位链（打开恰好一次；中途关闭 → 不落状态）
  useEffect(() => {
    let cancelled = false;
    setPhase('resolving');
    void resolveTarget(task).then((res) => {
      if (cancelled) return;
      if (res.kind === 'ok') {
        setTarget(res.target);
        setMessages(res.messages);
        setHasMore(res.hasMore);
        setPhase('ready');
        // 订阅失败不阻断回放——降级「已断开」（可重连自愈）
        const seg = res.target.groupId !== null ? { groupId: res.target.groupId } : {};
        void ipc.hub
          .viewSubscribe({ targetNodeId: res.target.targetNodeId, sessionId: res.target.sessionId, ...seg })
          .then(
            () => { if (!cancelled) setLive(true); },
            (err: unknown) => {
              if (!cancelled) setLiveError(humanizeViewError(err));
            },
          );
      } else if (res.kind === 'miss') {
        setPhase('miss');
      } else {
        setErrorText(res.message);
        setPhase('error');
      }
    });
    return () => { cancelled = true; };
  }, [task]);

  // 尾部增量：按 sessionId 过滤 + seq 去重追加（沿 hub-view.store init 模式）
  useEffect(() => {
    const dispose = ipc.hub.onViewAppended((evt) => {
      const t = targetRef.current;
      if (!t || t.sessionId !== evt.sessionId) return;
      const known = new Set(messagesRef.current.map((m) => m.seq));
      const fresh = evt.events.filter((e) => !known.has(e.seq));
      if (fresh.length === 0) return;
      setMessages([...messagesRef.current, ...fresh]);
      setNewSeqs(new Set(fresh.map((e) => e.seq)));
      // 追加到达即订阅在途（重订后首拍自愈 live 态）
      setLive(true);
      setLiveError(null);
    });
    return dispose;
  }, []);

  // hub 连接态（断开徽标数据源之一；重连 → 自动重订 + 尾后补拉）
  useEffect(() => {
    let prevOnline = true;
    const dispose = ipc.hub.onStateChanged((evt) => {
      const online = evt.state === 'online';
      setHubOnline(online);
      if (!online) {
        // hub 断开 = leader 侧订阅被 hub 自动注销（协议订阅注销三入口）——本地
        // live 同步降级，避免「自认为在线」永不再订
        setLive(false);
      }
      // 重连且订阅已断 → 重订（先退订幂等清锚，refreshReplay 同语义）+ 从已知尾补拉
      if (online && !prevOnline && !liveRef.current) {
        const t = targetRef.current;
        if (!t) return;
        const seg = t.groupId !== null ? { groupId: t.groupId } : {};
        void (async () => {
          await ipc.hub
            .viewUnsubscribe({ targetNodeId: t.targetNodeId, sessionId: t.sessionId, ...seg })
            .then(() => undefined, () => undefined);
          try {
            await ipc.hub.viewSubscribe({ targetNodeId: t.targetNodeId, sessionId: t.sessionId, ...seg });
          } catch (err) {
            setLiveError(humanizeViewError(err));
            return;
          }
          setLive(true);
          setLiveError(null);
          const knownLast =
            messagesRef.current.length > 0 ? messagesRef.current[messagesRef.current.length - 1]!.seq : 0;
          try {
            const page = await ipc.hub.viewMessages({
              targetNodeId: t.targetNodeId,
              sessionId: t.sessionId,
              workspaceName: t.workspaceName,
              fromSeq: knownLast + 1,
              limit: VIEW_PAGE_SIZE,
              ...seg,
            });
            const known = new Set(messagesRef.current.map((m) => m.seq));
            const fresh = page.messages.filter((m) => !known.has(m.seq));
            if (fresh.length > 0) setMessages([...messagesRef.current, ...fresh]);
          } catch {
            // 补拉失败保持已订阅态——后续 appended 仍会到达
          }
        })();
      }
      prevOnline = online;
    });
    return dispose;
  }, []);

  // 关闭 / 卸载：恰好一次退订（幂等清理，失败静默——hub 豁免路径）
  useEffect(() => {
    return () => {
      const t = targetRef.current;
      if (!t) return;
      const seg = t.groupId !== null ? { groupId: t.groupId } : {};
      void ipc.hub
        .viewUnsubscribe({ targetNodeId: t.targetNodeId, sessionId: t.sessionId, ...seg })
        .then(() => undefined, () => undefined);
    };
  }, []);

  // Esc 关闭（capture 拦截，TaskDetailDrawer 同款——不与宿主视图 Esc 双触发；
  // 抽屉内无嵌套弹窗，无需让位判定）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [onClose]);

  /** 加载更早（CONTRACT #4：触顶翻页，fromSeq 向上递减；加载中禁用） */
  const loadEarlier = (): void => {
    const t = targetRef.current;
    if (!t || loadingEarlier || !hasMore) return;
    const firstSeq = messages.length > 0 ? messages[0]!.seq : 0;
    const fromSeq = Math.max(0, firstSeq - VIEW_PAGE_SIZE);
    setLoadingEarlier(true);
    const seg = t.groupId !== null ? { groupId: t.groupId } : {};
    void ipc.hub
      .viewMessages({
        targetNodeId: t.targetNodeId,
        sessionId: t.sessionId,
        workspaceName: t.workspaceName,
        fromSeq,
        limit: VIEW_PAGE_SIZE,
        ...seg,
      })
      .then((page) => {
        setMessages((prev) => {
          const known = new Set(prev.map((m) => m.seq));
          const fresh = page.messages.filter((m) => !known.has(m.seq));
          return [...fresh, ...prev];
        });
        setHasMore(page.hasMore);
        setLoadingEarlier(false);
      })
      .catch(() => {
        setLoadingEarlier(false);
      });
  };

  const online = live && hubOnline;
  const last = messages.length > 0 ? messages[messages.length - 1]! : null;
  /** 流式增量态（CONTRACT #7）：在线且尾条为 assistant 文本事件 → 光标 + 生成中… */
  const streaming =
    online && last !== null && last.role === 'assistant' && parseToolRow(last.content) === null;

  return createPortal(
    <>
      <div
        data-testid="remote-session-backdrop"
        aria-hidden
        className="fixed inset-0 z-50 bg-backdrop"
        onClick={onClose}
      />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="远端执行会话（只读）"
        style={noDragStyle}
        className={cn(
          // CONTRACT #1：420px 右缘全高；蒙层压暗主窗口；-18px 0 44px 阴影
          'fixed bottom-0 right-0 top-0 z-50 flex w-[420px] flex-col border-l border-strong bg-canvas shadow-[-18px_0_44px_rgba(0,0,0,0.24)] transition-transform duration-200 ease-out',
          entered ? 'translate-x-0' : 'translate-x-full',
        )}
        data-testid="remote-session-drawer"
      >
        {/* CONTRACT #2：抽屉头两行——实时徽标 + 标题 13px/600 + 关闭钮；副行 Monitor 11px */}
        <div className="flex flex-col gap-0.5 border-b border-subtle bg-surface-1 pb-2 pt-[9px] pl-3.5 pr-3.5">
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
            <span
              className={cn(
                'truncate text-[13px] font-semibold',
                online ? 'text-primary' : 'text-tertiary',
              )}
            >
              执行会话 · {target?.nodeName ?? '…'} · 只读
            </span>
            <button
              type="button"
              aria-label="关闭抽屉"
              onClick={onClose}
              className="ml-auto flex h-[26px] w-[26px] shrink-0 cursor-pointer items-center justify-center rounded-md text-tertiary hover:bg-surface-2 hover:text-primary"
            >
              <X size={14} strokeWidth={1.75} aria-hidden />
            </button>
          </div>
          <div className="flex items-center gap-[5px] truncate text-[10.5px] text-tertiary">
            <Monitor size={11} strokeWidth={1.75} className="shrink-0" aria-hidden />
            {target !== null
              ? `#${task.id} ${task.title} · run #${target.runNo} · ${target.nodeName} · ${target.workspaceName}`
              : `#${task.id} ${task.title}`}
          </div>
        </div>

        {/* 流域（CONTRACT #5：gap 10 / px 14 py 12；断开整体降不透明度 .6） */}
        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3.5 py-3',
            phase === 'ready' && !online && 'opacity-60',
          )}
          data-testid="remote-session-flow"
        >
          {phase === 'resolving' && (
            <p className="flex items-center justify-center gap-2 py-6 text-xs text-tertiary">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-status-violet border-t-transparent" aria-hidden />
              定位执行会话…
            </p>
          )}
          {phase === 'miss' && (
            <p className="py-6 text-center text-xs leading-relaxed text-tertiary" data-testid="remote-session-miss">
              {MISS_TEXT}
            </p>
          )}
          {phase === 'error' && (
            <p
              className="mx-1 rounded-md bg-status-error-tint px-2.5 py-2 text-xs leading-relaxed text-status-error"
              role="alert"
              data-testid="remote-session-error"
            >
              {errorText}
            </p>
          )}
          {phase === 'ready' && target !== null && (
            <>
              {/* CONTRACT #4：全宽 ghost 钮加载更早（h 28 / ChevronUp 14 / 11.5px secondary） */}
              {hasMore && (
                <button
                  type="button"
                  onClick={loadEarlier}
                  disabled={loadingEarlier}
                  data-testid="remote-session-load-earlier"
                  className="flex h-7 w-full cursor-pointer items-center justify-center gap-[5px] rounded-md border border-subtle bg-surface-1 text-[11.5px] text-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-55"
                >
                  {loadingEarlier ? (
                    <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-status-violet border-t-transparent" aria-hidden />
                  ) : (
                    <ChevronUp size={14} strokeWidth={1.75} aria-hidden />
                  )}
                  {loadingEarlier ? '加载中…' : '加载更早'}
                </button>
              )}
              {messages.length === 0 && (
                <p className="py-4 text-center text-xs text-tertiary">（会话暂无事件）</p>
              )}
              {messages.map((m) => {
                const tool = parseToolRow(m.content);
                const isNew = newSeqs.has(m.seq);
                return (
                  <div key={m.seq} className={isNew ? 'view-fade-in' : undefined}>
                    {tool !== null ? (
                      // CONTRACT #6：工具系统行——非气泡全宽（4px 8px / 圆角 6 / mono 名 + CircleCheck）
                      <div
                        className="flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-2 py-1 text-[11px] text-secondary"
                        title={tool.excerpt || undefined}
                      >
                        <Wrench size={12} strokeWidth={1.75} className="shrink-0 text-tertiary" aria-hidden />
                        调用工具
                        <span className="font-mono text-[10.5px] text-primary">{tool.name}</span>
                        {tool.done && (
                          <CircleCheck size={12} strokeWidth={1.75} className="shrink-0 text-status-success" aria-hidden />
                        )}
                        <span className="ml-auto shrink-0 text-[10px] text-tertiary">{formatHHmm(m.at)}</span>
                      </div>
                    ) : m.role === 'user' ? (
                      // CONTRACT #5 user 气泡：accent-500 反白右对齐 max-w 86% / 内嵌时间戳 10px 反白 72%
                      <div className="ml-auto w-fit max-w-[86%] rounded-[10px] bg-accent-500 px-[11px] py-[7px] text-[12.5px] leading-[1.6] text-inverse">
                        <span className="whitespace-pre-wrap break-words">{m.content}</span>
                        <span className="mt-[3px] block text-right text-[10px] text-white/72">{formatHHmm(m.at)}</span>
                      </div>
                    ) : (
                      // CONTRACT #5 assistant：meta 行（Bot 11 + 节点 10.5 secondary + 时间 10 tertiary）+ surface-2 气泡占满
                      <div>
                        <div className="mb-[3px] flex items-center gap-[5px] text-[10px] text-tertiary">
                          <span className="flex items-center gap-1 text-[10.5px] text-secondary">
                            <Bot size={11} strokeWidth={1.75} aria-hidden />
                            {target.nodeName}
                          </span>
                          {formatHHmm(m.at)}
                          {isNew && (
                            // CONTRACT #8：「新入」徽标（下一批到达即让位——newSeqs 随批整体替换）
                            <span className="inline-flex h-4 items-center rounded bg-surface-active px-1.5 text-[10px] font-medium text-accent-600 dark:text-accent-300">
                              新入
                            </span>
                          )}
                          {streaming && m === last && (
                            <span className="text-[10px] text-tertiary">生成中…</span>
                          )}
                        </div>
                        <div className="rounded-[10px] border border-subtle bg-surface-2 px-[11px] py-[7px] text-[12.5px] leading-[1.6] text-primary">
                          <span className="whitespace-pre-wrap break-words">{m.content}</span>
                          {/* CONTRACT #7：流式光标块（7×13 accent-500 blink；断开态隐藏） */}
                          {streaming && m === last && <span className="remote-stream-cursor" aria-hidden />}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {!online && liveError !== null && phase === 'ready' && (
                <p className="px-1 py-1.5 text-[11px] text-status-warning" role="alert">{liveError}</p>
              )}
            </>
          )}
        </div>

        {/* CONTRACT #9：无 composer——底部只读条（h 30 / Lock 12 / 11px disabled） */}
        <div className="flex h-[30px] shrink-0 items-center justify-center gap-1.5 border-t border-subtle bg-surface-1 text-[11px] text-disabled">
          <Lock size={12} strokeWidth={1.75} aria-hidden />
          只读回放 · 不落本地消息
        </div>
      </aside>
    </>,
    document.body,
  );
}

// ── 会话头入口（CONTRACT #10：delegationRole='out' 且详情有 delegation）──────

export function RemoteSessionEntry({ session }: { session: SessionSummary }) {
  const [task, setTask] = useState<TaskRow | null>(null);
  const [open, setOpen] = useState(false);

  // 门控数据：SessionSummary.taskId → 任务行 delegation_id（本地读，轻量）
  useEffect(() => {
    let cancelled = false;
    if (session.delegationRole !== 'out' || session.taskId === null) {
      setTask(null);
      return;
    }
    setTask(null);
    void ipc.task.get(session.taskId).then((row) => {
      if (cancelled) return;
      setTask(row !== null && row.delegationId !== null ? row : null);
    });
    return () => { cancelled = true; };
  }, [session.delegationRole, session.taskId]);

  if (task === null) return null;

  return (
    <>
      <button
        type="button"
        data-testid="remote-session-entry"
        aria-label={`查看 ${session.title} 的远端执行会话`}
        onClick={() => setOpen(true)}
        className={cn(
          // CONTRACT #10：btn-sm（h 24 / px 9 / 11.5px·500）+ Eye 14；打开态 accent 着色
          'inline-flex h-6 shrink-0 cursor-pointer items-center gap-[5px] rounded-md border px-[9px] text-[11.5px] font-medium',
          open
            ? 'border-focus bg-surface-active text-accent-600 dark:text-accent-300'
            : 'border-strong bg-surface-1 text-primary hover:bg-surface-3',
        )}
      >
        <Eye size={14} strokeWidth={1.75} aria-hidden />
        查看远端会话
      </button>
      {open && <RemoteSessionDrawer task={task} onClose={() => setOpen(false)} />}
    </>
  );
}
