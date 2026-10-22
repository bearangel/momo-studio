// renderer/src/components/agent/MembersPanel.tsx
// AgentsView Tab 1「智能体成员」（spec §6.1）：当前 workspace 的 agent 成员列表，
// 拆自 WorkspaceAgentsPanel（v25 去编排退役）。成员行 = icon emoji + 名称 + 模型 +
// Star 默认会话标记 + 在线状态 + 行内操作（启动/停止、设为默认会话、编辑、
// 移出工作空间）。移出被 leader 守卫拦截时 alert blockedTeams 团队名。
// 「编辑」→ MemberEditDialog（API key + 能力覆盖统一弹窗；关闭时刷新成员列表，
// 因 setMemberDeltas 不像 updateMemberApiKey 那样内部刷新）。
// 「+ 新建智能体」→ AgentCreateWizard（source='agentView'，创建成功自动加入当前 ws；
// 2026-10-12 表单统一——原 CreateAgentDialog 已删除，向导是唯一创建表单）。
// 「+ 添加智能体」→ AddAgentDialog（Bug 3：移出后可重新加入）。
// v2.1 P3：token 全量语义化；🤖/⭐/▶/⏸ → Bot/Star/Play/Pause lucide（iconEmoji 用户数据豁免）。
// 2026-10-22 卡片化流式布局（P1 预览 .omo/previews/agent-members-cards.html 已批准）：
//   行列表 → grid auto-fill(minmax 240px) 卡片网格；卡片直出 def.description
//   （2 行截断 + 整卡 title 全文，空说明 →「暂无说明」占位）。
//   定值合同：卡片 surface-1 底 / rounded-lg / p-3 / hover surface-2+border-strong；
//   说明 12px / 1.55 / min-h 37px；状态徽标 11px 胶囊；操作行 hover 浮现（语义与集合不变）。
import { useEffect, useMemo, useState } from 'react';
import { Bot, Pause, Play, Star } from 'lucide-react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSessionStore } from '../../stores/session.store';
import { MemberEditDialog } from './MemberEditDialog';
import { AgentCreateWizard } from './AgentCreateWizard';
import { AddAgentDialog } from './AddAgentDialog';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { cn } from '../../lib/cn';
import type { AgentDefinition, WorkspaceAgentMember } from '../../ipc/types';

export function MembersPanel() {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const setDefaultAgent = useWorkspaceStore((s) => s.setDefaultAgent);
  const { members, definitions, loadMembers, startMember, stopMember, removeMember } =
    useAgentStore();

  // 当前正在编辑（API key + 能力覆盖）的成员；非 null 时渲染弹窗
  const [editingMember, setEditingMember] = useState<WorkspaceAgentMember | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    if (workspace) void loadMembers(workspace.id);
  }, [workspace, loadMembers]);

  const defMap = useMemo(() => new Map(definitions.map((d) => [d.id, d])), [definitions]);

  const handleStart = (member: WorkspaceAgentMember): void => {
    if (!workspace) return;
    void startMember(member, workspace.id);
  };

  const handleStop = (member: WorkspaceAgentMember): void => {
    void stopMember(member.instanceId);
  };

  const handleRemove = async (member: WorkspaceAgentMember): Promise<void> => {
    const name = member.agentName;
    if (!confirm(`确定将「${name}」移出本工作空间？`)) return;
    const result = await removeMember(member.instanceId);
    if (!result.ok) {
      alert(
        `「${name}」是以下团队的 leader，请先转移 leader 或解散团队：\n${result.blockedTeams.join('、')}`,
      );
      return;
    }
    // 成员移出后刷新会话成员快照（会话成员面板不自动跟随 workspace 成员变化）
    const { activeSessionId, loadMembers: loadSessionMembers } = useSessionStore.getState();
    if (activeSessionId) await loadSessionMembers(activeSessionId);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 flex items-center gap-2 border-b border-subtle shrink-0">
        <span className="inline-flex items-center gap-1.5 text-lg font-semibold">
          <Bot size={16} strokeWidth={1.75} aria-hidden />
          智能体成员
        </span>
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="secondary" onClick={() => setAddOpen(true)}>
            + 添加智能体
          </Button>
          <Button type="button" onClick={() => setCreateOpen(true)}>
            + 新建智能体
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
          {members.map((m) => (
            <MemberCard
              key={m.instanceId}
              member={m}
              def={defMap.get(m.agentDefinitionId)}
              workspace={workspace}
              setDefaultAgent={setDefaultAgent}
              onEdit={setEditingMember}
              onStart={handleStart}
              onStop={handleStop}
              onRemove={handleRemove}
            />
          ))}
        </div>

        {members.length === 0 && (
          <EmptyState
            icon={Bot}
            title="本工作空间暂无智能体成员"
            description="点击右上角「+ 新建智能体」添加成员"
          />
        )}
      </div>

      {createOpen && <AgentCreateWizard source="agentView" onClose={() => setCreateOpen(false)} />}
      {addOpen && <AddAgentDialog onClose={() => setAddOpen(false)} />}
      {editingMember && (
        <MemberEditDialog
          member={editingMember}
          def={definitions.find((d) => d.id === editingMember.agentDefinitionId)!}
          onClose={() => {
            setEditingMember(null);
            // setMemberDeltas 不像 updateMemberApiKey 那样内部刷新列表，需显式刷新
            if (workspace) void loadMembers(workspace.id);
          }}
        />
      )}
    </div>
  );
}

