// renderer/src/components/im/DefaultAgentPickerDialog.tsx
//
// v25 Task 13：默认会话 agent 一次性选择弹窗（spec §7「快速会话无默认 agent」）。
// 快速会话（⚡）发现 ws 无默认 agent 时弹出：单选成员 → setDefaultAgent →
// onContinue(instanceId) 回调继续建快速会话。
// ws 无成员 → 引导去 Agent 管理（spec §7 边界：不渲染选择列表）。
//
// v2.1 P2 Task 15：手写 modal 外壳 → Dialog 原子件；空态 → EmptyState（icon=Bot）；
// iconEmoji 缺省 → Avatar bot（对齐 MentionInput / MembersPanel 先例）。
//
// 2026-10-22 Task 13（spec §6.3）：radio 行 → AgentPickerCard 单选模式（整卡点选，
// selected 以 accent 边框 + radiogroup/aria-checked 表达）+ 描述直出（def.description）
// + 能力徽标（getEffectiveCapabilities 批量；record 缺 key 是合法态 → def 级降级，
// capabilityMode 标注「默认能力」，绝不可空桶冒充零能力）+ 展开手风琴（单开）。
// D13 单成员自动预选 / 多成员不预选行为原样保留。
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Bot } from 'lucide-react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { AgentPickerCard } from '../agent/AgentPickerCard';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { EmptyState } from '../ui/EmptyState';
import { ipc } from '../../ipc/client';
import { defToEffectiveCaps } from '../../lib/capability-helpers';
import type { EffectiveCapabilities, WorkspaceAgentMember } from '../../ipc/types';

interface Props {
  workspaceId: string;
  /** 设默认成功后回调（继续建快速会话）——参数为所选成员 instanceId */
  onContinue: (instanceId: string) => void;
  onClose: () => void;
}

export function DefaultAgentPickerDialog({ workspaceId, onContinue, onClose }: Props) {
  const { members, definitions, loadMembers, loadDefinitions } = useAgentStore();
  const setDefaultAgent = useWorkspaceStore((s) => s.setDefaultAgent);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Task 13：生效能力（instanceId → IPC 批量产物）+ 展开手风琴（每弹窗单开）
  const [capsByInstance, setCapsByInstance] = useState<Record<string, EffectiveCapabilities>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    void loadMembers(workspaceId);
    void loadDefinitions(workspaceId);
  }, [workspaceId, loadMembers, loadDefinitions]);

  // D13：仅一名成员时自动预选——唯一选项无需用户手动点选即可直接继续；
  // 多成员不预选（避免替用户做选择）
  useEffect(() => {
    if (members.length === 1 && selectedId === null) {
      setSelectedId(members[0]!.instanceId);
    }
  }, [members, selectedId]);

  // 批量拉生效能力（打开/成员表变化时）。ipc Proxy 在 window.api 未挂载时同步抛
  // TypeError（测试环境）——整体包 try；失败保持空 record 由 def 级降级承担展示。
  useEffect(() => {
    const ids = members.map((m) => m.instanceId);
    if (ids.length === 0) {
      setCapsByInstance({});
      return;
    }
    let cancelled = false;
    try {
      void ipc.agent
        .getEffectiveCapabilities(ids)
        .then((record) => {
          if (!cancelled) setCapsByInstance(record ?? {});
        })
        .catch(() => {
          if (!cancelled) setCapsByInstance({});
        });
    } catch {
      setCapsByInstance({});
    }
    return () => {
      cancelled = true;
    };
  }, [members]);

  const defMap = useMemo(() => new Map(definitions.map((d) => [d.id, d])), [definitions]);

  // 徽标数据：优先 IPC 生效能力；record 缺 key（Task 12 合法态）→ def 级降级
  const capsForMember = (
    m: WorkspaceAgentMember,
  ): { caps: EffectiveCapabilities; mode: 'effective' | 'default' } | undefined => {
    const eff = capsByInstance[m.instanceId];
    if (eff) return { caps: eff, mode: 'effective' };
    const def = defMap.get(m.agentDefinitionId);
    return def ? { caps: defToEffectiveCaps(def), mode: 'default' } : undefined;
  };

  const toggleRowExpand = (key: string): void =>
    setExpandedId((cur) => (cur === key ? null : key));

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!selectedId) return;
    setSaving(true);
    setError(null);
    try {
      await setDefaultAgent(workspaceId, selectedId);
      onContinue(selectedId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="选择默认会话智能体" width={448}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <p className="text-xs text-tertiary">
          快速会话需要一个默认智能体直达；本次设置后续可随时在「智能体」页更换
        </p>

        {members.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="当前工作空间暂无智能体成员"
            description="请先到「智能体」页添加智能体成员，再使用快速会话"
            action={
              <div className="flex justify-center mt-2">
                <Button variant="ghost" type="button" onClick={onClose}>
                  关闭
                </Button>
              </div>
            }
          />
        ) : (
          <>
            <fieldset
              role="radiogroup"
              aria-label="默认会话智能体"
              className="flex flex-col gap-1.5"
            >
              {members.map((m) => {
                const capInfo = capsForMember(m);
                return (
                  <AgentPickerCard
                    key={m.instanceId}
                    id={m.instanceId}
                    name={m.agentName}
                    iconEmoji={m.iconEmoji}
                    description={defMap.get(m.agentDefinitionId)?.description}
                    capabilities={capInfo?.caps}
                    capabilityMode={capInfo?.mode}
                    selected={selectedId === m.instanceId}
                    onSelect={() => setSelectedId(m.instanceId)}
                    expanded={expandedId === m.instanceId}
                    onToggleExpand={() => toggleRowExpand(m.instanceId)}
                  />
                );
              })}
            </fieldset>

            {error && <div className="text-status-error text-sm mt-2">{error}</div>}
            <div className="flex gap-2 justify-end mt-4">
              <Button variant="ghost" type="button" onClick={onClose}>
                取消
              </Button>
              <Button type="submit" disabled={!selectedId || saving}>
                {saving ? '设置中…' : '设为默认并继续'}
              </Button>
            </div>
          </>
        )}
      </form>
    </Dialog>
  );
}
