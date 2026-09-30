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
// 默认工具集三档（spec §6.3）：标准（推荐）/ 全部 / 自定义——目录数据自 v2.x 起
// 切 IPC tools:getCatalog 单一真相源（useToolCatalog，模块级缓存）。「自定义」档
// 内嵌 CapabilityTabs（工具 / MCP / Skill 三 tab，spec §4.4），提交三字段：
// defaultTools / defaultMcps / defaultSkills（electron 侧 createCustom 已支持）。
// 标准/全部档依赖目录数据：目录未就绪时提交被守卫拦截（提示稍候）。
//
// v2.1 P3：手写 modal 外壳 → Dialog 原子件；供应商 select → Select、
// 「设为默认会话 agent」→ Checkbox；工具三档 radio 保留原生
// input（P3 Task 4 TeamDialog 先例：行内单/多选原生 + aria-label），仅 token 化；
// 系统提示词 textarea 无原子件走 token 类；⚡ 说明文案去 emoji（语义不变）。
// v2.2 fix：模型名由手填 Input 改为 ProviderModelPicker 联动下拉（Bug 1）——
// picker 内部管供应商列表与模型 options（经 ipc.provider.listModels），换供应商
// 联动清空模型；deprecated 的 provider.defaultModel 快填随之退役。
// v2.x 工具能力重构（Task 6）：safe→standard 换档，自选手写 checkbox 区块整体
// 替换为 CapabilityTabs；defaultMcps/defaultSkills 随提交。
import { useEffect, useState, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useAgentStore } from '../../stores/agent.store';
import { useToolCatalog } from '../../lib/useToolCatalog';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { ProviderModelPicker } from './ProviderModelPicker';
import { ThinkingOverrideControl } from './ThinkingOverrideControl';
import { CapabilityTabs, type Capabilities } from './CapabilityTabs';
import type { ReasoningCapability, ThinkingConfig } from '../../ipc/types';

interface Props {
  /** 入口来源：agentView=Agent 管理 Tab（创建即加入当前 ws）；library=资源库（仅建全局定义） */
  source: 'agentView' | 'library';
  onClose: () => void;
}

type ToolPreset = 'standard' | 'all' | 'custom';

const PRESETS: Array<{ key: ToolPreset; label: string; hint: string }> = [
  { key: 'standard', label: '标准（推荐）', hint: '公共默认集：只读 + 文件写，不含 Shell / Git 写 / 网络' },
  { key: 'all', label: '全部工具', hint: '全部内置工具（含 bash、git 写、浏览器）' },
  { key: 'custom', label: '自定义', hint: '手动勾选 工具 / MCP / Skill' },
];

export function CreateAgentDialog({ source, onClose }: Props) {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const setDefaultAgent = useWorkspaceStore((s) => s.setDefaultAgent);
  const loadDefinitions = useAgentStore((s) => s.loadDefinitions);
  const addMember = useAgentStore((s) => s.addMember);

  const [name, setName] = useState('');
  const [iconEmoji, setIconEmoji] = useState('🤖');
  const [prompt, setPrompt] = useState('');
  const [providerId, setProviderId] = useState('');
  const [modelName, setModelName] = useState('');
  const [modelCapability, setModelCapability] = useState<ReasoningCapability | null>(null);
  const [thinkingJson, setThinkingJson] = useState<ThinkingConfig | null>(null);
  const [preset, setPreset] = useState<ToolPreset>('standard');
  // 「自定义」档的能力集合；目录就绪后初始化为 Tier 1（安全最小集）
  const [caps, setCaps] = useState<Capabilities>({ tools: [], mcps: [], skills: [] });
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { data: catalog, error: catalogError } = useToolCatalog();

  // 目录就绪后把空工具集初始化为安全最小集（用户已手动改过则不覆盖）
  useEffect(() => {
    if (!catalog) return;
    setCaps((cur) =>
      cur.tools.length === 0
        ? { tools: [...catalog.safeMinimum], mcps: [], skills: [] }
        : cur,
    );
  }, [catalog]);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!name.trim()) {
      setError('名称不能为空');
      return;
    }
    if (!providerId || !modelName.trim()) {
      setError('请选择模型供应商与模型');
      return;
    }
    if (source === 'agentView' && !workspace) {
      setError('无激活工作空间，无法加入成员');
      return;
    }
    const tools =
      preset === 'standard'
        ? (catalog?.safeMinimum ?? [])
        : preset === 'all'
          ? (catalog?.allTools ?? [])
          : caps.tools;
    // catalog 未就绪时禁止提交（标准/全部档依赖目录数据）
    if (preset !== 'custom' && !catalog) {
      setError('工具目录加载中，请稍候再提交');
      return;
    }
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
        thinkingJson,
        defaultTools: tools.map((ref) => ({ kind: 'builtin' as const, ref })),
        defaultMcps: caps.mcps.map((ref) => ({ kind: 'mcp' as const, ref })),
        defaultSkills: caps.skills.map((ref) => ({ kind: 'skill' as const, ref })),
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
            <div className="flex flex-col gap-2 pl-1 pt-1">
              {catalogError && (
                <div className="text-xs text-status-error">工具目录加载失败：{catalogError}</div>
              )}
              <CapabilityTabs mode="edit" value={caps} onChange={setCaps} />
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
