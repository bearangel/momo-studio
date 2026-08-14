// renderer/src/components/agent/AssignmentCapabilitiesDialog.tsx
//
// v1.6 Task 10：Layer 3 per-assignment 能力 override 弹窗。
// 让用户在单个 assignment 级别增/减能力（builtin / custom agent 通用），
// 不影响 agent 定义（Layer 1）和其他 workspace 分配（Layer 2）。
//
// 三层能力模型：
//   Layer 1 = agent 定义默认能力（def.defaultTools/Mcps/Skills）
//   Layer 2 = workspace 级能力分配（allocation 表）
//   Layer 3 = per-assignment override（本弹窗管理的 deltas）
//
// 合并规则（保序去重并集）：
//   default = Layer1 ∪ Layer2
//   value   = (default + deltas.addedX) - deltas.removedX  ← 从已存 deltas 反推
//   保存时：addedX = value - default；removedX = default - value
//
// 三态 checkbox 语义（由 CapabilityTabs override 模式渲染）：
//   工具 T 在 default 中：value 含 T = 无 delta；value 不含 T = removed delta
//   工具 T 不在 default 中：value 不含 T = 无 delta；value 含 T = added delta
//
// 重启提示：保存成功后若 deltas 真实变化且 agent 正在运行 → 弹内提示
// 「需重启才能生效」，用户可选 [立即重启]（stop + start）或 [稍后]（仅关闭）。
import { useEffect, useMemo, useState } from 'react';
import { ipc } from '../../ipc/client';
import { useAgentStore } from '../../stores/agent.store';
import { Button } from '../ui/Button';
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
  AgentAssignment,
  AgentDefinition,
  AssignmentDeltas,
} from '../../ipc/types';

interface Props {
  assignment: AgentAssignment;
  def: AgentDefinition;
  onClose: () => void;
}

export function AssignmentCapabilitiesDialog({ assignment, def, onClose }: Props) {
  const getAssignmentDeltas = useAgentStore((s) => s.getAssignmentDeltas);
  const setAssignmentDeltasAction = useAgentStore((s) => s.setAssignmentDeltas);
  const stopAgent = useAgentStore((s) => s.stopAgent);
  const startAgent = useAgentStore((s) => s.startAgent);

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
  // 保存成功 + agent 运行中 + deltas 变化 → 进入「待重启」提示态
  const [pendingRestart, setPendingRestart] = useState(false);

  // 初次挂载：并行拉 allocation + deltas，合并 default 后反推 value
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const [alloc, deltas] = await Promise.all([
          ipc.allocation.get(assignment.workspaceId),
          getAssignmentDeltas(assignment.instanceId),
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
  }, [assignment.workspaceId, assignment.instanceId, defCaps, getAssignmentDeltas]);

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const newDeltas = computeDeltas(value, defaultCaps);
      await setAssignmentDeltasAction(assignment.instanceId, newDeltas);
      const changed = !deltasEqual(newDeltas, initialDeltas);
      setInitialDeltas(newDeltas);
      // v2 修复：用 assignment.lastRunning 判断 agent 是否运行中
      if (changed && assignment.lastRunning) {
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
      const ws = await ipc.workspace.get(assignment.workspaceId);
      await stopAgent(assignment.instanceId);
      if (ws) {
        await startAgent(assignment, ws.id, ws.teamRoomId);
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
        <h2 className="text-xl font-bold mb-1">能力覆盖：{def.name}</h2>
        <div className="text-xs text-neutral-500 mb-3">
          在此 assignment 级别增减能力（不影响 agent 定义和其他 assignment）。
        </div>

        {loading && <div className="text-sm text-neutral-400">加载中…</div>}

        {!loading && !pendingRestart && (
          <>
            <CapabilityTabs
              mode="override"
              defaultValue={defaultCaps}
              value={value}
              onChange={(next) => setValue(next)}
            />
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
              能力已保存。该 agent 正在运行，<span className="text-accent-blue">需重启</span>才能生效。
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
