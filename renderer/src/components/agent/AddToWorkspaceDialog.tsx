// renderer/src/components/agent/AddToWorkspaceDialog.tsx
// 选 def + role + parent + apiKeyOverride → 添加到当前 workspace
// v1.6 Task 11：API key 步骤之后追加「能力调整（可选）」折叠区（Layer 3 per-assignment override）。
//   - 默认收起：大多数添加场景不需要 override，保持原有简洁流程。
//   - 展开后内嵌 CapabilityTabs mode="override"，defaultValue = def 默认能力 ∪ workspace allocation。
//   - 提交时先 addAgent 拿到新 instanceId，再 computeDeltas；deltas 全空则跳过 setAssignmentDeltas。
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { getProviderName } from '../../lib/provider-helpers';
import {
  computeDeltas,
  defToCapabilities,
  isEmptyDeltas,
  mergeDefault,
  type Capabilities,
} from '../../lib/capability-helpers';
import { CapabilityTabs } from './CapabilityTabs';
import type { AgentDefinition, AgentRole, WorkspaceAllocation } from '../../ipc/types';

interface Props {
  preselectedDef?: AgentDefinition;
  onClose: () => void;
}

const EMPTY_CAPS: Capabilities = { tools: [], mcps: [], skills: [] };

export function AddToWorkspaceDialog({ preselectedDef, onClose }: Props) {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const definitions = useAgentStore((s) => s.definitions);
  const assignments = useAgentStore((s) => s.assignments);
  const builtinSuggestions = useAgentStore((s) => s.builtinSuggestions);
  const addAgent = useAgentStore((s) => s.addAgent);
  const setAssignmentDeltas = useAgentStore((s) => s.setAssignmentDeltas);
  const stopAgent = useAgentStore((s) => s.stopAgent);
  const startAgent = useAgentStore((s) => s.startAgent);

  const [defId, setDefId] = useState(preselectedDef?.id ?? '');
  const [role, setRole] = useState<AgentRole>('standalone');
  const [parentInstanceId, setParentInstanceId] = useState('');
  const [apiKeyOverride, setApiKeyOverride] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Layer 3 折叠区：默认收起
  const [capsOpen, setCapsOpen] = useState(false);
  // workspace allocation（Layer 2），加载后参与计算 defaultCaps
  const [allocation, setAllocation] = useState<WorkspaceAllocation | null>(null);
  // 用户在折叠区内的勾选值（最终生效集）；初始 = defaultCaps，def/allocation 变化时重置
  const [overrideValue, setOverrideValue] = useState<Capabilities>(EMPTY_CAPS);

  // 选中 def 时预填建议 role
  useEffect(() => {
    if (defId && builtinSuggestions[defId]) {
      setRole(builtinSuggestions[defId]!.role);
    }
  }, [defId, builtinSuggestions]);

  const selectedDef = definitions.find((d) => d.id === defId);
  const mainAssignments = assignments.filter((a) => a.role === 'main');
  const unconfigured = selectedDef && !selectedDef.modelProviderId;

  // default = Layer1（def 默认能力）∪ Layer2（workspace allocation）
  const defaultCaps = useMemo<Capabilities>(() => {
    if (!selectedDef || !workspace) return EMPTY_CAPS;
    return mergeDefault(defToCapabilities(selectedDef), allocation ?? {
      workspaceId: workspace.id,
      tools: [],
      mcps: [],
      skills: [],
    });
  }, [selectedDef, workspace, allocation]);

  // def 或 allocation 变化 → 同步 overrideValue 到新默认（用户尚未手动改时）
  useEffect(() => {
    setOverrideValue(defaultCaps);
  }, [defaultCaps]);

  // 挂载 / 切 workspace 时拉一次 allocation（折叠区展开展示用）
  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    void ipc.allocation.get(workspace.id).then((alloc) => {
      if (!cancelled) setAllocation(alloc);
    });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!workspace || !defId) return;
    if (role === 'sub' && !parentInstanceId) {
      setError('子 agent 必须选择父主 agent');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // 1. 创建 assignment，捕获 IPC 返回的新 instanceId（Layer 3 deltas 必须绑到它）
      const newAssignment = await addAgent(
        workspace.id,
        defId,
        role,
        role === 'sub' ? parentInstanceId : undefined,
        apiKeyOverride.trim() || undefined,
      );
      // 2. 计算用户 override 相对 defaultCaps 的 deltas；全空则跳过（避免空写）
      const deltas = computeDeltas(overrideValue, defaultCaps);
      if (!isEmptyDeltas(deltas)) {
        await setAssignmentDeltas(newAssignment.instanceId, deltas);
        // addAgent 已内部 spawn（用的还是 deltas 落库前的能力），必须重启让新 deltas 生效
        const ws = await ipc.workspace.get(workspace.id);
        await stopAgent(newAssignment.instanceId);
        if (ws) {
          await startAgent(newAssignment, ws.id);
        }
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="bg-bg-secondary rounded-xl border border-border-subtle p-6 w-full max-w-md"
      >
        <h2 className="text-xl font-bold mb-4">添加 agent 到本工作空间</h2>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-sm text-neutral-300">选择 agent</label>
            <select
              value={defId}
              onChange={(e) => setDefId(e.target.value)}
              className="px-3 py-2 rounded-md bg-bg-tertiary border border-border-subtle text-neutral-100"
            >
              <option value="">请选择...</option>
              {definitions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.iconEmoji} {d.name} — {getProviderName(d.modelProviderId)} · {d.modelName}
                </option>
              ))}
            </select>
          </div>

          {unconfigured && (
            <div className="text-xs text-amber-500 bg-amber-500/10 rounded p-2">
              ⚠️ 该 agent 未配置模型供应商，无法启动。请先到 Agent 库配置。
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-sm text-neutral-300">角色</label>
            <div className="flex gap-3">
              {(['standalone', 'main', 'sub'] as const).map((r) => (
                <label key={r} className="flex items-center gap-1 text-sm text-neutral-300">
                  <input
                    type="radio"
                    checked={role === r}
                    onChange={() => setRole(r)}
                  />
                  {r === 'standalone' ? '独立' : r === 'main' ? '主 agent' : '子 agent'}
                </label>
              ))}
            </div>
          </div>

          {role === 'sub' && (
            <div className="flex flex-col gap-1">
              <label className="text-sm text-neutral-300">父主 agent</label>
              <select
                value={parentInstanceId}
                onChange={(e) => setParentInstanceId(e.target.value)}
                className="px-3 py-2 rounded-md bg-bg-tertiary border border-border-subtle text-neutral-100"
              >
                <option value="">请选择...</option>
                {mainAssignments.map((a) => {
                  const def = definitions.find((d) => d.id === a.agentDefinitionId);
                  return (
                    <option key={a.instanceId} value={a.instanceId}>
                      {def?.iconEmoji ?? '🤖'} {def?.name ?? '未知'}
                    </option>
                  );
                })}
              </select>
              {mainAssignments.length === 0 && (
                <span className="text-xs text-neutral-500">当前工作空间暂无主 agent。请先添加一个主 agent。</span>
              )}
            </div>
          )}

          <Input
            label="API Key（可选）"
            type="password"
            value={apiKeyOverride}
            onChange={(e) => setApiKeyOverride(e.target.value)}
            placeholder="留空使用供应商默认 key"
          />

          {/* Layer 3：能力调整（可选），默认收起 */}
          {selectedDef && (
            <details open={capsOpen} className="border-t border-border-subtle pt-3">
              <summary
                className="text-sm text-neutral-300 cursor-pointer"
                onClick={(e) => {
                  // jsdom 不模拟 details/summary 的原生 toggle，用 state 受控避免双重切换
                  e.preventDefault();
                  setCapsOpen((v) => !v);
                }}
              >
                能力调整（可选）— 默认继承 def + workspace
              </summary>
              {capsOpen && (
                <div className="mt-2">
                  <CapabilityTabs
                    mode="override"
                    defaultValue={defaultCaps}
                    value={overrideValue}
                    onChange={setOverrideValue}
                  />
                </div>
              )}
            </details>
          )}

          {error && <div className="text-red-400 text-sm">{error}</div>}
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="ghost" type="button" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={submitting || !defId || !!unconfigured || (role === 'sub' && !parentInstanceId)}>
              {submitting ? '添加中…' : '添加并启动'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
