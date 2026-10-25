// renderer/src/components/hub/MirrorWizard.tsx
//
// 「镜像工作空间」向导（momo-hub M2c T8b，spec §5.2 leader 侧）——四步 Dialog：
//   S1 选空间（红线标注摘要卡）→ S2 构建+上传（T7 构建器 + knownSecrets 复检）→
//   S3 选节点（在线可选/离线与本机禁选）→ S4 两段式执行（conflict 差异卡 →
//   两步确认覆盖 → 结果面 applied/unresolved 分列）
//
// 形态（task-8-preview 批准稿）：壳按 ui/Dialog 节律自绘（560px / canvas 底 /
// subtle 边 / 10px 圆角——内置 Dialog 头无副题与关闭位，故不复用壳），步指示器
// 复用 onboarding 已批形态（16px 数字圆：done=success 勾 / on=accent / off=描边）。
//
// 进度保真：构建与应用均为单调用无进度事件（协议未定义 mirror.progress），构建中/
// 执行中呈现为整卡进行时（终态回填真实计数），不伪造逐段打勾。
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Bot, Check, Cpu, HardDriveDownload, Info, Monitor, Package, Plug, Puzzle,
  RefreshCw, ShieldCheck, Sparkles, TriangleAlert, Users, X, CircleCheck,
} from 'lucide-react';
import { useHubMirrorStore } from '../../stores/hub-mirror.store';
import { useHubGroupStore } from '../../stores/hub-group.store';
import { useHubStore } from '../../stores/hub.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { Spinner } from '../ui/Spinner';

