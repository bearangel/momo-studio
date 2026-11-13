// renderer/src/components/im/HumanRequestPanel.tsx
//
// 会话请求面板（任务生命周期 v2 Task 22）：固定于 composer 上方，会话内有
// 未决人工请求时出现——四种 kind 卡（tool_gate 工具门 / question 提问 /
// manual_action 人工操作 / acceptance 验收）× 三态（未决 / 超时预警 / 多卡堆叠）。
// 绑定视觉合同：.omo/previews/2026-11-13-task-lifecycle-session.html 第 1 节
// （页尾定值清单 #1–#10 逐项落地；状态色唯一来源 Badge tone / 语义 token）。
//
// 数据面（human.store，Task 22）：挂载即 initSubscriptions + loadPending；
// human:changed / task:runChanged 推送驱动的重拉在 store 内合并。答复：
//   - tool_gate / question / manual_action → store.answer（ipc.human.answer）
//   - acceptance → ipc.task.accept / ipc.task.reject（主进程 answerHuman 对
//     acceptance 人话拒——验收不走 human.answer，Task 16 契约）
// 挂载点（MiddlePanel）：任务执行会话与普通会话都挂；只读会话（委派跟踪，
// session.readOnly T17）也挂——跟踪会话要能操作远端请求（P1 只有本地任务
// 请求，P2 扩展远端代答）。
import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  ClipboardCheck,
  Clock,
  Hand,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type {
  HumanAnswerInput,
  HumanRequestKind,
  HumanRequestRow,
  HumanTimeoutPolicy,
} from '../../ipc/types';
import { ipc } from '../../ipc/client';
import { useHumanStore } from '../../stores/human.store';
import { Badge, type BadgeTone } from '../ui/Badge';
import { Button } from '../ui/Button';
import { cn } from '../../lib/cn';

/** 超时预警线：剩余 < 5 分钟进入 warning 态（描边 + 剩余时间 pill） */
const WARN_REMAINING_MS = 5 * 60_000;
/** 剩余时间 / 等待时长刷新间隔（分钟级展示，30s 足够细） */
const TICK_MS = 30_000;

// ── kind 元数据（定值清单 #4：语义色仅图标着色，标题恒 text-primary）──────────

interface KindMeta {
  title: string;
  /** 卡头右侧与折叠行的短标签 */
  label: string;
  icon: LucideIcon;
  iconClass: string;
  badgeTone: BadgeTone;
}

const KIND_META: Record<HumanRequestKind, KindMeta> = {
  tool_gate: {
    title: '需要你的授权',
    label: '工具门',
    icon: ShieldCheck,
    iconClass: 'text-status-warning',
    badgeTone: 'warning',
  },
  question: {
    title: '需要你确认',
    label: '提问',
    icon: CircleHelp,
    iconClass: 'text-accent-500',
    badgeTone: 'accent',
  },
  manual_action: {
    title: '需要人工操作',
    label: '人工操作',
    icon: Hand,
    iconClass: 'text-status-violet',
    badgeTone: 'violet',
  },
  acceptance: {
    title: '提交验收',
    label: '验收',
    icon: ClipboardCheck,
    iconClass: 'text-status-success',
    badgeTone: 'success',
  },
};

/** 超时策略提示（超时预警态替换描述行，预览 1B） */
const TIMEOUT_POLICY_HINT: Record<HumanTimeoutPolicy, string> = {
  deny_and_wrap: '超时策略：工具门到期默认「拒绝并让 agent 收尾」，不算 failed。',
  keep_waiting: '超时策略：到期保持等待中，不会自动失败。',
  escalate: '超时策略：人工操作到期默认「转交发起人」，任务保持等待中。',
  fail: '超时策略：到期任务将标记失败。',
  cancel: '超时策略：到期请求将取消。',
};

// ── payload / options 解析（畸形 → null，卡片降级渲染）──────────────────────

