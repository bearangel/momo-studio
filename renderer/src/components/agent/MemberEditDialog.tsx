// renderer/src/components/agent/MemberEditDialog.tsx
//
// 成员统一编辑弹窗：将原「更新密钥」与「能力覆盖」两个独立弹窗合并为
// 单一「编辑」入口。
//
// 两个区域：
//   - API Key 区：password Input + hasApiKeyOverride 提示条 +「留空清除
//     override 回退供应商 key」说明（沿用原密钥弹窗文案与语义）
//   - 能力覆盖区：CapabilityTabs mode='override'（default = L1∪allocation、
//     value = applyDeltas 反推，沿用原能力弹窗的加载/合并/保存逻辑）
//
// key-dirty 语义（防误清 override）：API key 仅在用户改过输入框（dirty）时
// 才调用 updateMemberApiKey——初始空输入 + 未编辑 = 不调用，防止只改能力
// 时把已有 override 误清成 null。
//
// 重启提示：保存成功后若（key 或 deltas 有变化）且成员运行中（lastRunning）
// → 弹内提示「需重启才能生效」，用户可选 [立即重启]（stop + start）或
// [稍后]（仅关闭）。
import { useEffect, useMemo, useState } from 'react';
import { ipc } from '../../ipc/client';
import { useAgentStore } from '../../stores/agent.store';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { CapabilityTabs } from './CapabilityTabs';
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
  const updateMemberApiKeyAction = useAgentStore((s) => s.updateMemberApiKey);
  const stopMember = useAgentStore((s) => s.stopMember);
  const startMember = useAgentStore((s) => s.startMember);

  // ---- API Key 区 ----
  const [apiKey, setApiKey] = useState('');
  // 用户是否编辑过 key 输入框（dirty 判定：未编辑 = 保存时不调 updateMemberApiKey）
  const [keyDirty, setKeyDirty] = useState(false);

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
  // 保存成功 + 成员运行中 + key/deltas 有变化 → 进入「待重启」提示态
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
      // key 仅在用户改过输入框时提交（trim 后为空 = 清除 override 回退供应商 key）
      if (keyDirty) {
        await updateMemberApiKeyAction(member.instanceId, apiKey.trim() || null);
      }
      const newDeltas = computeDeltas(value, defaultCaps);
      await setMemberDeltasAction(member.instanceId, newDeltas);
      const deltasChanged = !deltasEqual(newDeltas, initialDeltas);
      setInitialDeltas(newDeltas);
      const changed = keyDirty || deltasChanged;
      if (changed && member.lastRunning) {
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

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={pendingRestart ? undefined : onClose}
    >
      <div
        className="bg-bg-secondary rounded-xl border border-border-subtle p-6 w-full max-w-md max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-xl font-bold mb-1">
          编辑成员：{def.iconEmoji} {def.name}
        </h2>
        <div className="text-xs text-neutral-500 mb-3">
          更新 API Key 与能力覆盖（不影响 agent 定义和其他工作空间成员）。
        </div>

        {loading && <div className="text-sm text-neutral-400">加载中…</div>}

        {!loading && !pendingRestart && (
          <>
            {/* API Key 区 */}
            <section className="flex flex-col gap-2 mb-4">
              {member.hasApiKeyOverride && (
                <div className="text-xs text-accent-blue bg-accent-blue/10 rounded p-2">
                  ℹ️ 当前使用独立 API key override
                </div>
              )}
              <Input
                label="API Key"
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setKeyDirty(true);
                }}
                placeholder="留空使用供应商默认 key"
              />
              <div className="text-xs text-neutral-500">
                留空清除 override，回退到供应商 key。未修改时保存不会动现有 key。
              </div>
            </section>

            {/* 能力覆盖区 */}
            <section className="flex flex-col gap-2 border-t border-border-subtle pt-3">
              <CapabilityTabs
                mode="override"
                defaultValue={defaultCaps}
                value={value}
                onChange={(next) => setValue(next)}
              />
            </section>

            {error && <div className="text-red-400 text-sm mt-2">{error}</div>}
            <div className="flex gap-2 justify-end mt-3">
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
            <div className="text-sm text-neutral-300 mb-2">
              已保存。该 agent 正在运行，<span className="text-accent-blue">需重启</span>才能生效。
            </div>
            {error && <div className="text-red-400 text-sm mb-2">{error}</div>}
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
    </div>
  );
}
