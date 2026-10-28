// renderer/src/components/workgroup/RemoteViewPane.tsx
//
// 全宽远程查看视图（momo-hub M2.1 Task 4，视觉合同 .omo/previews/hub-ia-fullapp.html
// S4 屏）——逻辑自 hub/ViewPanel.tsx 迁移重构（hub-view.store 原样消费，语义零改），
// 容器自 640px 内嵌卡升级为工作组主区整体替换（WorkgroupView 查看态分发）：
// - 头部：nicon 26px（Eye）+「节点 · 空间名」13.5px/600 + mono「远程只读 · 定向拉取
//   node:xxxx…yyyy」+ 会话上下文徽标（回放态）+ 刷新（回放态=刷新回放）+「退出查看」
// - 只读红线横幅常驻（四页签 + 回放视图）：EyeOff +「只读视图——远程操作 M2 不
//   提供 · 关闭入口仅目标侧「允许本组查看」」（§8.4 红线，UI 测试断言）
// - 四页签 = CapabilityTabs 文字下划线页签节律（S4 定值 px 12/7/6、计数 10.5px
//   tertiary、active 2px accent 下划线 + -mb-px）
// - 会话页 = 会话列表 → 回放消息流：MessageFrame/ToolCallChip 同基准渲染（与本地
//   会话/T12 进度流共用，不发明第二套气泡）+ 居中「加载更早（seq 范围）」pill +
//   底部 spinner「实时追加中」行 + view.appended 淡入追加（150ms）
// - 任务页 = tcard 列 + mono #T-id + 状态徽标；「来自 X 委派」来源标注待 RM-M21-7
//   （T6 登记表）接入——HubViewLocalTask 协议无来源字段，不编造
// - 文件页（M3.2 协议 1.4.0，hubSupportsMinor(4) 门控——低版本隐藏 tab）= 懒加载
//   目录树（进页拉根、逐层展开）+ 文件点击 read 预览（base64 解码文本 / 二进制
//   占位）+ 500/256KB truncated 明示；复用既有 TABS 容器与列表行样式，无新布局语言
import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowUpToLine, Bot, ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff, FileText,
  Folder, FolderOpen, MessageSquare, Monitor,
  Plug, Puzzle, Radio, RefreshCw, Settings2, SlidersHorizontal, Sparkles, Users, X,
} from 'lucide-react';
import { useHubViewStore, VIEW_PAGE_SIZE, type ViewTab } from '../../stores/hub-view.store';
import { useHubStore } from '../../stores/hub.store';
import { hubSupportsMinor } from '../../lib/hub-capability';
import { taskStatusStyle } from '../../lib/task-status';
import { MessageFrame } from '../im/MessageFrame';
import { ToolCallChip } from '../im/ToolCallChip';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import type { HubViewMessage, HubViewOverview, TaskStatus } from '../../ipc/types';

/** 文件 tab 的协议门槛（M3.2 协议 1.4.0：view.files）——低版本 hub 隐藏 tab */
const FILES_REQUIRED_MINOR = 4;

const TABS: Array<{ key: ViewTab; label: string }> = [
  { key: 'overview', label: '概览' },
  { key: 'sessions', label: '会话' },
  { key: 'tasks', label: '任务' },
  { key: 'files', label: '文件' },
  { key: 'config', label: '配置' },
];

function shortNodeId(nodeId: string): string {
  return nodeId.length > 8 ? `${nodeId.slice(0, 4)}…${nodeId.slice(-4)}` : nodeId;
}

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

