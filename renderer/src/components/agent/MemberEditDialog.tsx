// renderer/src/components/agent/MemberEditDialog.tsx
//
// 成员统一编辑弹窗：原「更新密钥」与「能力覆盖」两个独立弹窗合并为单一
// 「编辑」入口。v2.2 P4 起 API Key 区移除（key 统一在「设置 → 模型服务」
// 供应商处管理；后端 setMemberApiKeyOverride / keychain 机制保留），改为
// 模型区（全局定义属性）+ 能力覆盖区。
//
// 两个区域：
//   - 模型区：ProviderModelPicker 受控，写入 agent_definitions（全局影响，
//     spec §3.3b）—— def.modelProviderId / def.modelName 修改对所有
//     工作空间的同名 agent 生效
//   - 能力覆盖区：CapabilityTabs mode='override'（default = L1∪allocation、
//     value = applyDeltas 反推，沿用原能力弹窗的加载/合并/保存逻辑）
//
// 保存链顺序：模型有变化 → ipc.agent.updateDefinition 先于 setMemberDeltas
// （spec §3.3b：定义修改是先行条件，能力 deltas 是成员级追加）。pendingRestart
// 条件 = (modelChanged || deltasChanged) && member.lastRunning。
//
// 重启提示：保存成功后若（模型 或 deltas 有变化）且成员运行中（lastRunning）
// → 弹内提示「需重启才能生效」，用户可选 [立即重启]（stop + start）或
// [稍后]（仅关闭）。
//
// v2.1 P3：手写 modal 外壳 → Dialog 原子件（P2 Task 14/15 先例）；旧色阶
// token → 语义 token；待重启态吞掉 Dialog 的 Esc/遮罩关闭（保持原
// 「重启提示期间点遮罩不关闭」语义）。
import { useEffect, useMemo, useState } from 'react';
import { ipc } from '../../ipc/client';
import { useAgentStore } from '../../stores/agent.store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { CapabilityTabs } from './CapabilityTabs';
import { ProviderModelPicker } from './ProviderModelPicker';
import {
  EMPTY_DELTAS,
  applyDeltas,
  computeDeltas,
  defToCapabilities,
  deltasEqual,
  mergeDefault,
  type Capabilities,
} from '../../lib/capability-helpers';
import type {
  WorkspaceAgentMember,
  AgentDefinition,
  AssignmentDeltas,
} from '../../ipc/types';

interface Props {
  member: WorkspaceAgentMember;
  def: AgentDefinition;
  onClose: () => void;
}