interface ToolGatePayload {
  toolName: string;
  command: string;
  dirs: string[];
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseToolGate(row: HumanRequestRow): ToolGatePayload | null {
  const parsed = parseJson(row.payloadJson);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const gate = (parsed as { toolGate?: unknown }).toolGate;
  if (typeof gate !== 'object' || gate === null) return null;
  const g = gate as { toolName?: unknown; command?: unknown; dirs?: unknown };
  if (typeof g.command !== 'string' || !Array.isArray(g.dirs)) return null;
  if (g.dirs.some((d) => typeof d !== 'string')) return null;
  return {
    toolName: typeof g.toolName === 'string' ? g.toolName : 'bash',
    command: g.command,
    dirs: g.dirs,
  };
}

interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

function parseOptions(row: HumanRequestRow): QuestionOption[] | null {
  const parsed = parseJson(row.optionsJson);
  if (!Array.isArray(parsed)) return null;
  const out: QuestionOption[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as { id?: unknown; label?: unknown; description?: unknown };
    if (typeof o.id !== 'string' || typeof o.label !== 'string') continue;
    out.push({
      id: o.id,
      label: o.label,
      description: typeof o.description === 'string' ? o.description : undefined,
    });
  }
  // 空数组视为无选项（自由文本作答）
  return out.length > 0 ? out : null;
}

function parseSteps(row: HumanRequestRow): Array<{ id: string; label: string }> | null {
  const parsed = parseJson(row.payloadJson);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const ma = (parsed as { manualAction?: unknown }).manualAction;
  if (typeof ma !== 'object' || ma === null || !Array.isArray((ma as { steps?: unknown }).steps)) {
    return null;
  }
  const out: Array<{ id: string; label: string }> = [];
  for (const item of (ma as { steps: unknown[] }).steps) {
    if (typeof item !== 'object' || item === null) continue;
    const s = item as { id?: unknown; label?: unknown };
    if (typeof s.id !== 'string' || typeof s.label !== 'string') continue;
    out.push({ id: s.id, label: s.label });
  }
  return out.length > 0 ? out : null;
}

interface AcceptancePayload {
  runNo: number;
  summary: string;
  files: string[];
  artifacts: Array<{ label: string; value: string }>;
}

function parseAcceptance(row: HumanRequestRow): AcceptancePayload | null {
  const parsed = parseJson(row.payloadJson);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const acc = (parsed as { acceptance?: unknown }).acceptance;
  if (typeof acc !== 'object' || acc === null) return null;
  const a = acc as { runNo?: unknown; summary?: unknown; files?: unknown; artifacts?: unknown };
  if (typeof a.runNo !== 'number' || typeof a.summary !== 'string') return null;
  const files = Array.isArray(a.files) && a.files.every((f) => typeof f === 'string')
    ? (a.files as string[])
    : [];
  const artifacts =
    Array.isArray(a.artifacts) &&
    a.artifacts.every(
      (x) =>
        typeof x === 'object' &&
        x !== null &&
        typeof (x as { label?: unknown }).label === 'string' &&
        typeof (x as { value?: unknown }).value === 'string',
    )
      ? (a.artifacts as Array<{ label: string; value: string }>)
      : [];
  return { runNo: a.runNo, summary: a.summary, files, artifacts };
}

// ── 时间展示工具 ────────────────────────────────────────────────────────────

function elapsedMinutes(row: HumanRequestRow, now: number): number {
  return Math.max(0, Math.floor((now - row.createdAt) / 60_000));
}

function remainingMinutes(row: HumanRequestRow, now: number): number | null {
  if (row.deadlineAt === null) return null;
  return Math.max(0, Math.ceil((row.deadlineAt - now) / 60_000));
}

/** 超时预警态判定：有 deadline 且剩余 < 5 分钟（含已过期——sweeper 未扫前的诚实展示） */
function isWarn(row: HumanRequestRow, now: number): boolean {
  return row.deadlineAt !== null && row.deadlineAt - now < WARN_REMAINING_MS;
}

// ── 通用小件（定值清单逐项）─────────────────────────────────────────────────

/** 命令块（#5）：mono 11px / surface-2 / 圆角 5px / 内距 7px 9px；inline 变体 2px 5px */
function CmdBlock({ command, inline = false }: { command: string; inline?: boolean }) {
  return (
    <code
      className={
        inline
          ? 'rounded-[5px] bg-surface-2 px-[5px] py-[2px] font-mono text-[11px] text-primary'
          : 'rounded-[5px] bg-surface-2 px-[9px] py-[7px] font-mono text-[11px] leading-[1.6] text-primary'
      }
    >
      {command}
    </code>
  );
}

/** 目录/文件 chip（#6）：10px / 2px 7px / 999px / surface-3 + text-secondary */
function Chips({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-[5px]">
      {items.map((it) => (
        <span
          key={it}
          className="rounded-full bg-surface-3 px-[7px] py-[2px] text-[10px] text-secondary"
        >
          {it}
        </span>
      ))}
    </div>
  );
}

/** 面板动作钮（#7）：btn-sm 24px / 圆角 6px / 字 11.5px；variant 组合由调用方定 */
const BTN_SM = 'h-6 px-[9px] text-[11.5px]';

/** 超时剩余 pill（#8）：18px 高 / 0 7px / 圆角 4px / warning-tint + warning 11px/500 */
function RemainPill({ minutes }: { minutes: number }) {
  return (
    <span className="inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded bg-status-warning-tint px-[7px] text-[11px] font-medium text-status-warning">
      <Clock size={11} strokeWidth={1.75} aria-hidden />
      剩余 {minutes} 分钟
    </span>
  );
}

// ── 卡头（#2）───────────────────────────────────────────────────────────────

function CardHead({ row, now }: { row: HumanRequestRow; now: number }) {
  const meta = KIND_META[row.kind];
  const warn = isWarn(row, now);
  const remain = remainingMinutes(row, now);
  const Icon = meta.icon;
  return (
    <div className="flex h-9 items-center gap-[7px] border-b border-subtle bg-surface-1 px-2.5">
      <Icon size={16} strokeWidth={1.75} aria-hidden className={meta.iconClass} />
      <span className="text-[12.5px] font-semibold text-primary">{meta.title}</span>
      <span className="ml-auto flex items-center gap-[5px] whitespace-nowrap text-[11px] text-tertiary">
        {warn && remain !== null && <RemainPill minutes={remain} />}
        {warn ? meta.label : `${meta.label} · 等待 ${elapsedMinutes(row, now)} 分钟`}
      </span>
    </div>
  );
}

// ── 四种 kind 卡体（#3：内距 10px 12px / 纵向 gap 8px）──────────────────────

/** 卡内错误行：答复/验收 IPC 失败的人话反馈（错误路径必须有可见出口） */
function ErrorLine({ error }: { error: string | null }) {
  if (error === null) return null;
  return (
    <div className="border-t border-subtle bg-surface-1 px-3 py-1.5 text-[11px] text-status-error">
      {error}
    </div>
  );
}

function ToolGateBody({ row, now, onError }: {
  row: HumanRequestRow;
  now: number;
  onError: (msg: string) => void;
}) {
  const answer = useHumanStore((s) => s.answer);
  const gate = parseToolGate(row);
  const warn = isWarn(row, now);

  const submit = (input: HumanAnswerInput): void => {
    void answer(row.id, input).catch((err: unknown) => {
      onError(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      {/* 描述行（未决态）/ 超时策略行（预警态，预览 1B 互换） */}
      <div className="text-[11px] leading-4 text-tertiary">
        {warn
          ? TIMEOUT_POLICY_HINT[row.timeoutPolicy]
          : gate !== null
            ? `${gate.toolName} 工具请求写入 ${gate.dirs.length} 个目录。`
            : row.prompt}
      </div>
      {gate !== null && <CmdBlock command={`$ ${gate.command}`} />}
      {gate !== null && <Chips items={gate.dirs} />}
      {!warn && <div className="h-px bg-border-subtle" />}
      <div className="flex flex-wrap items-center gap-[7px]">
        <Button
          variant="primary"
          size="sm"
          className={BTN_SM}
          onClick={() => submit({ decision: 'approve' })}
        >
          允许本次
        </Button>
        <Button
          size="sm"
          className={cn(BTN_SM, 'border border-strong bg-surface-1 text-primary hover:bg-surface-3')}
          onClick={() =>
            // scope 约定（plan T22 brief）：approve 决策恒 approve，会话级授权
            // 用 text='scope:session' 注记区分（主进程 handleToolGateAnswer 当前
            // 对 approve 统一 grantWriteDirs('session')，注记供 P2 精细化消费）
            submit({ decision: 'approve', text: 'scope:session' })
          }
        >
          允许本会话
        </Button>
        <Button
          variant="danger-outline"
          size="sm"
          className={BTN_SM}
          onClick={() => submit({ decision: 'deny' })}
        >
          拒绝
        </Button>
      </div>
    </div>
  );
}

function QuestionBody({ row, onError }: {
  row: HumanRequestRow;
  onError: (msg: string) => void;
}) {
  const answer = useHumanStore((s) => s.answer);
  // 单选（radio）：当前后端 options 形状（Array<{id,label,description?}>）无
  // multiSelect 标记——P2 选项多选扩展点，届时按载荷标记切 checkbox 组
  const options = parseOptions(row);
  const [selected, setSelected] = useState<string | null>(options?.[0]?.id ?? null);
  const [text, setText] = useState('');
  const canSubmit = options === null || selected !== null;

  const submit = (): void => {
    void answer(row.id, {
      selected: options !== null && selected !== null ? [selected] : undefined,
      text: text.trim() !== '' ? text.trim() : undefined,
    }).catch((err: unknown) => {
      onError(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="text-xs leading-[1.7] text-primary">{row.prompt}</div>
      {options?.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => setSelected(opt.id)}
          className={cn(
            'flex items-start gap-2 rounded-[7px] border px-[9px] py-[7px] text-left text-[11.5px]',
            selected === opt.id
              ? 'border-focus bg-surface-active'
              : 'border-subtle hover:border-strong',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'mt-px h-3.5 w-3.5 shrink-0 rounded-full border',
              selected === opt.id ? 'border-4 border-accent-500' : 'border-strong',
            )}
          />
          <span>
            <span className="text-[11.5px] font-semibold text-primary">{opt.label}</span>
            {opt.description !== undefined && (
              <span className="mt-px block text-[11px] leading-4 text-tertiary">
                {opt.description}
              </span>
            )}
          </span>
        </button>
      ))}
      <div className="flex items-center gap-2">
        <input
          aria-label="补充说明（可选）"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="补充说明（可选，进入 agent 上下文）…"
          className="h-[30px] flex-1 rounded-md border border-subtle bg-surface-2 px-[9px] text-xs text-primary placeholder:text-tertiary focus:border-focus focus:outline-none"
        />
        <Button variant="primary" size="sm" className={BTN_SM} disabled={!canSubmit} onClick={submit}>
          提交
        </Button>
      </div>
    </div>
  );
}

function ManualActionBody({ row, now, onError }: {
  row: HumanRequestRow;
  now: number;
  onError: (msg: string) => void;
}) {
  const answer = useHumanStore((s) => s.answer);
  const steps = parseSteps(row);
  const warn = isWarn(row, now);
  // 步骤勾选是纯本地跟踪态（预览「本地勾选态」），不落库不进答复载荷
  const [done, setDone] = useState<Set<string>>(new Set());
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');

  const submit = (completed: boolean): void => {
    void answer(row.id, {
      completed,
      text: note.trim() !== '' ? note.trim() : undefined,
    }).catch((err: unknown) => {
      onError(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="text-xs leading-[1.7] text-primary">
        {warn ? TIMEOUT_POLICY_HINT[row.timeoutPolicy] : row.prompt}
      </div>
      {steps?.map((step) => {
        const checked = done.has(step.id);
        return (
          <button
            key={step.id}
            type="button"
            onClick={() =>
              setDone((prev) => {
                const next = new Set(prev);
                if (next.has(step.id)) next.delete(step.id);
                else next.add(step.id);
                return next;
              })
            }
            className="flex items-start gap-[7px] text-left text-[11.5px] leading-[1.6] text-primary"
          >
            <span
              aria-hidden
              className={cn(
                'mt-px flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[3px] border',
                checked ? 'border-status-success bg-status-success' : 'border-strong',
              )}
            >
              {checked && <Check size={10} strokeWidth={2.5} className="text-inverse" aria-hidden />}
            </span>
            <span>{step.label}</span>
          </button>
        );
      })}
      {!warn && <div className="h-px bg-border-subtle" />}
      {noteOpen && (
        <textarea
          aria-label="说明情况"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="说明情况（将随答复进入 agent 上下文）…"
          className="h-14 w-full resize-none rounded-md border border-subtle bg-surface-2 px-[9px] py-[7px] text-xs leading-[1.6] text-primary placeholder:text-tertiary focus:border-focus focus:outline-none"
        />
      )}
      <div className="flex flex-wrap items-center gap-[7px]">
        <Button variant="primary" size="sm" className={BTN_SM} onClick={() => submit(true)}>
          已完成，继续
        </Button>
        <Button
          size="sm"
          className={cn(BTN_SM, 'border border-strong bg-surface-1 text-primary hover:bg-surface-3')}
          onClick={() => submit(false)}
        >
          我做不到 / 转交
        </Button>
        <Button variant="ghost" size="sm" className={BTN_SM} onClick={() => setNoteOpen((v) => !v)}>
          说明情况
        </Button>
      </div>
    </div>
  );
}

function AcceptanceBody({ row, onError }: {
  row: HumanRequestRow;
  onError: (msg: string) => void;
}) {
  const loadPending = useHumanStore((s) => s.loadPending);
  const payload = parseAcceptance(row);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const canOperate = row.taskId !== null;

  /** 验收 / 打回都走 task 通道（Task 16 契约：acceptance 不走 human.answer，
   *  主进程 answerAcceptance 落 answered + human:changed 推送刷新面板） */
  const operate = (fn: () => Promise<unknown>): void => {
    setBusy(true);
    fn()
      .then(() => loadPending(row.sessionId))
      .catch((err: unknown) => {
        onError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="text-[11px] leading-[1.7] text-primary">
        交付说明：{payload?.summary ?? row.prompt}
      </div>
      {payload !== null && <Chips items={payload.files} />}
      {payload?.artifacts.map((a) => (
        <div key={a.label} className="flex items-center gap-1.5 text-[11.5px] text-secondary">
          <CircleCheck size={12} strokeWidth={1.75} aria-hidden className="text-status-success" />
          <span className="truncate">
            {a.label}
            {a.value !== '' ? `：${a.value}` : ''}
          </span>
        </div>
      ))}
      <input
        aria-label="打回理由"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="打回理由（打回时必填，空理由禁用确认）…"
        className="h-[30px] w-full rounded-md border border-subtle bg-surface-2 px-[9px] text-xs text-primary placeholder:text-tertiary focus:border-focus focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-[7px]">
        <Button
          variant="primary"
          size="sm"
          className={BTN_SM}
          disabled={!canOperate || busy}
          title={canOperate ? undefined : '请求未关联任务，无法验收'}
          onClick={() => operate(() => ipc.task.accept(row.taskId!))}
        >
          验收通过
        </Button>
        <Button
          variant="danger-outline"
          size="sm"
          className={BTN_SM}
          disabled={!canOperate || busy || reason.trim() === ''}
          title={canOperate ? undefined : '请求未关联任务，无法打回'}
          onClick={() => operate(() => ipc.task.reject(row.taskId!, reason.trim()))}
        >
          打回返工
        </Button>
        <span className="flex-1" />
        <span className="flex items-center gap-1 text-[10.5px] text-tertiary">
          打回将带理由生成新 run，任务回到 assigned
        </span>
      </div>
    </div>
  );
}

// ── 单卡（头 + 体；超时预警态边框 warning，#8）──────────────────────────────

function KindCard({ row, now }: { row: HumanRequestRow; now: number }) {
  const [error, setError] = useState<string | null>(null);
  const onError = (msg: string): void => setError(msg);

  return (
    <div data-testid={`human-card-${row.id}`} className="bg-canvas">
      <CardHead row={row} now={now} />
      {row.kind === 'tool_gate' && <ToolGateBody row={row} now={now} onError={onError} />}
      {row.kind === 'question' && <QuestionBody row={row} onError={onError} />}
      {row.kind === 'manual_action' && <ManualActionBody row={row} now={now} onError={onError} />}
      {row.kind === 'acceptance' && <AcceptanceBody row={row} onError={onError} />}
      <ErrorLine error={error} />
    </div>
  );
}

// ── 折叠行（#10）与堆叠头（#9）──────────────────────────────────────────────

function CollapsedRow({ row, now, onExpand }: {
  row: HumanRequestRow;
  now: number;
  onExpand: () => void;
}) {
  const meta = KIND_META[row.kind];
  return (
    <button
      type="button"
      data-testid={`human-collapsed-${row.id}`}
      onClick={onExpand}
      className="flex h-9 w-full items-center gap-2 border-t border-subtle bg-surface-1 px-2.5 text-xs text-secondary hover:bg-surface-2"
    >
      <Badge tone={meta.badgeTone}>{meta.label}</Badge>
      <span className="min-w-0 flex-1 truncate text-left">{row.title}</span>
      <span className="whitespace-nowrap text-[11px] text-tertiary">
        等待 {elapsedMinutes(row, now)} 分钟
      </span>
      <ChevronRight size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-tertiary" />
    </button>
  );
}

function StackHead({ rows, now }: { rows: HumanRequestRow[]; now: number }) {
  // 最早超时预警时刻：有 deadline 的行里最近的剩余分钟（无 deadline 行不参与）
  const earliest = rows.reduce<number | null>((min, r) => {
    if (r.deadlineAt === null) return min;
    const remain = Math.max(0, Math.ceil((r.deadlineAt - now) / 60_000));
    return min === null ? remain : Math.min(min, remain);
  }, null);
  return (
    <div
      data-testid="human-stack-head"
      className="flex h-8 items-center gap-1.5 bg-status-warning-tint px-2.5 text-xs font-semibold text-status-warning"
    >
      <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
      等待中 {rows.length} 项
      {earliest !== null && (
        <span className="ml-auto text-[11px] font-normal">最早 {earliest} 分钟后超时预警</span>
      )}
    </div>
  );
}

// ── 面板主体 ────────────────────────────────────────────────────────────────

export function HumanRequestPanel({ sessionId }: { sessionId: string }) {
  const rows = useHumanStore((s) => s.pendingBySession.get(sessionId));
  const loadPending = useHumanStore((s) => s.loadPending);
  const initSubscriptions = useHumanStore((s) => s.initSubscriptions);
  const [now, setNow] = useState(() => Date.now());
  // 展开卡 id：默认首卡（预览 1C）；答完/刷新后 expandedId 不在列表时回落首卡
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // 订阅只装一次（幂等）；会话切换重拉 pending
  useEffect(() => {
    initSubscriptions();
  }, [initSubscriptions]);
  useEffect(() => {
    void loadPending(sessionId);
  }, [sessionId, loadPending]);

  // 剩余时间 / 等待时长的分钟级刷新
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // rows 未到位（会话未跟踪）→ 空数组；useMemo 稳定引用，防 expanded 重算抖动
  const pending = useMemo(() => rows ?? [], [rows]);
  const expanded = useMemo(() => {
    const found = pending.find((r) => r.id === expandedId);
    return found ?? pending[0] ?? null;
  }, [pending, expandedId]);

  if (pending.length === 0) return null;
  const rest = pending.filter((r) => r.id !== expanded?.id);

  return (
    <div
      data-testid="human-request-panel"
      className="border-t border-subtle bg-surface-1 px-3 pt-3"
    >
      <div
        className={cn(
          'overflow-hidden rounded-lg border bg-canvas shadow-[0_4px_16px_rgba(0,0,0,0.10)]',
          expanded !== null && isWarn(expanded, now) ? 'border-status-warning' : 'border-strong',
        )}
      >
        {pending.length >= 2 && <StackHead rows={pending} now={now} />}
        {expanded !== null && <KindCard row={expanded} now={now} />}
        {rest.map((r) => (
          <CollapsedRow key={r.id} row={r} now={now} onExpand={() => setExpandedId(r.id)} />
        ))}
      </div>
    </div>
  );
}