export function RemoteViewPane() {
  const st = useHubViewStore();
  const init = useHubViewStore((s) => s.init);
  const hubProtoVer = useHubStore((s) => s.status?.hubProtoVer ?? null);
  const filesEnabled = hubSupportsMinor(hubProtoVer, FILES_REQUIRED_MINOR);
  // 文件 tab 门控与 picker 远端清单同门槛（spec §2.4）——旧 hub 无 view.files
  const tabs = filesEnabled ? TABS : TABS.filter((t) => t.key !== 'files');

  useEffect(() => init(), [init]);

  if (!st.open || st.picking) return null;

  const nodeLabel = st.targetNodeId !== null ? `node:${shortNodeId(st.targetNodeId)}` : 'node:—';

  return (
    <section
      aria-label={`查看 ${st.targetName} 的工作空间 ${st.workspaceName}`}
      className="flex min-w-0 flex-1 flex-col bg-canvas"
    >
      <div className="flex items-center gap-2.5 border-b border-subtle px-4 py-3">
        <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md bg-surface-active text-accent-600 dark:text-accent-300">
          <Eye size={14} strokeWidth={1.75} aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-semibold text-primary">{st.targetName} · {st.workspaceName}</div>
          <div className="truncate font-mono text-[10.5px] text-tertiary">远程只读 · 定向拉取 {nodeLabel}</div>
        </div>
        {st.replay !== null && (
          <Badge className="ml-auto min-w-0 shrink-0">
            <span className="max-w-[280px] truncate">会话：{st.replay.title}</span>
          </Badge>
        )}
        <span className={`flex shrink-0 items-center gap-1.5 ${st.replay !== null ? '' : 'ml-auto'}`}>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 px-0"
            aria-label={st.replay !== null ? '刷新回放' : '刷新当前页签'}
            disabled={st.loading}
            onClick={() => void st.refresh()}
          >
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
          </Button>
          <Button variant="ghost" size="sm" aria-label="退出查看" onClick={st.close}>
            <X size={14} strokeWidth={1.75} aria-hidden />
            退出查看
          </Button>
        </span>
      </div>

      <div className="px-4 pt-2">
        <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5">
          <EyeOff size={12} strokeWidth={1.75} className="shrink-0 text-accent-600 dark:text-accent-300" aria-hidden />
          <span className="text-[11.5px] leading-relaxed text-secondary">
            只读视图——远程操作 M2 不提供 · 关闭入口仅 {st.targetName} 侧「允许本组查看」
          </span>
        </div>
      </div>

      {st.error !== null && (
        <p className="mx-4 mt-2 rounded-md bg-status-error-tint px-2.5 py-2 text-xs text-status-error" role="alert">{st.error}</p>
      )}

      {st.replay !== null ? (
        <ReplayView />
      ) : (
        <>
          <div className="flex items-end gap-0 border-b border-subtle px-4" role="tablist" aria-label="查看页签">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={st.tab === t.key}
                onClick={() => st.switchTab(t.key)}
                className={`-mb-px flex cursor-pointer items-center gap-[5px] border-b-2 px-3 pb-[6px] pt-[7px] text-xs ${
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

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-3">
            {st.loading && (
              <p className="flex items-center gap-2 px-1 py-3 text-xs text-tertiary"><Spinner size={12} /> 拉取中…</p>
            )}
            {st.tab === 'overview' && st.overview !== null && <OverviewTab overview={st.overview} />}
            {st.tab === 'sessions' && <SessionsTab />}
            {st.tab === 'tasks' && <TasksTab />}
            {st.tab === 'files' && <FilesTab />}
            {st.tab === 'config' && st.overview !== null && <ConfigTab overview={st.overview} />}
          </div>
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
          className="mb-1.5 flex w-full flex-col gap-1.5 rounded-[9px] border border-subtle bg-surface-1 px-2.5 py-2.5"
          aria-label={`任务 ${t.title}`}
        >
          <span className="truncate text-[12.5px] font-medium text-primary">{t.title}</span>
          <div className="flex min-w-0 items-center gap-1.5">
            <ViewTaskStatusBadge status={t.status} />
            {/* TODO RM-M21-7：「来自 X 委派」来源标注——T6 镜像/委派登记表接入，协议 ViewLocalTask 现无来源字段 */}
            <span className="truncate font-mono text-[10.5px] text-tertiary">{t.taskId} · {formatDayTime(t.updatedAt)}</span>
          </div>
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

/** 字节数人话（B/KB/MB——AuditLog/MirrorWizard 同法，文件树尺寸列共用） */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 目录条目相对路径拼接（'/' 分隔——与 view.files / searchNames 路径约定一致） */
function joinPath(dir: string, name: string): string {
  return dir === '.' ? name : `${dir}/${name}`;
}

/** 懒加载目录树节点：展开即拉该层 list（已加载幂等跳过）；子目录递归同构 */
function DirNode({ relPath, depth }: { relPath: string; depth: number }) {
  const dir = useHubViewStore((s) => s.files.dirs[relPath]);
  const loadingDir = useHubViewStore((s) => s.files.loadingDir);
  const loadFilesDir = useHubViewStore((s) => s.loadFilesDir);
  const openFilePreview = useHubViewStore((s) => s.openFilePreview);
  const [expanded, setExpanded] = useState(depth === 0);
  const label = relPath === '.' ? '根目录' : relPath.split('/').pop() ?? relPath;

  const toggle = (): void => {
    setExpanded((v) => {
      if (!v) void loadFilesDir(relPath);
      return !v;
    });
  };

  return (
    <div className="flex flex-col" aria-label={`目录 ${label}`}>
      {depth > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? '收起目录' : '展开目录'} ${label}`}
          onClick={toggle}
          className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-surface-2"
          style={{ paddingLeft: depth * 14 + 8 }}
        >
          {expanded
            ? <ChevronDown size={13} strokeWidth={1.75} className="shrink-0 text-tertiary" aria-hidden />
            : <ChevronRight size={13} strokeWidth={1.75} className="shrink-0 text-tertiary" aria-hidden />}
          {expanded
            ? <FolderOpen size={14} strokeWidth={1.75} className="shrink-0 text-accent-600 dark:text-accent-300" aria-hidden />
            : <Folder size={14} strokeWidth={1.75} className="shrink-0 text-accent-600 dark:text-accent-300" aria-hidden />}
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-primary">{label}</span>
        </button>
      )}
      {expanded && (dir === undefined ? (
        loadingDir === relPath ? (
          <p className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-tertiary"><Spinner size={11} /> 拉取中…</p>
        ) : null
      ) : (
        <div className="flex flex-col">
          {dir.entries.map((e) =>
            e.isDirectory ? (
              <DirNode key={e.name} relPath={joinPath(relPath, e.name)} depth={depth + 1} />
            ) : (
              <button
                key={e.name}
                type="button"
                aria-label={`预览文件 ${e.name}`}
                onClick={() => void openFilePreview(joinPath(relPath, e.name))}
                className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-surface-2"
                style={{ paddingLeft: (depth + 1) * 14 + 8 }}
              >
                <FileText size={14} strokeWidth={1.75} className="shrink-0 text-tertiary" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-secondary">{e.name}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-tertiary">{formatBytes(e.size)}</span>
              </button>
            ),
          )}
          {dir.truncated && (
            <p className="px-3 py-1.5 text-[11px] text-status-warning">目录条目超过 500 条上限，已截断</p>
          )}
        </div>
      ))}
    </div>
  );
}

