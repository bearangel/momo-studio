// renderer/src/components/agent/EnablePresetDialog.tsx
//
// 预设 agent 启用 / 配置弹窗（spec 2026-09-22 资源库预设 agent 启用与 LLM 配置）。
//
// 两种模式：
//   - enable（def 未传）：启用即配——enablePreset IPC 一步完成 def 入库 + 模型写入
//     +（可选）加入当前工作空间 + 设为默认会话 agent；两个 checkbox 仅此模式渲染
//   - edit（def 传入）：配置——updateDefinition 只写模型字段（MemberEditDialog
//     模型区同模式）；保存后若当前 ws 有运行中成员 → pendingRestart 提示态
//
// 预填链：edit 从 def；enable 从全局默认模型 defaultChatModel（供应商仍存在时），
// 其次按 builtinSuggestions 的 suggestedPlatform 预选首个匹配平台的供应商。
import { useEffect, useState, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useProviderStore } from '../../stores/provider.store';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Dialog } from '../ui/Dialog';
import { ProviderModelPicker } from './ProviderModelPicker';
import { ThinkingOverrideControl } from './ThinkingOverrideControl';
import type {
  AgentDefinition,
  ReasoningCapability,
  ThinkingConfig,
  WorkspaceAgentMember,
} from '../../ipc/types';

interface Props {
  /** 预设 slug（enable 模式必填；edit 模式用于 suggestions 平台预选） */
  slug: string;
  /** 展示名（标题） */
  name: string;
  /** 编辑模式传入已启用 def；undefined = 启用模式 */
  def?: AgentDefinition;
  onClose: () => void;
}

export function EnablePresetDialog({ slug, name, def, onClose }: Props) {
  const isEdit = def !== undefined;
  const workspace = useWorkspaceStore((s) => s.getActive());
  const providers = useProviderStore((s) => s.providers);
  const loadProviders = useProviderStore((s) => s.loadProviders);
  const members = useAgentStore((s) => s.members);
  const loadMembers = useAgentStore((s) => s.loadMembers);
  const builtinSuggestions = useAgentStore((s) => s.builtinSuggestions);
  const stopMember = useAgentStore((s) => s.stopMember);
  const startMember = useAgentStore((s) => s.startMember);

  const [providerId, setProviderId] = useState(def?.modelProviderId ?? '');
  const [modelName, setModelName] = useState(def?.modelName ?? '');
  const [modelCapability, setModelCapability] = useState<ReasoningCapability | null>(null);
  const [thinkingJson, setThinkingJson] = useState<ThinkingConfig | null>(def?.thinkingJson ?? null);
  const [join, setJoin] = useState(true);
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 保存成功 + 当前 ws 有运行中成员（仅 edit 模式）→ 「待重启」提示态
  const [pendingRestartMember, setPendingRestartMember] = useState<WorkspaceAgentMember | null>(null);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  // 编辑模式：拉当前 ws 成员（保存后判定 pendingRestart 用）
  useEffect(() => {
    if (isEdit && workspace) void loadMembers(workspace.id);
  }, [isEdit, workspace, loadMembers]);

  // 启用模式预填①：全局默认模型（供应商仍存在）
  useEffect(() => {
    if (isEdit) return;
    let cancelled = false;
    void (async () => {
      try {
        const g = await ipc.settings.getGlobal();
        if (cancelled) return;
        const ref = g.defaultChatModel;
        if (ref && ref.providerId && ref.modelId) {
          setProviderId(ref.providerId);
          setModelName(ref.modelId);
        }
      } catch {
        // 预填失败静默——用户手选
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isEdit]);

  // 启用模式预填②：defaultChatModel 未命中时，按 suggestedPlatform 预选首个匹配供应商
  useEffect(() => {
    if (isEdit || providerId) return;
    const suggestion = builtinSuggestions[`builtin-${slug}`];
    if (!suggestion?.suggestedPlatform) return;
    const hit = providers.find((p) => p.platform === suggestion.suggestedPlatform);
    if (hit) setProviderId(hit.id);
  }, [isEdit, providerId, providers, builtinSuggestions, slug]);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!providerId || !modelName.trim()) {
      setError('请选择模型供应商与模型');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (!isEdit) {
        await ipc.agent.enablePreset({
          slug,
          modelProviderId: providerId,
          modelName: modelName.trim(),
          thinkingJson,
          ...(join && workspace ? { joinWorkspaceId: workspace.id, setAsDefault } : {}),
        });
        onClose();
      } else {
        await ipc.agent.updateDefinition({
          id: def.id,
          modelProviderId: providerId,
          modelName: modelName.trim(),
          thinkingJson,
        });
        const running = members.find(
          (m) => m.agentDefinitionId === def.id && m.lastRunning,
        );
        if (running) {
          setPendingRestartMember(running);
        } else {
          onClose();
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleRestartNow = async (): Promise<void> => {
    if (!pendingRestartMember) return;
    setSaving(true);
    setError(null);
    try {
      await stopMember(pendingRestartMember.instanceId);
      await startMember(pendingRestartMember, pendingRestartMember.workspaceId);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // 待重启态吞掉 Esc / 遮罩关闭（MemberEditDialog 同模式，防误关重启提示）
  const handleDialogClose = pendingRestartMember ? () => undefined : onClose;

  return (
    <Dialog
      open
      onClose={handleDialogClose}
      title={isEdit ? `配置 Agent：${def.iconEmoji} ${def.name}` : `启用预设 Agent：${name}`}
      width={448}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {!isEdit && (
          <div className="text-xs text-tertiary">
            启用将把预设写入全局定义并配置模型；勾选加入后立即可在会话中使用。
          </div>
        )}

        <ProviderModelPicker
          providerId={providerId}
          modelId={modelName}
          onProviderChange={setProviderId}
          onModelChange={(id) => {
            setModelName(id);
            // 换模型即重置覆盖，防旧模型档位残留（含换供应商联动清空）
            setThinkingJson(null);
          }}
          onModelInfo={(m) => setModelCapability(m?.reasoning ?? null)}
        />
        <ThinkingOverrideControl
          capability={modelCapability}
          value={thinkingJson}
          onChange={setThinkingJson}
        />

        {!isEdit && (
          <div className="border-t border-subtle pt-3 flex flex-col gap-2">
            <Checkbox
              label="加入当前工作空间"
              checked={!!workspace && join}
              disabled={!workspace}
              onChange={(e) => setJoin(e.target.checked)}
            />
            {!workspace && (
              <div className="text-xs text-tertiary ml-6">无激活工作空间——仅启用全局定义</div>
            )}
            {join && workspace && (
              <Checkbox
                label="设为默认会话 agent"
                checked={setAsDefault}
                onChange={(e) => setSetAsDefault(e.target.checked)}
              />
            )}
          </div>
        )}

        {error && <div className="text-status-error text-sm">{error}</div>}
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" type="button" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? '保存中…' : isEdit ? '保存' : '启用'}
          </Button>
        </div>

        {pendingRestartMember && (
          <div className="border-t border-subtle pt-3 flex flex-col gap-2">
            <div className="text-sm text-secondary">
              已保存。该 agent 正在运行，<span className="text-accent-600 dark:text-accent-300">需重启</span>才能生效。
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" type="button" onClick={onClose} disabled={saving}>
                稍后
              </Button>
              <Button type="button" onClick={() => void handleRestartNow()} disabled={saving}>
                {saving ? '重启中…' : '立即重启'}
              </Button>
            </div>
          </div>
        )}
      </form>
    </Dialog>
  );
}
