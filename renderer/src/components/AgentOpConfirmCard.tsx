// renderer/src/components/AgentOpConfirmCard.tsx
//
// 扩权确认卡（spec 2026-11-12 §7，Tier A 阻断确认）：主进程 required 档
// resource op 广播 agent-op-confirm:request → store 单卡 → 本卡居中渲染。
// 挂载点 App 层 CenterPromptLayer（锚点 0×0 无 transform 定位点，本卡自带
// -translate-x/y-1/2 居中——见 CenterPromptLayer.tsx 头注）。
// 遮罩消费 ui/Dialog 导出的 OVERLAY_CLASS（单一真相源——关系锁见测试）；点击
// 遮罩/Esc 均不消散——裁决必须显式（拒绝/允许/10 分钟超时主进程侧拒绝）。
// 定值清单（P1 预览合同，.omo/previews/agent-op-confirm-card.html）：
// 卡宽 440 / 圆角 8 卡 · 6 diff框按钮 / 内边距 16 卡 · 10 12 diff框 /
// 字号 14 标题 · 13 正文按钮 · 12 辅助 · 11 大写标签 / 徽标 surface-active 底 +
// accent-600（暗色 accent-300）/ riskNote warning-tint 底 + warning 字 + 35% 边框。
import { useEffect, useRef } from 'react';
import { Check, Monitor, ShieldCheck, TriangleAlert, User } from 'lucide-react';
import { useAgentOpConfirmStore } from '../stores/agent-op-confirm.store';
import type { AgentOpConfirmPayload } from '../ipc/types';
import { Button } from './ui/Button';
import { OVERLAY_CLASS } from './ui/Dialog';

const FIELD_LABELS: Record<AgentOpConfirmPayload['diff']['adds'][number]['field'], string> = {
  skills: '技能',
  mcps: 'MCP',
  tools: '工具',
  pluginTools: '插件工具',
};

const PROFILE_FIELD_LABELS: Record<string, string> = {
  name: '名称',
  description: '描述',
  systemPrompt: '系统提示词',
  iconEmoji: '图标',
  deniedTools: '禁用工具',
  model: '模型',
  skillMd: '技能内容',
  transport: '传输方式',
};

function cardTitle(p: AgentOpConfirmPayload): string {
  const who = p.requester.agentName;
  if (p.requester.op === 'updateProfile') return `${who} 请求编辑智能体档案`;
  if (p.diff.target.kind === 'skill') return `${who} 请求更新技能`;
  if (p.diff.target.kind === 'mcp') return `${who} 请求更新 MCP`;
  return `${who} 请求变更智能体能力`;
}

function targetLine(p: AgentOpConfirmPayload): string {
  const t = p.diff.target;
  if (t.kind === 'member') {
    const ws = t.workspaceName ?? '当前工作空间';
    const scopeSuffix =
      p.diff.scope === 'definition' ? '（definition 级，全部工作空间生效）' : '（member 级，仅此实例）';
    return `目标：成员「${t.name}」 @ ${ws}${scopeSuffix}`;
  }
  if (t.kind === 'definition') return `目标：定义「${t.name}」（definition 级，全部工作空间生效）`;
  if (t.kind === 'skill') return `目标：技能「${t.name}」`;
  return `目标：MCP「${t.name}」`;
}

function DiffRow({ sign, field, refName }: { sign: '+' | '−'; field: string; refName: string }) {
  return (
    <div className="flex items-center gap-2 py-[3px] text-[13px] text-primary tabular-nums">
      <span
        className={`w-3 flex-none text-center font-bold ${sign === '+' ? 'text-status-success' : 'text-status-error'}`}
      >
        {sign}
      </span>
      <span className="min-w-14 text-xs text-secondary">{field}</span>
      <span className="break-all">{refName}</span>
    </div>
  );
}