/** 文件预览卡：read 产物（base64 已解码文本 / 二进制占位）+ truncated 明示 */
function FilePreviewCard() {
  const preview = useHubViewStore((s) => s.files.preview);
  const closeFilePreview = useHubViewStore((s) => s.closeFilePreview);
  if (preview === null) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-subtle bg-surface-1 p-3" aria-label={`文件预览 ${preview.path}`}>
      <div className="flex min-w-0 items-center gap-2">
        <FileText size={14} strokeWidth={1.75} className="shrink-0 text-tertiary" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-primary">{preview.path}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-tertiary">{formatBytes(preview.size)}</span>
        {preview.truncated && <Badge tone="warning">已截断</Badge>}
        <Button variant="ghost" size="sm" className="h-6 w-6 shrink-0 px-0" aria-label="关闭预览" onClick={closeFilePreview}>
          <X size={13} strokeWidth={1.75} aria-hidden />
        </Button>
      </div>
      {preview.binary ? (
        <p className="text-[11.5px] text-tertiary">二进制文件——文本预览不可用（内容未传输完整语义，仅前 256KB）</p>
      ) : (
        <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-2 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-secondary">{preview.content}</pre>
      )}
      {preview.truncated && (
        <p className="text-[11px] text-status-warning">文件超过 256KB 读取上限，以上为截断内容</p>
      )}
    </div>
  );
}