const STEPS = ['选空间', '构建', '选节点', '执行'] as const;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 步指示器（预览 .steps 形态） */
function StepIndicator({ current, failed }: { current: number; failed?: boolean }) {
  return (
    <div className="mb-3.5 flex items-center gap-1.5 text-[11px] text-tertiary" aria-label="向导步骤">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const done = n < current;
        const on = n === current;
        const isFail = failed && on;
        return (
          <span key={label} className="flex items-center gap-1.5 whitespace-nowrap">
            {i > 0 && <span className="text-border-strong" aria-hidden>—</span>}
            <span
              className={`flex items-center gap-1 ${
                isFail ? 'text-status-error' : done ? 'text-status-success' : on ? 'font-semibold text-accent-500' : ''
              }`}
              aria-current={on ? 'step' : undefined}
            >
              <span
                className={`inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] ${
                  isFail
                    ? 'border-status-error bg-status-error text-inverse'
                    : done
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

type HeadTone = 'accent' | 'warn' | 'ok' | 'err';

const HEAD_TONE_CLASSES: Record<HeadTone, string> = {
  accent: 'bg-surface-active text-accent-600 dark:text-accent-300',
  warn: 'bg-status-warning-tint text-status-warning',
  ok: 'bg-status-success-tint text-status-success',
  err: 'bg-status-error-tint text-status-error',
};

/** 头部图标位（30×30 / 6px 圆角——预览 .hic 形态） */
function HeadIcon({ tone, children }: { tone: HeadTone; children: ReactNode }) {
  return (
    <div className={`mt-px flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md ${HEAD_TONE_CLASSES[tone]}`}>
      {children}
    </div>
  );
}

/** 清单行（预览 .cl 形态：done 勾 / run spinner / pend 描边图标） */
function CheckRow({
  state, icon, label, count,
}: { state: 'done' | 'run' | 'pend'; icon?: ReactNode; label: ReactNode; count?: ReactNode }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md px-2.5 py-[7px] text-[12.5px] ${
        state === 'run' ? 'bg-surface-2 font-medium text-primary' : state === 'done' ? 'text-secondary' : 'text-tertiary'
      }`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {state === 'done' ? (
          <Check size={16} strokeWidth={1.75} className="text-status-success" aria-hidden />
        ) : state === 'run' ? (
          <Spinner size={14} />
        ) : (
          <span className="text-border-strong">{icon}</span>
        )}
      </span>
      <span className="min-w-0 flex-1">{label}</span>
      {count !== undefined && <span className="whitespace-nowrap text-[11px] text-tertiary">{count}</span>}
    </div>
  );
}

function SummaryCard({ rows }: { rows: ReactNode }) {
  return (
    <div className="rounded-lg border border-subtle bg-surface-1 p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <Package size={16} strokeWidth={1.75} className="text-tertiary" aria-hidden />
        <b className="text-[12.5px] font-semibold text-primary">快照内容预览</b>
        <span className="ml-auto"><Badge>只读清单</Badge></span>
      </div>
      {rows}
    </div>
  );
}

function SummaryRow({
  icon, label, value, note,
}: { icon: ReactNode; label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-subtle py-1.5 text-[12.5px] text-secondary last:border-b-0">
      <span className="text-tertiary">{icon}</span>
      {label}
      <b className="ml-auto whitespace-nowrap font-medium text-primary">
        {value}
        {note !== undefined && <span className="text-[11px] font-normal text-tertiary"> {note}</span>}
      </b>
    </div>
  );
}

function RedlineNote({ text }: { text: string }) {
  return (
    <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-tertiary">
      <ShieldCheck size={12} strokeWidth={1.75} className="mt-px shrink-0 text-status-success" aria-hidden />
      {text}
    </p>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// 向导主体
// ──────────────────────────────────────────────────────────────────────────

export function MirrorWizard() {
  const st = useHubMirrorStore();
  const groups = useHubGroupStore((s) => s.groups);

  const group = groups.find((g) => g.groupId === st.groupId) ?? null;
  const target = group?.members.find((m) => m.nodeId === st.targetNodeId) ?? null;

  // S2 入步自动发起构建（幂等：building/done/error 不重发；error 由按钮重试）
  useEffect(() => {
    const s = useHubMirrorStore.getState();
    if (s.open && s.step === 2 && s.buildStatus === 'idle' && s.workspaceId) {
      void s.startBuild();
    }
  }, [st.open, st.step, st.buildStatus, st.workspaceId]);

  // Esc 关闭（执行中禁关——与关闭按钮同一闸）
  useEffect(() => {
    if (!st.open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      if (useHubMirrorStore.getState().execStatus !== 'running') useHubMirrorStore.getState().close();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [st.open]);

  if (!st.open) return null;

  const running = st.execStatus === 'running';
  const done4 = st.execStatus === 'success';
  const failed4 = st.execStatus === 'failed';
  const conflict = st.execStatus === 'conflict';

  const headTone: HeadTone = conflict ? 'warn' : done4 ? 'ok' : failed4 ? 'err' : 'accent';
  const headIcon =
    conflict ? <TriangleAlert size={16} strokeWidth={1.75} aria-hidden />
    : done4 ? <Check size={16} strokeWidth={1.75} aria-hidden />
    : failed4 ? <X size={16} strokeWidth={1.75} aria-hidden />
    : <HardDriveDownload size={16} strokeWidth={1.75} aria-hidden />;

  let title = '镜像工作空间到节点';
  let subtitle = '把本地工作空间配置打成快照，推送到组内目标节点（leader 操作）';
  if (st.step === 4) {
    if (running) {
      title = `正在镜像到 ${target?.name ?? st.targetNodeId ?? '目标节点'}`;
      subtitle = `${st.workspaceName} · v${st.snapshot?.version} · 目标节点应用中`;
    } else if (conflict) {
      title = '目标节点已存在同名工作空间';
      subtitle = `${target?.name ?? '目标节点'} 上已有 ${st.workspaceName}，需要确认后才会覆盖`;
    } else if (done4) {
      title = '镜像完成';
      subtitle = `workspace.mirrored 事件已广播至「${st.groupName ?? '工作组'}」`;
    } else {
      title = '镜像失败';
      subtitle = `${target?.name ?? '目标节点'} · ${st.workspaceName} · v${st.snapshot?.version}`;
    }
  } else if (st.step === 2) {
    subtitle = st.buildStatus === 'done' ? '快照构建完成，已上传 hub 存档' : '正在本地构建配置快照并上传 hub 存档…';
  } else if (st.step === 3) {
    subtitle = `快照 ${st.workspaceName} · v${st.snapshot?.version} 将推送到选中的节点`;
  }

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 bg-backdrop" aria-hidden onClick={() => { if (!running) st.close(); }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="镜像工作空间向导"
        className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-2rem)] w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[10px] border border-subtle bg-canvas shadow-2xl"
      >
        <div className="px-5 pb-3 pt-4">
          <div className="flex items-start gap-2.5">
            <HeadIcon tone={headTone}>{headIcon}</HeadIcon>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-primary">{title}</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-secondary">{subtitle}</p>
            </div>
            <button
              type="button"
              aria-label="关闭向导"
              disabled={running}
              onClick={() => st.close()}
              className="ml-auto rounded p-0.5 text-tertiary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <X size={16} strokeWidth={1.75} aria-hidden />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto px-5 pb-2 text-[13px] text-secondary">
          <StepIndicator current={st.step} failed={failed4 && st.step === 4} />
          {st.step === 1 && <Step1Pick />}
          {st.step === 2 && <Step2Build />}
          {st.step === 3 && <Step3Nodes />}
          {st.step === 4 && <Step4Exec />}
        </div>
      </div>
    </>,
    document.body,
  );
}

// ── S1 ────────────────────────────────────────────────────────────────────

function Step1Pick() {
  const st = useHubMirrorStore();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const s = st.snapshot?.summary;

  return (
    <div>
      <Select
        label="工作空间"
        value={st.workspaceId ?? ''}
        onChange={(e) => {
          const ws = workspaces.find((w) => w.id === e.target.value);
          if (ws) st.selectWorkspace(ws.id, ws.name);
        }}
      >
        <option value="" disabled>选择要镜像的工作空间</option>
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
      </Select>

      <div className="mt-2.5">
        <SummaryCard
          rows={
            <>
              <SummaryRow
                icon={<Bot size={16} strokeWidth={1.75} aria-hidden />}
                label="Agent 定义"
                value={s ? `${s.members} 个` : '成员清单'}
                note={s ? `（${s.members - s.embeddedMembers} 资源引用 + ${s.embeddedMembers} 内嵌自定义）` : '（资源引用 + 内嵌自定义）'}
              />
              <SummaryRow
                icon={<Users size={16} strokeWidth={1.75} aria-hidden />}
                label="团队配置"
                value={s ? `${s.teams} 个` : 'leader 与成员关系'}
                note={s ? '（leader + 成员关系）' : undefined}
              />
              <SummaryRow
                icon={<Plug size={16} strokeWidth={1.75} aria-hidden />}
                label="MCP 服务"
                value={s ? `${s.mcp} 个` : 'stdio 引用名'}
                note={s ? '（仅 stdio 引用，不含凭证头）' : '（仅 stdio 引用，不含凭证头）'}
              />
              <SummaryRow
                icon={<Sparkles size={16} strokeWidth={1.75} aria-hidden />}
                label="Skill"
                value={s ? `${s.skills} 个` : 'slug 引用'}
                note={s ? '（slug 引用）' : undefined}
              />
              <SummaryRow
                icon={<Puzzle size={16} strokeWidth={1.75} aria-hidden />}
                label="插件启用"
                value={s ? `${s.plugins} 个` : 'hub 资源引用'}
                note={s ? '（hub 资源引用）' : undefined}
              />
              <SummaryRow
                icon={<Cpu size={16} strokeWidth={1.75} aria-hidden />}
                label="Provider 引用"
                value={s ? `${s.providers} 个` : '类型 + 型号偏好'}
                note={s ? '（类型 + 型号偏好，不含 API Key）' : '（不含 API Key）'}
              />
            </>
          }
        />
      </div>
      <RedlineNote text="快照不含 API Key、MCP 凭证与聊天历史 —— 密钥与对话永远不离开本机" />
      <div className="flex items-center justify-between border-t border-subtle pb-1 pt-3">
        <span />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => st.close()}>取消</Button>
          <Button disabled={!st.workspaceId} onClick={() => useHubMirrorStore.setState({ step: 2 })}>
            下一步
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── S2 ────────────────────────────────────────────────────────────────────

function Step2Build() {
  const st = useHubMirrorStore();
  const s = st.snapshot?.summary;

  /** 构建清单行（构建中 = pend + 总行 run；完成 = 全 done + 真实计数） */
  const rows = (rowState: 'done' | 'pend'): ReactNode => (
    <>
      <CheckRow state={rowState} label="Agent 定义与成员清单" count={rowState === 'done' && s ? `${s.members} 定义 · ${s.members - s.embeddedMembers} 引用 + ${s.embeddedMembers} 内嵌` : undefined} />
      <CheckRow state={rowState} label="团队配置" count={rowState === 'done' && s ? `${s.teams} 个` : undefined} />
      <CheckRow state={rowState} label="MCP 启用清单（仅 stdio 引用）" count={rowState === 'done' && s ? `${s.mcp} 个` : undefined} />
      <CheckRow state={rowState} label="Skill 清单（slug 引用）" count={rowState === 'done' && s ? `${s.skills} 个` : undefined} />
      <CheckRow state={rowState} label="插件启用清单（hub 引用）" count={rowState === 'done' && s ? `${s.plugins} 个` : undefined} />
      <CheckRow state={rowState} label="Provider 引用与偏好（不含 Key）" count={rowState === 'done' && s ? `${s.providers} 个` : undefined} />
      <CheckRow state={rowState} label="打包 tar.gz 并计算校验和" />
    </>
  );

  return (
    <div>
      {st.buildStatus === 'building' && (
        <div className="rounded-lg border border-subtle bg-surface-1 p-1.5">
          <CheckRow state="run" label="正在构建快照并上传 hub 存档…" />
          {rows('pend')}
        </div>
      )}
      {st.buildStatus === 'error' && (
        <div className="rounded-lg border border-status-error bg-status-error-tint p-3">
          <div className="flex items-center gap-2 text-[13px] font-medium text-status-error">
            <TriangleAlert size={16} strokeWidth={1.75} aria-hidden />
            构建失败
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-secondary">{st.buildError}</p>
        </div>
      )}
      {(st.buildStatus === 'done' || st.buildStatus === 'idle') && (
        <div className="rounded-lg border border-subtle bg-surface-1 p-1.5">{rows('done')}</div>
      )}
      {st.buildStatus === 'done' && st.snapshot && (
        <>
          {st.snapshot.excludedPlugins.length > 0 && (
            <p className="mt-2 flex items-start gap-2 rounded-md bg-status-warning-tint px-2.5 py-2 text-[11.5px] leading-relaxed text-status-warning">
              <TriangleAlert size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                {st.snapshot.excludedPlugins.length} 个本地 custom 插件没有 hub 资源引用，<b>不进入快照</b>：
                {st.snapshot.excludedPlugins.join('、')}（目标节点需自行安装）
              </span>
            </p>
          )}
          <div className="mt-2.5 flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-[9px] py-1 text-[11.5px] text-secondary">
              <Package size={12} strokeWidth={1.75} aria-hidden />版本 <b className="font-semibold text-primary">v{st.snapshot.version}</b>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-[9px] py-1 text-[11.5px] text-secondary">
              大小 <b className="font-semibold text-primary">{formatBytes(st.snapshot.sizeBytes)}</b>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-[9px] py-1 text-[11.5px] text-secondary">
              checksum <b className="font-mono text-[11px] font-semibold text-primary">sha256:{st.snapshot.checksum.slice(0, 8)}…</b>
            </span>
            <Badge tone="success"><Check size={12} strokeWidth={1.75} aria-hidden />已上传 hub 存档</Badge>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-tertiary">
            hub 按 checksum 内容寻址存档，后续可回放任意旧版本（引用旧 snapshotId 重新镜像）
          </p>
        </>
      )}
      <RedlineNote text="构建器红线：payload 不含 key / 不含 url-MCP 凭证头 / 不含聊天历史（单测锁）" />
      <div className="flex items-center justify-between border-t border-subtle pb-1 pt-3">
        <span />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => st.close()}>取消</Button>
          {st.buildStatus === 'error' ? (
            <Button onClick={() => void st.startBuild()}><RefreshCw size={12} strokeWidth={1.75} aria-hidden />重试构建</Button>
          ) : (
            <Button disabled={st.buildStatus !== 'done'} onClick={() => st.gotoPickNode()}>
              下一步 · 选节点
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── S3 ────────────────────────────────────────────────────────────────────

function Step3Nodes() {
  const st = useHubMirrorStore();
  const groups = useHubGroupStore((s) => s.groups);
  const selfNodeId = useHubStore((s) => s.status?.nodeId ?? null);
  const group = groups.find((g) => g.groupId === st.groupId);

  return (
    <div>
      <label className="mb-1 block text-xs text-secondary">
        目标节点（工作组：{group?.groupName ?? st.groupName} · {group?.members.length ?? 0} 节点）
      </label>
      <div role="radiogroup" aria-label="目标节点">
        {(group?.members ?? []).map((m) => {
          const isSelf = m.nodeId === selfNodeId;
          const selectable = m.online && !isSelf;
          const selected = st.targetNodeId === m.nodeId;
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
      <p className="mt-2.5 flex items-start gap-2 rounded-md border border-subtle bg-surface-2 px-2.5 py-2 text-[11.5px] leading-relaxed text-secondary">
        <Info size={12} strokeWidth={1.75} className="mt-0.5 shrink-0 text-accent-600 dark:text-accent-300" aria-hidden />
        <span>
          <b className="font-semibold text-primary">同步规则</b>：镜像将<b className="font-semibold text-primary">整体替换</b>目标节点上同名工作空间的配置；
          <b className="font-semibold text-primary">不包含聊天历史</b>，目标节点的会话与本地数据不受影响。同名空间已存在时将先弹出差异确认。
        </span>
      </p>
      <div className="flex items-center justify-between border-t border-subtle pb-1 pt-3">
        <span />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => st.backToBuild()}>上一步</Button>
          <Button disabled={!st.targetNodeId} onClick={() => void st.startMirror()}>开始镜像</Button>
        </div>
      </div>
    </div>
  );
}

// ── S4 ────────────────────────────────────────────────────────────────────

function Step4Exec() {
  const st = useHubMirrorStore();
  const groups = useHubGroupStore((s) => s.groups);
  const group = groups.find((g) => g.groupId === st.groupId);
  const target = group?.members.find((m) => m.nodeId === st.targetNodeId);
  const [confirmArmed, setConfirmArmed] = useState(false);

  useEffect(() => {
    if (!confirmArmed) return;
    const timer = setTimeout(() => setConfirmArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmArmed]);

  const resources = st.snapshot?.summary.resources ?? 0;
  const version = st.snapshot?.version ?? '';
  const running = st.execStatus === 'running';

  // 执行序列行（无进度事件协议——终态前整组 pend，终态按语义回填）
  const seqRows = (failedSkipped: boolean, applied: string[] | null): React.ReactNode => (
    <div className="rounded-lg border border-subtle bg-surface-1 p-1.5">
      <CheckRow
        state={applied ? 'done' : 'pend'}
        label={`快照下发 · ${target?.name ?? '目标节点'} 下载 ${st.workspaceName} v${version}`}
        count={applied ? 'sha256 ✓' : undefined}
      />
      <CheckRow
        state={applied ? 'done' : 'pend'}
        label={`补装引用资源${resources > 0 ? ` ×${resources}` : ''}`}
      />
      <CheckRow
        state={failedSkipped ? 'pend' : applied ? 'done' : 'pend'}
        label="配置落库 · 工作空间整体替换"
        count={failedSkipped ? '已跳过 · 目标保持原状' : undefined}
      />
    </div>
  );

  if (running) {
    return (
      <div>
        {seqRows(false, null)}
        <p className="mt-2 text-[11px] leading-relaxed text-tertiary">
          顺序约束：引用资源<b className="text-secondary">全部就位后</b>才落配置（先装后落）——补装失败则配置不落、目标保持原状
        </p>
        <div className="flex items-center justify-between border-t border-subtle pb-1 pt-3">
          <span className="flex items-center gap-1.5 text-[11px] text-tertiary">
            <Spinner size={12} />镜像进行中，请勿关闭窗口
          </span>
          <Button variant="ghost" disabled>关闭</Button>
        </div>
      </div>
    );
  }

  if (st.execStatus === 'conflict' && st.result && !st.result.ok && st.result.diffSummary) {
    const d = st.result.diffSummary;
    return (
      <div>
        <div className="flex items-start gap-2 rounded-lg border border-status-warning bg-status-warning-tint px-3 py-2.5">
          <TriangleAlert size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-status-warning" aria-hidden />
          <div>
            <b className="block text-[13px] text-primary">差异摘要 · 目标实况 vs 快照 v{version}</b>
            <span className="text-[11.5px] leading-relaxed text-secondary">
              确认覆盖后将整体替换目标节点上该工作空间的配置（strategy: replace）；聊天历史与本地数据不受影响。
            </span>
          </div>
        </div>
        <div className="my-2.5 flex gap-2">
          <div className="flex-1 rounded-lg bg-status-success-tint px-2 py-2.5 text-center text-status-success">
            <div className="text-xl font-bold leading-tight">+{d.added}</div>
            <div className="mt-0.5 text-[11px]">新增</div>
          </div>
          <div className="flex-1 rounded-lg bg-status-error-tint px-2 py-2.5 text-center text-status-error">
            <div className="text-xl font-bold leading-tight">−{d.removed}</div>
            <div className="mt-0.5 text-[11px]">移除</div>
          </div>
          <div className="flex-1 rounded-lg bg-status-warning-tint px-2 py-2.5 text-center text-status-warning">
            <div className="text-xl font-bold leading-tight">±{d.changed}</div>
            <div className="mt-0.5 text-[11px]">变更</div>
          </div>
        </div>
        <div className="rounded-lg border border-subtle bg-surface-1 p-1.5">
          <CheckRow
            state="done"
            label={`快照 ${st.workspaceName} · v${version}${resources > 0 ? ` · ${resources} 项引用资源` : ''}`}
          />
        </div>
        <div className="flex items-center justify-between border-t border-subtle pb-1 pt-3">
          <span />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => st.close()}>取消</Button>
            {confirmArmed ? (
              <Button variant="danger" onClick={() => void st.confirmOverride()}>
                <TriangleAlert size={12} strokeWidth={1.75} aria-hidden />再击一次 · 确认覆盖
              </Button>
            ) : (
              <Button variant="danger-outline" onClick={() => setConfirmArmed(true)}>确认覆盖</Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (st.execStatus === 'success' && st.result?.ok) {
    const r = st.result;
    const groupBy = (type: string): string[] => r.appliedResources.filter((x) => x.startsWith(`${type}/`)).map((x) => x.slice(type.length + 1));
    const agents = groupBy('agent');
    const mcps = groupBy('mcp');
    const skills = groupBy('skill');
    const plugins = groupBy('plugin');
    return (
      <div>
        <div className="flex flex-col items-center gap-2 px-0 py-1.5 pb-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-status-success-tint text-status-success">
            <CircleCheck size={22} strokeWidth={1.75} aria-hidden />
          </span>
          <h3 className="text-[15px] font-semibold text-primary">{st.workspaceName} · v{version} 已镜像到 {target?.name ?? '目标节点'}</h3>
          <p className="text-xs text-tertiary">
            目标节点配置已整体替换 · 引用资源 {r.appliedResources.length} 项{r.appliedResources.length > 0 ? '全部补装就位' : '无需补装'}
          </p>
        </div>
        {r.appliedResources.length > 0 && (
          <div className="rounded-lg border border-subtle bg-surface-1 p-3">
            <div className="mb-2 flex items-center gap-1.5">
              <Package size={16} strokeWidth={1.75} className="text-tertiary" aria-hidden />
              <b className="text-[12.5px] font-semibold text-primary">appliedResources · 补装清单</b>
              <span className="ml-auto"><Badge tone="success">{r.appliedResources.length} / {r.appliedResources.length}</Badge></span>
            </div>
            {agents.length > 0 && (
              <SummaryRow icon={<Bot size={16} strokeWidth={1.75} aria-hidden />} label={`agent 资源 ×${agents.length}`} value={agents.join(' · ')} />
            )}
            {skills.length > 0 && (
              <SummaryRow icon={<Sparkles size={16} strokeWidth={1.75} aria-hidden />} label={`skill 资源 ×${skills.length}`} value={skills.join(' · ')} />
            )}
            {mcps.length > 0 && (
              <SummaryRow icon={<Plug size={16} strokeWidth={1.75} aria-hidden />} label={`MCP 资源 ×${mcps.length}`} value={mcps.join(' · ')} />
            )}
            {plugins.length > 0 && (
              <SummaryRow icon={<Puzzle size={16} strokeWidth={1.75} aria-hidden />} label={`插件资源 ×${plugins.length}`} value={plugins.join(' · ')} />
            )}
          </div>
        )}
        {r.unresolvedRefs && r.unresolvedRefs.length > 0 && (
          <div className="mt-2.5 rounded-lg border border-subtle bg-surface-1 p-3">
            <div className="mb-2 flex items-center gap-1.5">
              <TriangleAlert size={16} strokeWidth={1.75} className="text-status-warning" aria-hidden />
              <b className="text-[12.5px] font-semibold text-primary">unresolvedRefs · 目标节点无法解析</b>
              <span className="ml-auto"><Badge tone="warning">{r.unresolvedRefs.length}</Badge></span>
            </div>
            <ul className="list-inside list-disc text-[12.5px] text-secondary">
              {r.unresolvedRefs.map((u) => <li key={u} className="font-mono text-[12px]">{u}</li>)}
            </ul>
            <p className="mt-1.5 text-[11px] text-tertiary">不阻断镜像——目标节点需自行安装或注册后重启会话生效</p>
          </div>
        )}
        <div className="mt-2.5 flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-[9px] py-1 text-[11.5px] text-secondary">
            快照 <b className="font-mono text-[11px] font-semibold text-primary">v{version} · {st.snapshot?.checksum.slice(0, 8)}</b>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-[9px] py-1 text-[11.5px] text-secondary">
            下一步 <b className="font-semibold text-primary">可委派任务到该节点</b>
          </span>
        </div>
        <div className="flex items-center justify-between border-t border-subtle pb-1 pt-3">
          <span />
          <Button onClick={() => st.close()}>完成</Button>
        </div>
      </div>
    );
  }

  // failed（含第一段失败/终态失败/超时）
  const fail = st.result && !st.result.ok ? st.result : null;
  const isNodeOffline = fail?.code === 'node_offline';
  return (
    <div>
      <div className="rounded-lg border border-status-error bg-status-error-tint p-3">
        <div className="flex items-center gap-2 text-[13px] font-medium text-status-error">
          <TriangleAlert size={16} strokeWidth={1.75} aria-hidden />
          {fail?.code === 'first_stage' ? '镜像未能发起' : isNodeOffline ? '目标节点离线，镜像中断' : '镜像失败'}
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-secondary">
          {fail?.message}
          {isNodeOffline && ' 目标节点配置保持原状。节点重新上线后可点击「重试」重新镜像——快照仍存于 hub，无需重新构建。'}
        </p>
      </div>
      {fail?.code !== 'first_stage' && seqRows(true, null)}
      <div className="flex items-center justify-between border-t border-subtle pb-1 pt-3">
        <span />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => st.close()}>取消</Button>
          <Button disabled={!st.snapshot} onClick={() => void st.retry()}>
            <RefreshCw size={12} strokeWidth={1.75} aria-hidden />重试
          </Button>
        </div>
      </div>
    </div>
  );
}
