// renderer/src/components/hub/ViewPanel.tsx
//
// 「查看工作空间」四视图面板（momo-hub M2e T14，spec §5.4 leader 侧，
// task-14-preview 批准稿）。嵌在 GroupPanel 在线视图下方（面板区段形态）：
// - 壳 = T12 区段面板同款：640px · bg-canvas 底 · border-subtle 边 · 10px 圆角；
//   头部 30px 图标位（Eye）+ 两行标题（目标节点 · 工作空间）+ 右侧动作区
// - 页签 = CapabilityTabs 文字下划线页签节律（12px / px 10/5 / active 2px
//   accent 下划线 + -mb-px；计数 10.5px tertiary；页签无图标）
// - 只读提示条常驻（surface-2 底 + EyeOff 12px accent +「只读视图——远程操作
//   M2 不提供」）——四页签与回放视图全部只读（§8.4 红线，UI 测试断言）
// - 回放视图是二级视图：返回头（ChevronLeft + 会话标题 + 实时徽标）+「加载
//   更早」锚顶分页 + MessageFrame/ToolCallChip 同基准消息流（与本地会话/
//   T12 进度流共用，不发明第二套气泡）+ view.appended 淡入追加（150ms）
// - 空间选择前置步：本机多工作空间时先出下拉（T12 Select 同款）再进面板
import { useEffect, type ReactNode } from 'react';
import {
  ArrowUpToLine, Bot, ChevronLeft, Eye, EyeOff, ListTodo, MessageSquare, Monitor,
  Plug, Puzzle, Radio, RefreshCw, Settings2, SlidersHorizontal, Sparkles, Users, X,
} from 'lucide-react';
import { useHubViewStore, type ViewTab } from '../../stores/hub-view.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { taskStatusStyle } from '../../lib/task-status';
import { MessageFrame } from '../im/MessageFrame';
import { ToolCallChip } from '../im/ToolCallChip';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { Spinner } from '../ui/Spinner';
import type { HubViewMessage, HubViewOverview, TaskStatus } from '../../ipc/types';

const TABS: Array<{ key: ViewTab; label: string }> = [
  { key: 'overview', label: '概览' },
  { key: 'sessions', label: '会话' },
  { key: 'tasks', label: '任务' },
  { key: 'config', label: '配置' },
];