function FilesTab() {
  const files = useHubViewStore((s) => s.files);
  const loadFilesDir = useHubViewStore((s) => s.loadFilesDir);
  useEffect(() => {
    void loadFilesDir('.');
  }, [loadFilesDir]);
  return (
    <div className="flex flex-col gap-2">
      {files.error !== null && (
        <p className="rounded-md bg-status-error-tint px-2.5 py-2 text-xs text-status-error" role="alert">{files.error}</p>
      )}
      <div className="flex flex-col rounded-lg border border-subtle bg-surface-1 p-1.5" aria-label="工作空间文件树">
        <DirNode relPath="." depth={0} />
        {files.loadingFile !== null && (
          <p className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-tertiary"><Spinner size={11} /> 读取 {files.loadingFile}…</p>
        )}
      </div>
      <FilePreviewCard />
    </div>
  );
}

function ReplayView() {
  const st = useHubViewStore();
  const replay = st.replay!;
  const firstSeq = replay.messages.length > 0 ? replay.messages[0]!.seq : 0;
  const nextPageFrom = Math.max(0, firstSeq - VIEW_PAGE_SIZE);
  const rangeLabel = firstSeq > 1 ? `（seq ${Math.max(1, nextPageFrom)}-${firstSeq - 1}）` : '';

  return (
    <div className="flex min-h-0 flex-1 flex-col px-5 py-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="h-7 w-7 px-0" aria-label="返回会话列表" onClick={st.leaveReplay}>
          <ChevronLeft size={14} strokeWidth={1.75} aria-hidden />
        </Button>
        {replay.live ? (
          <Badge tone="accent"><Radio size={12} strokeWidth={1.75} aria-hidden /> 实时</Badge>
        ) : (
          <Badge>{replay.liveError ?? '已断开'}</Badge>
        )}
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          disabled={!replay.live}
          onClick={() => void st.disconnectLive()}
        >
          断开订阅
        </Button>
      </div>

      <div className="flex items-center justify-center border-b border-subtle py-2">
        {replay.hasMore ? (
          <button
            type="button"
            onClick={() => void st.loadEarlier()}
            disabled={replay.loadingEarlier}
            className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-3 text-[12.5px] text-secondary disabled:opacity-55"
          >
            <ArrowUpToLine size={12} strokeWidth={1.75} aria-hidden />
            {replay.loadingEarlier ? '加载中…' : `加载更早${rangeLabel}`}
          </button>
        ) : (
          <span className="flex h-7 items-center px-3 text-[11px] text-disabled">已到最早</span>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1 py-1">
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
          <div className="flex items-center gap-2 px-1 pb-1 pt-1.5 text-[11px] text-secondary" role="status" aria-label="实时追加中">
            <span
              className="h-2 w-2 shrink-0 animate-spin rounded-full border-[1.5px] border-status-violet border-t-transparent"
              aria-hidden
            />
            实时追加中——worker 侧新事件经 hub 定向推送（尾部订阅）
          </div>
        )}
        {!replay.live && replay.liveError !== null && (
          <p className="px-1 py-1.5 text-[11px] text-status-warning" role="alert">{replay.liveError}</p>
        )}
      </div>
    </div>
  );
}
