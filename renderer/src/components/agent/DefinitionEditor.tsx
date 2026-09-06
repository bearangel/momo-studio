// renderer/src/components/agent/DefinitionEditor.tsx
// def 创建/编辑/配置 builtin 对话框
//
// v1.6 Task 9：底部加「能力配置」区，复用 CapabilityTabs。
// - create 模式：默认勾选 SAFE_MINIMUM_TOOLS，提交时把 capabilities 转为 ToolRef/McpRef/SkillRef 传 IPC
// - edit 模式：从 def.defaultTools/Mcps/Skills 初始化
// - configure（builtin）模式：CapabilityTabs mode='readonly'，提交按钮不传 default*
//
// v2.1 P3 裁定：fixed inset-0 为居中表单弹窗（max-w-md / 85vh 滚动的 form
// 面板），非全屏编辑器浮层 → 收敛 Dialog 原子件（P3 Task 5 CreateAgentDialog
// 同款）：供应商 select → Select 原子件、系统提示词 textarea token 化；
// 表单点击 stopPropagation 随手写遮罩退役（Dialog 面板与遮罩为兄弟节点）。
//
// v2.2 fix：模型字段接入 ProviderModelPicker（与创建侧同构）
import { useEffect, useState, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useAgentStore } from '../../stores/agent.store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { CapabilityTabs, type Capabilities } from './CapabilityTabs';
import { ProviderModelPicker } from './ProviderModelPicker';
import { SAFE_MINIMUM_TOOLS } from '../../lib/tool-catalog';
import { defToCapabilities } from '../../lib/capability-helpers';
import type { AgentDefinition } from '../../ipc/types';

interface Props {
  mode: 'create' | 'edit' | 'configure';
  def?: AgentDefinition;
  onClose: () => void;
}

export function DefinitionEditor({ mode, def, onClose }: Props) {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const loadDefinitions = useAgentStore((s) => s.loadDefinitions);

  const isBuiltin = mode === 'configure';
  const readOnly = isBuiltin;

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [prompt, setPrompt] = useState('');
  const [iconEmoji, setIconEmoji] = useState('🤖');
  const [providerId, setProviderId] = useState('');
  const [modelName, setModelName] = useState('');
  // create 模式默认 = SAFE_MINIMUM_TOOLS；edit/configure 模式从 def.defaultTools/Mcps/Skills 加载
  const [capabilities, setCapabilities] = useState<Capabilities>(
    mode === 'create'
      ? { tools: [...SAFE_MINIMUM_TOOLS], mcps: [], skills: [] }
      : def
        ? defToCapabilities(def)
        : { tools: [...SAFE_MINIMUM_TOOLS], mcps: [], skills: [] },
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (def && (mode === 'edit' || mode === 'configure')) {
      setName(def.name);
      setSlug(def.slug);
      setPrompt(def.systemPrompt);
      setIconEmoji(def.iconEmoji);
      setProviderId(def.modelProviderId ?? '');
      setModelName(def.modelName);
      setCapabilities(defToCapabilities(def));
    }
  }, [def, mode]);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!name.trim() || !prompt.trim()) {
      setError('名称和系统提示词不能为空');
      return;
    }
    if (!providerId || !modelName.trim()) {
      setError('模型供应商和模型名不能为空');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // 把 string[] 转换为强类型 Ref[]（kind 字段：tools='builtin'，mcps='mcp'，skills='skill'）
      const defaultTools = capabilities.tools.map((ref) => ({ kind: 'builtin' as const, ref }));
      const defaultMcps = capabilities.mcps.map((ref) => ({ kind: 'mcp' as const, ref }));
      const defaultSkills = capabilities.skills.map((ref) => ({ kind: 'skill' as const, ref }));

      if (mode === 'create') {
        await ipc.agent.createCustom({
          name: name.trim(),
          slug: slug.trim().toLowerCase().replace(/\s+/g, '-'),
          description: `自定义 agent: ${name.trim()}`,
          systemPrompt: prompt.trim(),
          iconEmoji,
          // v25 定义全局化：scope 恒 'global'（workspace_id 列已退役，electron 忽略）
          scope: 'global',
          modelProviderId: providerId,
          modelName: modelName.trim(),
          defaultTools,
          defaultMcps,
          defaultSkills,
        });
      } else if (def) {
        const input: Parameters<typeof ipc.agent.updateDefinition>[0] = {
          id: def.id,
          name: name.trim(),
          systemPrompt: prompt.trim(),
          iconEmoji,
          modelProviderId: providerId,
          modelName: modelName.trim(),
          defaultTools,
          defaultMcps,
          defaultSkills,
        };
        await ipc.agent.updateDefinition(input);
      }
      await loadDefinitions(activeWorkspaceId ?? undefined);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const title = mode === 'create' ? '新建 agent 定义' : mode === 'edit' ? '编辑 agent 定义' : '配置 builtin agent';

  return (
    <Dialog open onClose={onClose} title={title} width={448}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <Input
          label="名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：代码审查员"
          readOnly={readOnly}
          autoFocus={mode === 'create'}
        />
        {!isBuiltin && (
          <Input
            label="标识符 (slug)"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="如：code-reviewer"
            readOnly={mode === 'edit'}
          />
        )}
        <div className="flex flex-col gap-1">
          <label htmlFor="def-editor-prompt" className="text-sm text-secondary">
            系统提示词
          </label>
          <textarea
            id="def-editor-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="你是一名资深审查员..."
            rows={4}
            readOnly={readOnly}
            className="rounded-md border border-subtle bg-surface-2 px-3 py-2 text-[13px] text-primary focus:border-focus focus:outline-none resize-y"
          />
        </div>
        {/* 图标 emoji 为用户数据输入框（iconEmoji 字段值照渲染，豁免） */}
        <Input
          label="图标 emoji"
          value={iconEmoji}
          onChange={(e) => setIconEmoji(e.target.value)}
          readOnly={readOnly}
        />

        <ProviderModelPicker
          providerId={providerId}
          modelId={modelName}
          onProviderChange={setProviderId}
          onModelChange={setModelName}
          disabled={readOnly}
        />

        {mode === 'create' && (
          <div className="text-xs text-tertiary">
            定义全局共享（v25 起无工作空间私有 agent）；加入哪个工作空间由「加入到当前工作空间」决定
          </div>
        )}

        {/* v1.6 能力配置区：create/edit 可改；configure(builtin) 只读 */}
        <div className="flex flex-col gap-2 border-t border-subtle pt-3">
          <div className="text-sm text-secondary">能力配置</div>
          {isBuiltin && (
            <div className="text-xs text-tertiary">
              builtin 默认能力不可改；添加到 workspace 后可用 Layer 3 override
            </div>
          )}
          <CapabilityTabs
            mode={isBuiltin ? 'readonly' : 'edit'}
            value={capabilities}
            onChange={(next) => setCapabilities(next)}
          />
        </div>

        {error && <div className="text-status-error text-sm">{error}</div>}
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" type="button" onClick={onClose}>取消</Button>
          <Button type="submit" disabled={saving}>
            {saving ? '保存中…' : (mode === 'create' ? '创建' : '保存')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