interface CardProps {
  member: WorkspaceAgentMember;
  def?: AgentDefinition;
  workspace: { id: string; defaultAgentInstanceId: string | null } | null;
  setDefaultAgent: (workspaceId: string, instanceId: string | null) => Promise<void>;
  onStart: (member: WorkspaceAgentMember) => void;
  onStop: (member: WorkspaceAgentMember) => void;
  onEdit: (member: WorkspaceAgentMember) => void;
  onRemove: (member: WorkspaceAgentMember) => Promise<void>;
}

/** 卡片操作钮共用态（预览定值合同：12px 文字钮，hover 底 surface-3）；移出变体改 error 色 */
const CARD_OP_BTN = 'rounded px-[5px] py-0.5 text-xs text-secondary transition-colors hover:bg-surface-3 hover:text-primary';

function MemberCard({
  member,
  def,
  workspace,
  setDefaultAgent,
  onStart,
  onStop,
  onEdit,
  onRemove,
}: CardProps) {
  const isDefault = workspace?.defaultAgentInstanceId === member.instanceId;
  const isRunning = member.lastRunning;
  const desc = def?.description?.trim();

  return (
    <div
      data-member-card={member.instanceId}
      title={desc || undefined}
      className="group rounded-lg border border-subtle bg-surface-1 p-3 transition-colors hover:border-strong hover:bg-surface-2"
    >
      <div className="flex items-center gap-2">
        <span className="text-[20px] leading-none">
          {def?.iconEmoji ?? <Bot size={20} strokeWidth={1.75} aria-hidden />}
        </span>
        <span className="truncate text-[13.5px] font-semibold">{def?.name ?? '未知'}</span>
        {isDefault && (
          <span className="inline-flex shrink-0 text-accent-500" title="默认会话智能体">
            <Star size={13} strokeWidth={1.75} aria-hidden fill="currentColor" />
          </span>
        )}
        <span className="flex-1" />
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full px-[7px] py-px text-[11px]',
            isRunning ? 'bg-status-success-tint text-status-success' : 'bg-surface-3 text-disabled',
          )}
        >
          {isRunning ? (
            <Play size={10} strokeWidth={2} aria-hidden />
          ) : (
            <Pause size={10} strokeWidth={2} aria-hidden />
          )}
          {isRunning ? '运行中' : '已停止'}
        </span>
      </div>

      <p className="mt-2 line-clamp-2 min-h-[37px] text-xs leading-[1.55] text-secondary">
        {desc ? desc : <span className="italic text-tertiary">暂无说明</span>}
      </p>

      <div className="mt-2.5 flex min-h-[22px] items-center gap-2">
        {def?.modelName && (
          <span className="truncate text-[11px] text-tertiary">{def.modelName}</span>
        )}
        <div className="ml-auto flex gap-0.5 whitespace-nowrap opacity-0 transition-opacity group-hover:opacity-100">
          {isRunning ? (
            <button type="button" onClick={() => onStop(member)} className={CARD_OP_BTN}>
              停止
            </button>
          ) : (
            <button type="button" onClick={() => onStart(member)} className={CARD_OP_BTN}>
              启动
            </button>
          )}
          {workspace && !isDefault && (
            <button
              type="button"
              onClick={() => void setDefaultAgent(workspace.id, member.instanceId)}
              className={CARD_OP_BTN}
            >
              设为默认
            </button>
          )}
          <button type="button" onClick={() => onEdit(member)} className={CARD_OP_BTN}>
            编辑
          </button>
          <button
            type="button"
            onClick={() => void onRemove(member)}
            className="rounded px-[5px] py-0.5 text-xs text-secondary transition-colors hover:bg-surface-3 hover:text-status-error"
          >
            移出
          </button>
        </div>
      </div>
    </div>
  );
}