export function MemberEditDialog({ member, def, onClose }: Props) {
  const getMemberDeltas = useAgentStore((s) => s.getMemberDeltas);
  const setMemberDeltasAction = useAgentStore((s) => s.setMemberDeltas);
  const stopMember = useAgentStore((s) => s.stopMember);
  const startMember = useAgentStore((s) => s.startMember);
  const loadDefinitions = useAgentStore((s) => s.loadDefinitions);

  // ---- 模型区（全局定义属性，写入 agent_definitions）----
  const [modelProviderId, setModelProviderId] = useState(def.modelProviderId ?? '');
  const [modelName, setModelName] = useState(def.modelName);

  // def 变化时同步模型选择（与 DefinitionEditor 同模式）
  useEffect(() => {
    setModelProviderId(def.modelProviderId ?? '');
    setModelName(def.modelName);
  }, [def]);

  // ---- 能力覆盖区 ----
  // def 默认能力（Layer 1，不含 workspace allocation）
  const defCaps = useMemo(() => defToCapabilities(def), [def]);

  // default = Layer1 ∪ Layer2 合集（CapabilityTabs override 模式的 defaultValue）
  const [defaultCaps, setDefaultCaps] = useState<Capabilities>(defCaps);
  // 当前勾选值（最终生效集，override 模式的 value）
  const [value, setValue] = useState<Capabilities>(defCaps);
  // 弹窗打开时加载的 deltas 快照（保存时判断是否产生新变化）
  const [initialDeltas, setInitialDeltas] = useState<AssignmentDeltas>(EMPTY_DELTAS);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 保存成功 + 成员运行中 + 模型/deltas 有变化 → 进入「待重启」提示态
  const [pendingRestart, setPendingRestart] = useState(false);

  // 初次挂载：并行拉 allocation + deltas，合并 default 后反推 value
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const [alloc, deltas] = await Promise.all([
          ipc.allocation.get(member.workspaceId),
          getMemberDeltas(member.instanceId),
        ]);
        if (cancelled) return;
        const merged = mergeDefault(defCaps, alloc);
        setDefaultCaps(merged);
        setInitialDeltas(deltas);
        setValue(applyDeltas(merged, deltas));
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [member.workspaceId, member.instanceId, defCaps, getMemberDeltas]);

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      // 模型变更走全局定义更新（先于能力 deltas，spec §3.3b）
      const modelChanged =
        modelProviderId !== (def.modelProviderId ?? '') || modelName !== def.modelName;
      if (modelChanged) {
        if (!modelProviderId || !modelName) {
          setError('请选择模型供应商与模型');
          return;
        }
        await ipc.agent.updateDefinition({ id: def.id, modelProviderId, modelName });
        // 全局定义已变——刷新共享 definitions store，成员行/重开弹窗才能看到新模型（终审 Critical）
        await loadDefinitions(member.workspaceId);
      }
      const newDeltas = computeDeltas(value, defaultCaps);
      await setMemberDeltasAction(member.instanceId, newDeltas);
      const deltasChanged = !deltasEqual(newDeltas, initialDeltas);
      setInitialDeltas(newDeltas);
      if ((modelChanged || deltasChanged) && member.lastRunning) {
        setPendingRestart(true);
      } else {
        onClose();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRestartNow(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const ws = await ipc.workspace.get(member.workspaceId);
      await stopMember(member.instanceId);
      if (ws) {
        await startMember(member, ws.id);
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // 待重启提示态吞掉 Dialog 的 Esc/遮罩关闭（原手写弹窗此态点遮罩不关闭，防误关重启提示）
  const handleDialogClose = pendingRestart ? () => undefined : onClose;

  return (
    <Dialog
      open
      onClose={handleDialogClose}
      title={`编辑成员：${def.iconEmoji} ${def.name}`}
      width={448}
    >
      <div className="flex flex-col gap-3">
        <div className="text-xs text-tertiary">
          更新模型与能力覆盖。模型为全局定义属性，修改对所有工作空间的同名 agent 生效。
        </div>

        {/* 模型区（全局定义属性——写入 agent_definitions）；与能力区解耦，
            不依赖 allocation，可在加载中即时渲染（picker 自理 listModels）。 */}
        {!pendingRestart && (
          <section className="flex flex-col gap-2">
            <div className="text-sm text-secondary">模型</div>
            <div className="text-xs text-tertiary">
              定义全局共享，模型修改对所有工作空间的同名 agent 生效
            </div>
            <ProviderModelPicker
              providerId={modelProviderId}
              modelId={modelName}
              onProviderChange={setModelProviderId}
              onModelChange={setModelName}
            />
          </section>
        )}

        {loading && !pendingRestart && <div className="text-sm text-tertiary">加载中…</div>}

        {!loading && !pendingRestart && (
          <>
            {/* 能力覆盖区 */}
            <section className="flex flex-col gap-2 border-t border-subtle pt-3">
              <CapabilityTabs
                mode="override"
                defaultValue={defaultCaps}
                value={value}
                onChange={(next) => setValue(next)}
              />
            </section>

            {error && <div className="text-status-error text-sm">{error}</div>}
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" type="button" onClick={onClose} disabled={saving}>
                取消
              </Button>
              <Button type="button" onClick={() => void handleSave()} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </Button>
            </div>
          </>
        )}

        {!loading && pendingRestart && (
          <>
            <div className="text-sm text-secondary">
              已保存。该 agent 正在运行，<span className="text-accent-600 dark:text-accent-300">需重启</span>才能生效。
            </div>
            {error && <div className="text-status-error text-sm">{error}</div>}
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" type="button" onClick={onClose} disabled={saving}>
                稍后
              </Button>
              <Button type="button" onClick={() => void handleRestartNow()} disabled={saving}>
                {saving ? '重启中…' : '立即重启'}
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