export function AgentOpConfirmCard() {
  const pending = useAgentOpConfirmStore((s) => s.pending);
  const reply = useAgentOpConfirmStore((s) => s.reply);
  const cardRef = useRef<HTMLDivElement>(null);

  // TTL 清扫（write-grant F3 同款）：pending 存续期间每秒对表 expiresAt
  const visible = pending !== null;
  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => useAgentOpConfirmStore.getState().dismissExpired(), 1000);
    return () => clearInterval(t);
  }, [visible]);

  // a11y（F3 T12④）：卡挂载即把焦点移入卡内（容器 tabIndex=-1 可编程聚焦，
  // Dialog 同款范式）；不做完整 focus trap，关闭后焦点还原由调用侧自然处理
  useEffect(() => {
    if (visible) cardRef.current?.focus();
  }, [visible]);

  if (!pending) return null;

  const { diff } = pending;
  const hasDeltaRows = diff.adds.length > 0 || diff.removes.length > 0;
  const hasFieldChanges = (diff.fieldChanges?.length ?? 0) > 0;
  const metaParts: string[] = [];
  if (diff.target.kind === 'member') metaParts.push('确认后自动重启该成员（在途回合结束后生效）');
  // 请求短码（D1 复盘 2026-11-13）：被拒不重试是模型纪律非硬约束——agent 连发
  // 相同请求时新卡会覆盖式顶上，与旧卡视觉完全同质，用户无法感知「这是新请求」。
  // 短码让连续请求可区分（法证日志场景：QA mock 循环 tool_call 顶卡被误读为卡不关）
  metaParts.push(`请求 #${pending.requestId.slice(0, 8)}`);
  metaParts.push('10 分钟内未处置将自动拒绝');

  return (
    <>
      {/* 遮罩：与 ui/Dialog 同款（OVERLAY_CLASS 单一真相源）；点击不消散——裁决必须显式 */}
      <div data-testid="agent-op-confirm-overlay" className={OVERLAY_CLASS} aria-hidden />
      <div
        ref={cardRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={cardTitle(pending)}
        tabIndex={-1}
        data-testid="agent-op-confirm-card"
        className="pointer-events-auto absolute left-0 top-0 z-50 w-[440px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-subtle bg-canvas p-4 shadow-2xl outline-none"
      >
        <div className="mb-0.5 flex items-center gap-2">
          <User
            size={16}
            strokeWidth={1.75}
            className="flex-none text-accent-600 dark:text-accent-300"
            aria-hidden
          />
          <div className="flex-1 text-sm font-semibold text-primary">{cardTitle(pending)}</div>
          <span className="inline-flex items-center gap-1 rounded bg-surface-active px-2 py-0.5 text-[11px] text-accent-600 dark:text-accent-300">
            <ShieldCheck size={11} strokeWidth={1.75} aria-hidden />需确认
          </span>
        </div>
        <div className="mt-1.5 mb-3 flex items-center gap-1.5 text-xs text-secondary">
          <Monitor size={13} strokeWidth={1.75} className="flex-none" aria-hidden />
          <span>{targetLine(pending)}</span>
        </div>
        {hasDeltaRows && (
          <div className="mb-2.5 rounded-md border border-subtle bg-surface-1 px-3 py-2.5">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-tertiary">
              变更内容
            </div>
            {diff.adds.map((e) => (
              <DiffRow key={`add-${e.field}-${e.ref}`} sign="+" field={FIELD_LABELS[e.field]} refName={e.ref} />
            ))}
            {diff.removes.map((e) => (
              <DiffRow key={`rm-${e.field}-${e.ref}`} sign="−" field={FIELD_LABELS[e.field]} refName={e.ref} />
            ))}
          </div>
        )}
        {hasFieldChanges && (
          <div className="mb-2.5 rounded-md border border-subtle bg-surface-1 px-3 py-2.5">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-tertiary">
              字段变更
            </div>
            {diff.fieldChanges?.map((fc) => (
              <div key={fc.field} className="grid grid-cols-[72px_1fr] items-baseline gap-2 py-[3px] text-[13px]">
                <span className="text-xs text-secondary">{PROFILE_FIELD_LABELS[fc.field] ?? fc.field}</span>
                <span className="break-all text-primary">
                  {fc.before != null && (
                    <span className="text-tertiary line-through decoration-disabled">{fc.before}</span>
                  )}
                  {fc.before != null && fc.after != null && <span className="px-1 text-xs text-tertiary">→</span>}
                  {fc.after}
                </span>
              </div>
            ))}
          </div>
        )}
        {pending.riskNote != null && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-status-warning/35 bg-status-warning-tint px-2.5 py-2">
            <TriangleAlert size={16} strokeWidth={1.75} className="mt-px flex-none text-status-warning" aria-hidden />
            <span className="text-xs font-medium text-status-warning">{pending.riskNote}</span>
          </div>
        )}
        <div className="mt-0.5 mb-3 text-[11px] text-tertiary">{metaParts.join(' · ')}</div>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            className="border border-subtle bg-surface-2 px-4 py-1.5 text-primary"
            onClick={() => void reply(false)}
          >
            拒绝
          </Button>
          <Button variant="primary" className="px-4 py-1.5" onClick={() => void reply(true)}>
            <Check size={13} strokeWidth={1.75} aria-hidden />允许
          </Button>
        </div>
      </div>
    </>
  );
}
