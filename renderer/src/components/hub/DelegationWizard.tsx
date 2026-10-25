// renderer/src/components/hub/DelegationWizard.tsx
//
// 「新建委派」向导（momo-hub M2e T12，spec §5.3 leader 侧，task-12-preview 批准稿）——
// 三步 Dialog：S1 选目标节点/工作空间/agent（RM2-8：agentSlug 文本输入退化——跨节点
// 成员查询属 T14 view.* 域，不为此抢跑）→ S2 任务书（标题≤60 + prompt≤4000 计数）→
// S3 摘要确认 → 受理态（taskId + 待执行徽标；受理即终态，进度在委派面板列表消费）。
//
// 形态：与 T8 镜像向导同一套 Dialog 定值（560px / canvas 底 / subtle 边 / 10px 圆角 /
// 16px 数字圆步进 / radio 节点行 / h30 按钮），零新造型语言。
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Bot, Check, CircleCheck, FileText, Info, Layers, Monitor, Send,
  ShieldCheck, X,
} from 'lucide-react';
import { useHubDelegationStore } from '../../stores/hub-delegation.store';
import { useHubGroupStore } from '../../stores/hub-group.store';
import { useHubStore } from '../../stores/hub.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useAgentStore } from '../../stores/agent.store';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Spinner } from '../ui/Spinner';

const STEPS = ['选节点', '任务书', '确认'] as const;
const TITLE_MAX = 60;
const PROMPT_MAX = 4000;

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="mb-3.5 flex items-center gap-1.5 text-[11px] text-tertiary" aria-label="向导步骤">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const done = n < current;
        const on = n === current;
        return (
          <span key={label} className="flex items-center gap-1.5 whitespace-nowrap">
            {i > 0 && <span className="text-border-strong" aria-hidden>—</span>}
            <span
              className={`flex items-center gap-1 ${done ? 'text-status-success' : on ? 'font-semibold text-accent-500' : ''}`}
              aria-current={on ? 'step' : undefined}
            >
              <span
                className={`inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] ${
                  done
                    ? 'border-status-success bg-status-success text-inverse'
                    : on
                      ? 'border-accent-500 bg-accent-500 text-inverse'
                      : 'border-border-strong'
                }`}
                aria-hidden
              >
                {done ? <Check size={10} strokeWidth={2} /> : n}
              </span>
              {label}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** 字符计数（≥90% 变 warning、超限 error——S2 两字段共用） */
function CharCount({ value, max }: { value: string; max: number }) {
  const ratio = value.length / max;
  const over = value.length > max;
  const near = ratio >= 0.9 && !over;
  return (
    <div className={`mt-[3px] text-right text-[11px] ${over ? 'text-status-error' : near ? 'text-status-warning' : 'text-tertiary'}`}>
      {value.length} / {max}
    </div>
  );
}

export function DelegationWizard() {
  const st = useHubDelegationStore();
  const groups = useHubGroupStore((s) => s.groups);

  const group = groups.find((g) => g.groupId === st.wizardGroupId) ?? null;
  const target = group?.members.find((m) => m.nodeId === st.wizardTargetNodeId) ?? null;

  // S1 数据源兜底拉取：工作空间本地清单（镜像后目标同名存在）+ agent 定义（slug 提示）
  useEffect(() => {
    if (st.wizardOpen) {
      if (useWorkspaceStore.getState().workspaces.length === 0) void useWorkspaceStore.getState().load();
      if (useAgentStore.getState().definitions.length === 0) void useAgentStore.getState().loadDefinitions();
    }
  }, [st.wizardOpen]);

  // Esc 关闭（发送在途禁关——与关闭按钮同一闸）
  useEffect(() => {
    if (!st.wizardOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      if (!useHubDelegationStore.getState().wizardSubmitting) useHubDelegationStore.getState().closeWizard();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [st.wizardOpen]);

  if (!st.wizardOpen) return null;

  const accepted = st.wizardAcceptedTaskId !== null;
  const title = accepted ? '委派已发出' : '委派任务到节点';
  const subtitle = accepted
    ? 'hub 账本已落档，目标节点在线即开跑'
    : st.wizardStep >= 2 && target
      ? `目标：${target.name}${st.wizardWorkspaceName ? ` · ${st.wizardWorkspaceName}` : ''}${st.wizardAgentSlug.trim() !== '' ? ` · ${st.wizardAgentSlug.trim()}` : ''}`
      : '把任务书派给组内目标节点，在其工作空间以独立委派会话执行（leader 操作）';

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 bg-backdrop" aria-hidden onClick={() => st.closeWizard()} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="新建委派向导"
        className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-2rem)] w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[10px] border border-subtle bg-canvas shadow-2xl"
      >
        <div className="px-5 pb-3 pt-4">
          <div className="flex items-start gap-2.5">
            <div
              className={`mt-px flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md ${
                accepted ? 'bg-status-success-tint text-status-success' : 'bg-surface-active text-accent-600 dark:text-accent-300'
              }`}
            >
              {accepted ? <CircleCheck size={16} strokeWidth={1.75} aria-hidden /> : <Send size={16} strokeWidth={1.75} aria-hidden />}
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-primary">{title}</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-secondary">{subtitle}</p>
            </div>
            <button
              type="button"
              aria-label="关闭向导"
              disabled={st.wizardSubmitting}
              onClick={() => st.closeWizard()}
              className="ml-auto rounded p-0.5 text-tertiary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <X size={16} strokeWidth={1.75} aria-hidden />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto px-5 pb-2 text-[13px] text-secondary">
          <StepIndicator current={accepted ? 4 : st.wizardStep} />
          {!accepted && st.wizardStep === 1 && <Step1Pick />}
          {!accepted && st.wizardStep === 2 && <Step2Brief />}
          {!accepted && st.wizardStep === 3 && <Step3Confirm />}
          {accepted && <AcceptedView />}
        </div>
      </div>
    </>,
    document.body,
  );
}

