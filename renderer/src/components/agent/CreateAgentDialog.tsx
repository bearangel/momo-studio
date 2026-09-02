// renderer/src/components/agent/CreateAgentDialog.tsx
//
// v25 Task 13：创建 Agent 弹窗（spec §6.3）——DefinitionEditor 的「创建」精简版，两者共存：
// 编辑既有定义仍走 DefinitionEditor（资源库编辑场景），本弹窗只做创建。
//
// source 语义：
//   - 'agentView'（Agent 管理 Tab）：创建成功自动 addMember 加入当前 ws；
//     勾选「设为默认会话 agent」则随后 setDefaultAgent（已有默认时副文案提示替换）
//   - 'library'（资源库「+ 添加资源 → 创建 Agent」）：仅建全局定义，不动 ws 成员
//
// 默认工具集三档（spec §6.3）：安全最小集 / 全部 / 自选——沿用 renderer 端
// tool-catalog 常量副本（与 electron 端 catalog.ts 手工同步，见该文件头注释）。
//
// v2.1 P3：手写 modal 外壳 → Dialog 原子件；供应商 select → Select、
// 「设为默认会话 agent」→ Checkbox；工具三档 radio 与自选网格 checkbox 保留原生
// input（P3 Task 4 TeamDialog 先例：行内单/多选原生 + aria-label），仅 token 化；
// 系统提示词 textarea 无原子件走 token 类；⚡ 说明文案去 emoji（语义不变）。
import { useEffect, useState, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useProviderStore } from '../../stores/provider.store';
import { useAgentStore } from '../../stores/agent.store';
import { ALL_BUILTIN_TOOLS, SAFE_MINIMUM_TOOLS, TOOL_CATEGORIES } from '../../lib/tool-catalog';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';

interface Props {
  /** 入口来源：agentView=Agent 管理 Tab（创建即加入当前 ws）；library=资源库（仅建全局定义） */
  source: 'agentView' | 'library';
  onClose: () => void;
}

type ToolPreset = 'safe' | 'all' | 'custom';

const PRESETS: Array<{ key: ToolPreset; label: string; hint: string }> = [
  { key: 'safe', label: '安全最小集', hint: '读写 / 搜索 / todo，不含 Shell 与 Git 写操作' },
  { key: 'all', label: '全部工具', hint: '全部内置工具（含 bash 与 git 写操作）' },
  { key: 'custom', label: '自选', hint: '手动勾选工具' },
];