function formatDayTime(ts: number): string {
  const d = new Date(ts);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `今天 ${hhmm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
}

/** 任务状态徽标（task-status 语义色单源；未知状态回中性兜底） */
function ViewTaskStatusBadge({ status }: { status: string }) {
  const known = status in { draft: 1, pending: 1, assigned: 1, session_queued: 1, in_progress: 1, paused: 1, completed: 1, cancelled: 1, failed: 1 };
  if (!known) return <Badge>{status}</Badge>;
  const style = taskStatusStyle(status as TaskStatus);
  return <Badge tone={style.tone}>{style.label}</Badge>;
}

/** 回放消息渲染：与本地会话/T12 进度流共用 MessageFrame/ToolCallChip（渲染复用红线） */
function ReplayMessage({ msg, fadeIn }: { msg: HubViewMessage; fadeIn: boolean }) {
  const tool = /^调用工具 (\S+)$/.exec(msg.content);
  return (
    <div className={fadeIn ? 'view-fade-in' : undefined}>
      <MessageFrame
        sender={msg.role === 'user' ? 'owner' : 'assistant'}
        isSelf={msg.role === 'user'}
        senderName={msg.role === 'user' ? undefined : 'agent'}
        timestamp={msg.at}
        maxWidthPct={86}
        fillWidth={msg.role !== 'user'}
        bubbleClassName={msg.role === 'user' ? 'bg-accent-500 text-inverse' : 'bg-surface-2'}
      >
        {tool ? (
          <div className="my-0.5">
            <ToolCallChip toolName={tool[1]!} args={{}} success tone="neutral" />
          </div>
        ) : (
          <span className="whitespace-pre-wrap break-words">{msg.content}</span>
        )}
      </MessageFrame>
    </div>
  );
}

/** 摘要卡行（T8 快照摘要卡同款节律） */
function SummaryRow({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 py-[5px]">
      <span className="text-tertiary shrink-0" aria-hidden>{icon}</span>
      <span className="text-[12.5px] text-primary flex-1 min-w-0 truncate">{label}</span>
      <span className="text-[12.5px] text-secondary shrink-0">{value}</span>
    </div>
  );
}

function ConfigCard({ icon, title, lines }: { icon: ReactNode; title: string; lines: string[] }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-subtle bg-surface-1 p-3">
      <div className="flex items-center gap-2 text-[13px] font-medium text-primary">
        <span className="text-tertiary" aria-hidden>{icon}</span>
        {title}
        <Badge>{lines.length}</Badge>
      </div>
      {lines.length === 0 ? (
        <p className="text-[11.5px] text-tertiary">（无）</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {lines.map((l) => (
            <li key={l} className="truncate font-mono text-[11.5px] text-secondary">{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ViewPanel() {
  const st = useHubViewStore();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const loadWorkspaces = useWorkspaceStore((s) => s.load);
  const init = useHubViewStore((s) => s.init);

  useEffect(() => init(), [init]);
  useEffect(() => {
    if (useHubViewStore.getState().picking && workspaces.length === 0) void loadWorkspaces();
  }, [workspaces.length, loadWorkspaces, st.picking]);

  if (!st.open) return null;

  if (st.picking) {
    return (
      <section className="flex w-full max-w-[640px] flex-col gap-3 rounded-[10px] border border-subtle bg-canvas p-4" aria-label="选择工作空间">
        <div className="flex items-center gap-2.5">
          <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md bg-surface-active text-accent-600 dark:text-accent-300">
            <Eye size={16} strokeWidth={1.75} aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold text-primary">查看 {st.targetName} 的工作空间</div>
            <div className="text-[11px] text-tertiary">选择要查看的工作空间</div>
          </div>
          <Button variant="ghost" size="sm" className="ml-auto h-7 w-7 px-0" aria-label="取消查看" onClick={st.close}>
            <X size={14} strokeWidth={1.75} aria-hidden />
          </Button>
        </div>
        <Select
          value=""
          onChange={(e) => {
            const hit = workspaces.find((w) => w.id === e.target.value);
            if (hit) st.pickWorkspace(hit.id, hit.name);
          }}
          aria-label="选择工作空间"
        >
          <option value="" disabled>选择工作空间…</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </Select>
      </section>
    );
  }

  return (
    <section
      className="flex w-full max-w-[640px] flex-col gap-3 rounded-[10px] border border-subtle bg-canvas p-4"
      aria-label={`查看 ${st.targetName} 的工作空间 ${st.workspaceName}`}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md bg-surface-active text-accent-600 dark:text-accent-300">
          <Eye size={16} strokeWidth={1.75} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-primary">{st.targetName} · {st.workspaceName}</div>
          <div className="text-[11px] text-tertiary">
            远程只读视图 · 数据经 hub 定向拉取（<span className="font-mono">{st.targetNodeId?.slice(0, 8) ?? ''}</span>）
          </div>
        </div>
        <Button variant="ghost" size="sm" className="h-7 w-7 px-0" aria-label="刷新当前页签" disabled={st.loading || st.replay !== null} onClick={() => void st.refresh()}>
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 px-0" aria-label="关闭查看面板" onClick={st.close}>
          <X size={14} strokeWidth={1.75} aria-hidden />
        </Button>
      </div>

      <div className="flex items-center gap-2 rounded-md border border-subtle bg-surface-2 px-2.5 py-2">
        <EyeOff size={12} strokeWidth={1.75} className="shrink-0 text-accent-600 dark:text-accent-300" aria-hidden />
        <span className="text-[11.5px] leading-relaxed text-secondary">只读视图——远程操作 M2 不提供</span>
      </div>

      {st.error !== null && (
        <p className="rounded-md bg-status-error-tint px-2.5 py-2 text-xs text-status-error" role="alert">{st.error}</p>
      )}

      {st.replay !== null ? (
        <ReplayView />
      ) : (
        <>
          <div className="flex items-end gap-0 border-b border-subtle" role="tablist" aria-label="查看页签">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={st.tab === t.key}
                onClick={() => st.switchTab(t.key)}
                className={`-mb-px flex items-center gap-1 border-b-2 px-2.5 py-[5px] text-xs cursor-pointer ${
                  st.tab === t.key
                    ? 'border-accent-500 text-accent-600 dark:text-accent-300'
                    : 'border-transparent text-secondary hover:text-primary'
                }`}
              >
                {t.label}
                {t.key === 'sessions' && <span className="text-[10.5px] text-tertiary">{st.sessions.length}</span>}
                {t.key === 'tasks' && <span className="text-[10.5px] text-tertiary">{st.tasks.length}</span>}
              </button>
            ))}
          </div>

          {st.loading && (
            <p className="flex items-center gap-2 px-1 py-3 text-xs text-tertiary"><Spinner size={12} /> 拉取中…</p>
          )}

          {st.tab === 'overview' && st.overview !== null && <OverviewTab overview={st.overview} />}
          {st.tab === 'sessions' && <SessionsTab />}
          {st.tab === 'tasks' && <TasksTab />}
          {st.tab === 'config' && st.overview !== null && <ConfigTab overview={st.overview} />}
        </>
      )}
    </section>
  );
}

function OverviewTab({ overview }: { overview: HubViewOverview }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col rounded-lg border border-subtle bg-surface-1 p-3">
        <SummaryRow icon={<Monitor size={14} strokeWidth={1.75} />} label="工作空间" value={overview.overview.name} />
        <SummaryRow icon={<MessageSquare size={14} strokeWidth={1.75} />} label="会话数" value={overview.overview.sessionCount} />
        <SummaryRow icon={<Users size={14} strokeWidth={1.75} />} label="agent 成员" value={overview.agentMembers.length} />
        <SummaryRow icon={<Sparkles size={14} strokeWidth={1.75} />} label="团队" value={overview.teams.length} />
      </div>
      <div className="flex flex-col rounded-lg border border-subtle bg-surface-1 p-3">
        <div className="mb-1 text-[12.5px] font-medium text-primary">资源统计（四类）</div>
        <SummaryRow icon={<Bot size={14} strokeWidth={1.75} />} label="agent 定义" value={overview.resourcesSummary.agent} />
        <SummaryRow icon={<Plug size={14} strokeWidth={1.75} />} label="MCP" value={overview.resourcesSummary.mcp} />
        <SummaryRow icon={<Settings2 size={14} strokeWidth={1.75} />} label="skill" value={overview.resourcesSummary.skill} />
        <SummaryRow icon={<Puzzle size={14} strokeWidth={1.75} />} label="插件" value={overview.resourcesSummary.plugin} />
      </div>
      {overview.teams.length > 0 && (
        <div className="flex flex-col rounded-lg border border-subtle bg-surface-1 p-3">
          <div className="mb-1 text-[12.5px] font-medium text-primary">团队</div>
          {overview.teams.map((t) => (
            <SummaryRow key={t.name} icon={<Users size={14} strokeWidth={1.75} />} label={`${t.name}（leader ${t.leaderName}）`} value={`${t.memberNames.length} 成员`} />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionsTab() {
  const sessions = useHubViewStore((s) => s.sessions);
  const enterReplay = useHubViewStore((s) => s.enterReplay);
  if (sessions.length === 0) {
    return <p className="rounded-lg border border-subtle bg-surface-1 px-3 py-4 text-center text-xs text-tertiary">目标工作空间暂无会话</p>;
  }
  return (
    <div className="flex flex-col">
      {sessions.map((s) => (
        <button
          key={s.sessionId}
          type="button"
          onClick={() => void enterReplay(s)}
          aria-label={`回放会话 ${s.title}`}
          className="mb-1.5 flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-subtle bg-surface-1 px-3 py-2.5 text-left"
        >
          <MessageSquare size={16} strokeWidth={1.75} className="shrink-0 text-tertiary" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-primary">{s.title}</span>
            <span className="mt-0.5 block truncate font-mono text-[10.5px] text-tertiary">
              {s.sessionId.slice(0, 13)} · {formatDayTime(s.updatedAt)} · {s.lastSeq} 条事件
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

function TasksTab() {
  const tasks = useHubViewStore((s) => s.tasks);
  if (tasks.length === 0) {
    return <p className="rounded-lg border border-subtle bg-surface-1 px-3 py-4 text-center text-xs text-tertiary">目标工作空间暂无本地任务</p>;
  }
  return (
    <div className="flex flex-col">
      {tasks.map((t) => (
        <div
          key={t.taskId}
          className="mb-1.5 flex w-full items-center gap-2.5 rounded-lg border border-subtle bg-surface-1 px-3 py-2.5"
          aria-label={`任务 ${t.title}`}
        >
          <ListTodo size={16} strokeWidth={1.75} className="shrink-0 text-tertiary" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-primary">{t.title}</span>
            <span className="mt-0.5 block truncate font-mono text-[10.5px] text-tertiary">{t.taskId} · {formatDayTime(t.updatedAt)}</span>
          </span>
          <ViewTaskStatusBadge status={t.status} />
        </div>
      ))}
    </div>
  );
}

function ConfigTab({ overview }: { overview: HubViewOverview }) {
  return (
    <div className="flex flex-col gap-2">
      <ConfigCard icon={<Bot size={14} strokeWidth={1.75} />} title="agent 定义" lines={overview.agentMembers.map((m) => m.agentSlug ?? m.name)} />
      <ConfigCard icon={<Users size={14} strokeWidth={1.75} />} title="团队" lines={overview.teams.map((t) => `${t.name}: ${t.memberNames.join('、')}`)} />
      <ConfigCard icon={<Plug size={14} strokeWidth={1.75} />} title="MCP（stdio 引用）" lines={overview.mcpEnabled} />
      <ConfigCard icon={<Sparkles size={14} strokeWidth={1.75} />} title="skill" lines={overview.skills} />
      <ConfigCard icon={<Puzzle size={14} strokeWidth={1.75} />} title="插件（启用）" lines={overview.pluginsEnabled} />
      <ConfigCard icon={<SlidersHorizontal size={14} strokeWidth={1.75} />} title="偏好" lines={[]} />
    </div>
  );
}

function ReplayView() {
  const st = useHubViewStore();
  const replay = st.replay!;
  const lastSeq = replay.messages.length > 0 ? replay.messages[replay.messages.length - 1]!.seq : 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="h-7 w-7 px-0" aria-label="返回会话列表" onClick={st.leaveReplay}>
          <ChevronLeft size={14} strokeWidth={1.75} aria-hidden />
        </Button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-primary">{replay.title}</span>
        {replay.live ? (
          <Badge tone="accent"><Radio size={12} strokeWidth={1.75} aria-hidden /> 实时</Badge>
        ) : (
          <Badge>{replay.liveError ?? '已断开'}</Badge>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={!replay.live}
          onClick={() => void st.disconnectLive()}
        >
          断开订阅
        </Button>
      </div>

      <div className="flex items-center justify-center border-b border-subtle pb-2">
        {replay.hasMore ? (
          <button
            type="button"
            onClick={() => void st.loadEarlier()}
            disabled={replay.loadingEarlier}
            className="flex h-7 items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-3 text-[12.5px] text-secondary cursor-pointer disabled:opacity-55"
          >
            <ArrowUpToLine size={12} strokeWidth={1.75} aria-hidden />
            {replay.loadingEarlier ? '加载中…' : '加载更早'}
          </button>
        ) : (
          <span className="flex h-7 items-center px-3 text-[11px] text-disabled">已到最早</span>
        )}
      </div>

      <div className="flex max-h-[420px] flex-col overflow-y-auto px-1 py-1">
        {replay.messages.length === 0 && (
          <p className="py-4 text-center text-xs text-tertiary">（会话暂无事件）</p>
        )}
        {replay.messages.map((m) => (
          <div key={m.seq}>
            {replay.batches[m.seq] === true && (
              <div className="flex items-center justify-center gap-1.5 py-1 text-[10.5px] text-tertiary">
                — view.appended · seq <span className="font-mono text-[10px]">{m.seq}</span> · 淡入追加 —
              </div>
            )}
            <ReplayMessage msg={m} fadeIn={replay.batches[m.seq] === true} />
          </div>
        ))}
        {replay.live && (
          <div className="flex items-center gap-1.5 px-1 pb-1 pt-1.5 text-[11px] text-secondary">
            <Radio size={11} strokeWidth={1.75} className="text-accent-600 dark:text-accent-300" aria-hidden />
            <span className="h-[7px] w-[7px] rounded-full bg-status-success" aria-hidden />
            实时 · seq <span className="font-mono text-[10.5px] text-tertiary">{lastSeq}</span> 追加中
          </div>
        )}
        {!replay.live && replay.liveError !== null && (
          <p className="px-1 py-1.5 text-[11px] text-status-warning" role="alert">{replay.liveError}</p>
        )}
      </div>
    </div>
  );
}