// ── S1：选目标节点 / 工作空间 / agent（RM2-8 文本退化） ────────────────────

function Step1Pick() {
  const st = useHubDelegationStore();
  const groups = useHubGroupStore((s) => s.groups);
  const selfNodeId = useHubStore((s) => s.status?.nodeId ?? null);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const definitions = useAgentStore((s) => s.definitions);
  const members = useAgentStore((s) => s.members);
  const loadMembers = useAgentStore((s) => s.loadMembers);

  const group = groups.find((g) => g.groupId === st.wizardGroupId);
  // 预填工作空间按名回挂 id（openWizard 只知名；列表在位后解析一次）
  useEffect(() => {
    if (st.wizardWorkspaceName && !st.wizardWorkspaceId) {
      const hit = workspaces.find((w) => w.name === st.wizardWorkspaceName);
      if (hit) st.selectWorkspace(hit.id, hit.name);
    }
  });

  // 工作空间选定 → 拉本地成员（slug 候选提示用；目标节点同镜像空间成员一致）
  useEffect(() => {
    if (st.wizardWorkspaceId) void loadMembers(st.wizardWorkspaceId);
  }, [st.wizardWorkspaceId, loadMembers]);

  const memberSlugs = members
    .map((m) => definitions.find((d) => d.id === m.agentDefinitionId)?.slug)
    .filter((s): s is string => s !== undefined);

  return (
    <div>
      <label className="mb-1 block text-xs text-secondary">
        目标节点（工作组：{group?.groupName ?? st.wizardGroupName} · {group?.members.length ?? 0} 节点）
      </label>
      <div role="radiogroup" aria-label="目标节点">
        {(group?.members ?? []).map((m) => {
          const isSelf = m.nodeId === selfNodeId;
          const selectable = m.online && !isSelf;
          const selected = st.wizardTargetNodeId === m.nodeId;
          return (
            <button
              key={m.nodeId}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!selectable}
              onClick={() => st.selectTarget(m.nodeId)}
              className={`mb-2 flex w-full items-center gap-2.5 rounded-lg border px-3 py-[9px] text-left text-secondary ${
                selected
                  ? 'border-accent-500 bg-surface-active'
                  : isSelf
                    ? 'border-dashed border-subtle bg-surface-1 opacity-55'
                    : m.online
                      ? 'border-subtle bg-surface-1'
                      : 'border-subtle bg-surface-1 opacity-55'
              } ${selectable ? 'cursor-pointer' : 'cursor-not-allowed'}`}
            >
              <span
                className={`h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px] ${
                  selected ? 'border-accent-500 shadow-[inset_0_0_0_3px_rgb(var(--accent-500))]' : 'border-border-strong'
                }`}
                aria-hidden
              />
              <Monitor size={16} strokeWidth={1.75} className={m.online ? 'text-secondary' : 'text-tertiary'} aria-hidden />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-primary">{m.name}</span>
                <span className="block text-[11px] text-tertiary">
                  {m.nodeId.slice(0, 10)} · {isSelf ? 'leader 节点' : '本组'}
                </span>
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                {m.online && !isSelf && (
                  <>
                    <span className="h-2 w-2 rounded-full bg-status-success" aria-hidden />
                    <Badge tone="success">在线</Badge>
                  </>
                )}
                {!m.online && <Badge>离线 · 禁选</Badge>}
                {isSelf && <Badge tone="accent">本机 · leader</Badge>}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-2.5">
        <label className="mb-1 block text-xs text-secondary">工作空间（目标节点上的工作空间）</label>
        <select
          aria-label="工作空间"
          disabled={!st.wizardTargetNodeId}
          value={st.wizardWorkspaceId ?? ''}
          onChange={(e) => {
            const ws = workspaces.find((w) => w.id === e.target.value);
            if (ws) st.selectWorkspace(ws.id, ws.name);
          }}
          className={`h-8 w-full rounded-md border border-subtle bg-surface-2 px-2.5 text-[13px] text-primary focus:border-accent-500 focus:outline-none disabled:opacity-55 ${
            !st.wizardTargetNodeId ? 'text-tertiary' : ''
          }`}
        >
          <option value="" disabled>
            {st.wizardTargetNodeId ? '选择要委派到的工作空间' : '先选目标节点，再选择工作空间'}
          </option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
        <p className="mt-1 text-[11px] leading-relaxed text-tertiary">
          列表取本机工作空间清单（经镜像推送到目标节点后同名存在）；委派会话建在该空间内，不侵入其既有会话
        </p>
      </div>

      <div className="mt-2.5">
        <Input
          label="执行 agent · 可选"
          className="w-full"
          value={st.wizardAgentSlug}
          onChange={(e) => st.setWizardAgentSlug(e.target.value)}
          placeholder={st.wizardWorkspaceId ? '不指定 = 用该空间默认 agent' : '先选节点与工作空间，再填 agent slug'}
          disabled={!st.wizardWorkspaceId}
        />
        <p className="mt-1 text-[11px] leading-relaxed text-tertiary">
          {st.wizardWorkspaceId && memberSlugs.length > 0
            ? `候选 slug（${st.wizardWorkspaceName} 成员）：${memberSlugs.join(' / ')}`
            : '按 agent slug 指定执行成员（跨节点候选清单属远程查看域，后续版本提供下拉）'}
        </p>
      </div>

      <p className="mt-2.5 flex items-start gap-2 rounded-md border border-subtle bg-surface-2 px-2.5 py-2 text-[11.5px] leading-relaxed text-secondary">
        <Info size={12} strokeWidth={1.75} className="mt-0.5 shrink-0 text-accent-600 dark:text-accent-300" aria-hidden />
        <span>
          <b className="font-semibold text-primary">执行语义</b>：目标节点收到任务后建<b className="font-semibold text-primary">独立委派会话</b>（会话名 = 任务书标题摘要），进度经 hub 定向回传本面板——受子节点「委派开关 + 并发上限」约束，拒绝时回执 declined（失败态可见原因）。
        </span>
      </p>

      <div className="flex items-center justify-between border-t border-subtle pb-1 pt-3">
        <span />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => st.closeWizard()}>取消</Button>
          <Button disabled={!st.wizardTargetNodeId || !st.wizardWorkspaceId} onClick={() => st.gotoWizardStep2()}>
            下一步 · 写任务书
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── S2：任务书 ────────────────────────────────────────────────────────────

function Step2Brief() {
  const st = useHubDelegationStore();
  const titleOver = st.wizardTitle.length > TITLE_MAX;
  const promptOver = st.wizardPrompt.length > PROMPT_MAX;
  const valid = st.wizardTitle.trim() !== '' && st.wizardPrompt.trim() !== '' && !titleOver && !promptOver;

  return (
    <div>
      <div>
        <Input
          label="任务标题"
          className="w-full"
          value={st.wizardTitle}
          onChange={(e) => st.setWizardTitle(e.target.value)}
          placeholder="一句话概括（将作为目标节点的委派会话名）"
        />
        <CharCount value={st.wizardTitle} max={TITLE_MAX} />
      </div>
      <div className="mt-2.5">
        <label className="mb-1 block text-xs text-secondary">任务书（自然语言）</label>
        <textarea
          aria-label="任务书"
          value={st.wizardPrompt}
          onChange={(e) => st.setWizardPrompt(e.target.value)}
          placeholder="用自然语言描述要目标节点完成的工作：目标、涉及目录 / 仓库、验收标准、需要汇报的内容……"
          className="min-h-[112px] w-full rounded-md border border-subtle bg-surface-2 px-2.5 py-2 text-[13px] leading-[1.7] text-primary focus:border-accent-500 focus:outline-none"
        />
        <CharCount value={st.wizardPrompt} max={PROMPT_MAX} />
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-[11px] leading-relaxed text-tertiary">
        <ShieldCheck size={12} strokeWidth={1.75} className="shrink-0 text-status-success" aria-hidden />
        任务书经 hub 中转落档——审计链记录谁在何时对谁委派；密钥与本地会话内容不随任务书离开本机
      </p>
      <div className="flex items-center justify-between border-t border-subtle pb-1 pt-3">
        <span />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => st.backWizardStep1()}>上一步</Button>
          <Button disabled={!valid} onClick={() => useHubDelegationStore.setState({ wizardStep: 3 })}>
            下一步 · 确认
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── S3：摘要确认 → 发出 ───────────────────────────────────────────────────

function Step3Confirm() {
  const st = useHubDelegationStore();
  const groups = useHubGroupStore((s) => s.groups);
  const group = groups.find((g) => g.groupId === st.wizardGroupId);
  const target = group?.members.find((m) => m.nodeId === st.wizardTargetNodeId);
  const slug = st.wizardAgentSlug.trim();

  return (
    <div>
      <div className="rounded-lg border border-subtle bg-surface-1 p-3">
        <div className="mb-2 flex items-center gap-1.5">
          <FileText size={16} strokeWidth={1.75} className="text-tertiary" aria-hidden />
          <b className="text-[12.5px] font-semibold text-primary">委派摘要</b>
          <span className="ml-auto"><Badge>task.delegate</Badge></span>
        </div>
        <div className="flex items-center gap-2 border-b border-subtle py-1.5 text-[12.5px] text-secondary">
          <Monitor size={16} strokeWidth={1.75} className="text-tertiary" aria-hidden />
          目标节点
          <b className="ml-auto font-medium text-primary">
            {target?.name ?? st.wizardTargetNodeId ?? '—'} <span className="text-[11px] font-normal text-tertiary">· 在线</span>
          </b>
        </div>
        <div className="flex items-center gap-2 border-b border-subtle py-1.5 text-[12.5px] text-secondary">
          <Layers size={16} strokeWidth={1.75} className="text-tertiary" aria-hidden />
          工作空间
          <b className="ml-auto font-medium text-primary">{st.wizardWorkspaceName ?? '—'}</b>
        </div>
        <div className="flex items-center gap-2 border-b border-subtle py-1.5 text-[12.5px] text-secondary">
          <Bot size={16} strokeWidth={1.75} className="text-tertiary" aria-hidden />
          执行 agent
          <b className="ml-auto font-medium text-primary">{slug !== '' ? slug : '默认 agent'}</b>
        </div>
        <div className="flex items-center gap-2 border-b border-subtle py-1.5 text-[12.5px] text-secondary">
          <FileText size={16} strokeWidth={1.75} className="text-tertiary" aria-hidden />
          任务标题
          <b className="ml-auto max-w-[300px] truncate font-medium text-primary">{st.wizardTitle}</b>
        </div>
        <div className="mt-2 line-clamp-2 rounded-md bg-surface-2 px-2.5 py-2 text-[11.5px] leading-relaxed text-tertiary">
          {st.wizardPrompt}
        </div>
      </div>

      {st.wizardSubmitError !== null && (
        <p className="mt-2 flex items-start gap-1.5 rounded-md border border-status-error bg-status-error-tint px-2.5 py-2 text-xs leading-relaxed text-status-error" role="alert">
          {st.wizardSubmitError}
        </p>
      )}

      <div className="flex items-center justify-between border-t border-subtle pb-1 pt-3">
        <span className="flex items-center gap-1.5 text-[11px] text-tertiary">
          {st.wizardSubmitting && <Spinner size={12} />}
          {st.wizardSubmitting ? '正在发出委派…' : ''}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" disabled={st.wizardSubmitting} onClick={() => useHubDelegationStore.setState({ wizardStep: 2 })}>
            上一步
          </Button>
          <Button disabled={st.wizardSubmitting} onClick={() => void st.submitWizard()}>
            <Send size={12} strokeWidth={1.75} aria-hidden />
            {st.wizardSubmitting ? '发送中…' : '发出委派'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── 受理态 ────────────────────────────────────────────────────────────────

function AcceptedView() {
  const st = useHubDelegationStore();
  const groups = useHubGroupStore((s) => s.groups);
  const group = groups.find((g) => g.groupId === st.wizardGroupId);
  const target = group?.members.find((m) => m.nodeId === st.wizardTargetNodeId);
  const taskId = st.wizardAcceptedTaskId ?? '';

  return (
    <div>
      <div className="flex flex-col items-center gap-2 px-0 py-1.5 pb-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-status-success-tint text-status-success">
          <CircleCheck size={22} strokeWidth={1.75} aria-hidden />
        </span>
        <h3 className="text-[15px] font-semibold text-primary">已受理 · 等待目标节点开跑</h3>
        <p className="text-center text-xs leading-relaxed text-tertiary">
          {target?.name ?? '目标节点'} 收到任务后自动建独立委派会话执行；<br />
          进度与结果在「工作组面板 → 委派任务」区段实时展示，本向导可安全关闭
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-[9px] py-1 text-[11.5px] text-secondary">
          taskId <b className="font-mono text-[11px] font-semibold text-primary">{taskId.slice(0, 13)}</b>
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-[9px] py-1 text-[11.5px] text-secondary">
          状态 <Badge tone="warning">待执行</Badge>
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-[9px] py-1 text-[11.5px] text-secondary">
          节点 <b className="font-semibold text-primary">{target?.name ?? '—'}</b>
        </span>
      </div>
      <div className="flex items-center justify-between border-t border-subtle pb-1 pt-3">
        <span />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => st.closeWizard()}>稍后</Button>
          <Button onClick={() => st.viewAccepted()}>查看任务进度</Button>
        </div>
      </div>
    </div>
  );
}