export function CreateAgentDialog({ source, onClose }: Props) {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const setDefaultAgent = useWorkspaceStore((s) => s.setDefaultAgent);
  const { providers, loadProviders } = useProviderStore();
  const loadDefinitions = useAgentStore((s) => s.loadDefinitions);
  const addMember = useAgentStore((s) => s.addMember);

  const [name, setName] = useState('');
  const [iconEmoji, setIconEmoji] = useState('🤖');
  const [prompt, setPrompt] = useState('');
  const [providerId, setProviderId] = useState('');
  const [modelName, setModelName] = useState('');
  const [preset, setPreset] = useState<ToolPreset>('safe');
  // 「自选」档的勾选集合；初始 = 安全最小集，切档不重置（保留用户微调）
  const [customTools, setCustomTools] = useState<string[]>([...SAFE_MINIMUM_TOOLS]);
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  // 沿用 DefinitionEditor 的供应商数据模式：选定供应商时自动填其默认模型
  const handleProviderChange = (id: string): void => {
    setProviderId(id);
    const p = providers.find((x) => x.id === id);
    if (p?.defaultModel && !modelName) {
      setModelName(p.defaultModel);
    }
  };

  const toggleCustomTool = (tool: string, checked: boolean): void => {
    setCustomTools((cur) =>
      checked ? [...cur, tool] : cur.filter((t) => t !== tool),
    );
  };

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!name.trim()) {
      setError('名称不能为空');
      return;
    }
    if (!providerId || !modelName.trim()) {
      setError('请选择模型服务并填写模型名');
      return;
    }
    if (source === 'agentView' && !workspace) {
      setError('无激活工作空间，无法加入成员');
      return;
    }
    const tools =
      preset === 'safe'
        ? SAFE_MINIMUM_TOOLS
        : preset === 'all'
          ? ALL_BUILTIN_TOOLS
          : customTools;
    setSaving(true);
    setError(null);
    try {
      const def = await ipc.agent.createCustom({
        name: name.trim(),
        slug: name.trim().toLowerCase().replace(/\s+/g, '-'),
        description: `自定义 agent: ${name.trim()}`,
        systemPrompt: prompt.trim(),
        iconEmoji,
        // v25 定义全局化：scope 恒 'global'（workspace_id 列已退役）
        scope: 'global',
        modelProviderId: providerId,
        modelName: modelName.trim(),
        defaultTools: tools.map((ref) => ({ kind: 'builtin' as const, ref })),
      });
      await loadDefinitions(workspace?.id ?? undefined);
      if (source === 'agentView' && workspace) {
        const member = await addMember(workspace.id, def.id);
        if (setAsDefault) {
          await setDefaultAgent(workspace.id, member.instanceId);
        }
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="创建 Agent" width={448}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <Input
          label="名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：代码审查员"
          autoFocus
        />
        <Input
          label="图标"
          value={iconEmoji}
          onChange={(e) => setIconEmoji(e.target.value)}
        />
        <Select
          label="模型供应商*"
          value={providerId}
          onChange={(e) => handleProviderChange(e.target.value)}
        >
          <option value="">请选择...</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.isDefault ? '（默认）' : ''}
            </option>
          ))}
        </Select>
        <Input
          label="模型名"
          value={modelName}
          onChange={(e) => setModelName(e.target.value)}
          placeholder="如 gpt-4o, claude-sonnet-4"
        />
        <div className="flex flex-col gap-1">
          <label htmlFor="create-agent-prompt" className="text-sm text-secondary">
            系统提示词
          </label>
          <textarea
            id="create-agent-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="你是一名资深审查员..."
            rows={4}
            className="rounded-md border border-subtle bg-surface-2 px-3 py-2 text-[13px] text-primary focus:border-focus focus:outline-none resize-y"
          />
        </div>

        {/* 默认工具集三档（spec §6.3） */}
        <fieldset className="flex flex-col gap-1.5 border-t border-subtle pt-3">
          <legend className="text-sm text-secondary">默认工具集</legend>
          {PRESETS.map((p) => (
            <label key={p.key} className="flex items-start gap-2 text-sm text-secondary">
              <input
                type="radio"
                name="tool-preset"
                aria-label={p.label}
                checked={preset === p.key}
                onChange={() => setPreset(p.key)}
                className="mt-0.5"
              />
              <span>
                {p.label}
                <span className="block text-xs text-tertiary">{p.hint}</span>
              </span>
            </label>
          ))}
          {preset === 'custom' && (
            <div className="flex flex-col gap-2 pl-5 pt-1">
              {TOOL_CATEGORIES.map((cat) => (
                <div key={cat.label}>
                  {/* cat.emoji 为 tool-catalog 数据字段（豁免，非 UI 硬编码图标） */}
                  <div className="text-xs text-tertiary mb-1">
                    {cat.emoji} {cat.label}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {cat.tools.map((tool) => (
                      <label key={tool} className="flex items-center gap-1 text-xs text-secondary">
                        <input
                          type="checkbox"
                          aria-label={tool}
                          checked={customTools.includes(tool)}
                          onChange={(e) => toggleCustomTool(tool, e.target.checked)}
                        />
                        {tool}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </fieldset>

        {source === 'agentView' ? (
          <div className="border-t border-subtle pt-3 flex flex-col gap-1">
            <Checkbox
              label="设为默认会话 agent"
              checked={setAsDefault}
              onChange={(e) => setSetAsDefault(e.target.checked)}
            />
            {workspace?.defaultAgentInstanceId ? (
              <div className="text-xs text-status-warning mt-1 ml-6">将替换现有默认</div>
            ) : (
              <div className="text-xs text-tertiary mt-1 ml-6">
                默认 agent 是快速会话的直达目标
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs text-tertiary border-t border-subtle pt-3">
            仅创建全局 Agent 定义；加入具体工作空间请从「Agent 管理 → 成员」添加
          </div>
        )}

        {error && <div className="text-status-error text-sm">{error}</div>}
        <div className="flex gap-2 justify-end mt-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? '创建中…' : '创建'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
