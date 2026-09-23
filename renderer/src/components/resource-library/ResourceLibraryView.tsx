// renderer/src/components/resource-library/ResourceLibraryView.tsx
// 资源库壳（spec §2.1 重设计）：TypeSidebar（Agent/MCP/Skill 二级菜单）+ TypePageShell。
// 弹窗开关全部集中在本层；agent 专属回调和 preset/edit 逻辑自旧单页 View 平移。
// Task 10/12/13 接线三个新弹窗；Task 14 新建智能体入口已替换为 AgentCreateWizard。
import { useEffect, useState } from 'react';
import { useResourceStore } from '../../stores/resource.store';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { ipc } from '../../ipc/client';
import { TypeSidebar } from './TypeSidebar';
import { TypePageShell } from './TypePageShell';
import type { AddMenuItem } from './AddMenu';
import { RegisterMcpDialog } from '../agent/RegisterMcpDialog';
import { UploadSkillDialog } from '../agent/UploadSkillDialog';
import { AgentCreateWizard } from './wizard/AgentCreateWizard';
import { DefinitionEditor } from '../agent/DefinitionEditor';
import { EnablePresetDialog } from '../agent/EnablePresetDialog';
import { McpJsonPasteDialog } from './McpJsonPasteDialog';
import { McpConnectDialog } from './McpConnectDialog';
import { ImportBundleDialog } from './ImportBundleDialog';
import { SkillCreateDialog } from './SkillCreateDialog';
import { ImportAgentYamlDialog } from './ImportAgentYamlDialog';
import type { AgentDefinition, JsonSchemaLike, ResourceType } from '../../ipc/types';

export function ResourceLibraryView() {
  const { activeType, setActiveType, setMode, items, installResource, load } = useResourceStore();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const loadDefinitions = useAgentStore((s) => s.loadDefinitions);
  const loadMembers = useAgentStore((s) => s.loadMembers);
  // 弹窗开关（本层集中）
  const [registerMcpOpen, setRegisterMcpOpen] = useState(false);
  const [uploadSkillOpen, setUploadSkillOpen] = useState(false);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [importYamlOpen, setImportYamlOpen] = useState(false);
  const [mcpJsonOpen, setMcpJsonOpen] = useState(false);
  const [skillCreateOpen, setSkillCreateOpen] = useState(false);
  const [bundleOpen, setBundleOpen] = useState(false);
  // P2.1 Task 6：smithery needsConfig 连接配置目标（null = 弹窗关）
  const [connectTarget, setConnectTarget] = useState<{
    id: string;
    name: string;
    schema: JsonSchemaLike;
  } | null>(null);
  const [editingDef, setEditingDef] = useState<AgentDefinition | null>(null);
  const [presetTarget, setPresetTarget] = useState<{ slug: string; name: string; def?: AgentDefinition } | null>(null);

  // 冷启动首拉（旧视图同语义；后续刷新由 setActiveType/setSourceFilter/store 写操作触发）
  useEffect(() => {
    void load();
  }, [load]);

  // ── agent 专属回调（自旧 View 平移，逻辑不变）─────────────────────────
  const handleEditAgent = async (itemId: string): Promise<void> => {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    try {
      const defs = await ipc.agent.list();
      const def = defs.find((d) => d.source === 'custom' && d.id === item.slug);
      if (def) setEditingDef(def);
      else console.warn('未找到资源对应的 agent 定义', { itemId, slug: item.slug });
    } catch (err) {
      console.error('打开 agent 编辑失败', { itemId, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const openPresetDialog = async (itemId: string): Promise<void> => {
    const item = items.find((i) => i.id === itemId);
    if (!item || item.type !== 'agent') return;
    try {
      const defs = await ipc.agent.list();
      const def =
        item.source === 'builtin'
          ? (defs.find((d) => d.id === `builtin-${item.slug}`) ?? defs.find((d) => d.slug === item.slug))
          : defs.find((d) => d.slug === item.slug);
      setPresetTarget({ slug: item.slug, name: item.name, def });
    } catch (err) {
      console.error('打开预设 agent 配置失败', { itemId, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleInstall = async (itemId: string): Promise<void> => {
    const item = items.find((i) => i.id === itemId);
    const result = await installResource(itemId);
    // P2.1 Task 6：smithery needsConfig 两态——需补配置时弹连接配置弹窗（此前静默
    // 无反馈），待用户提交 installSmitheryRemote 后才完成安装；store 已约定此态
    // 不刷列表不设横幅，此处直接 return
    if (result && typeof result === 'object' && result.needsConfig && result.schema) {
      setConnectTarget({ id: itemId, name: item?.name ?? itemId, schema: result.schema });
      return;
    }
    // marketplace agent 安装成功 → 配置引导（def 刚落库需配模型；取消可稍后从「配置」再配）
    if (result && item?.type === 'agent' && item.source === 'marketplace') {
      await openPresetDialog(itemId);
    }
  };

  // smithery 连接配置提交：完成二段安装 → 刷新列表 → 「已连接」横幅。横幅复用既有
  // installNotice 机制，经 store 全局 setState 写入（与 installResource 成功路径同形，
  // 零新增 store API）；弹窗在 onSubmit 成功后自关（失败红字留在弹窗内由其自渲染）
  const handleConnectSubmit = async (config: Record<string, string>): Promise<void> => {
    if (!connectTarget) return;
    await ipc.resource.installSmitheryRemote(connectTarget.id, config);
    await load();
    useResourceStore.setState({ installNotice: `已连接：${connectTarget.name}` });
  };

  const closePresetDialog = (): void => {
    setPresetTarget(null);
    void load();
    void loadDefinitions(activeWorkspaceId ?? undefined);
    if (activeWorkspaceId) void loadMembers(activeWorkspaceId);
  };

  // ── 三类页的「＋」菜单（最后一条固定「从网络获取」）───────────────────
  const addItemsFor = (type: ResourceType): AddMenuItem[] => {
    if (type === 'agent') {
      return [
        { key: 'wizard', title: '新建智能体…', hint: '分步向导：基础信息 → 提示词 → 能力 → 模型', onSelect: () => setCreateAgentOpen(true) },
        { key: 'import-yaml', title: '导入 YAML 文件…', hint: 'manifest 格式，校验后注册为自定义 agent', onSelect: () => setImportYamlOpen(true) },
        { key: 'registry', title: '从网络获取…', hint: '浏览注册表（内置市场）', onSelect: () => setMode('registry') },
      ];
    }
    if (type === 'mcp') {
      return [
        { key: 'form', title: '手动配置…', hint: '名称 / 命令 / 参数 / 环境变量（高级项默认折叠）', onSelect: () => setRegisterMcpOpen(true) },
        { key: 'json', title: '粘贴 JSON…', hint: 'mcpServers 格式，支持一次导入多条', onSelect: () => setMcpJsonOpen(true) },
        { key: 'import-bundle', title: '导入 DXT / MCPB 包', hint: '本地 .dxt / .mcpb 文件', onSelect: () => setBundleOpen(true) },
        { key: 'registry', title: '从网络获取…', hint: '浏览注册表（内置市场）', onSelect: () => setMode('registry') },
      ];
    }
    return [
      { key: 'zip', title: '导入 zip 包…', hint: '拖放或选择文件（SKILL.md 打包）', onSelect: () => setUploadSkillOpen(true) },
      { key: 'create', title: '新建 SKILL.md…', hint: 'frontmatter（name/description）+ Markdown 正文', onSelect: () => setSkillCreateOpen(true) },
      { key: 'registry', title: '从网络获取…', hint: '浏览注册表（内置市场）', onSelect: () => setMode('registry') },
    ];
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      <TypeSidebar activeType={activeType} onSelect={setActiveType} />
      <TypePageShell
        type={activeType}
        addItems={addItemsFor(activeType)}
        onInstall={handleInstall}
        onEditAgent={handleEditAgent}
        onOpenPreset={openPresetDialog}
      />

      {/* 弹窗组（Task 10/12/13 的新弹窗接线后追加在此） */}
      {registerMcpOpen && (
        <RegisterMcpDialog onClose={() => setRegisterMcpOpen(false)} onSuccess={() => { setRegisterMcpOpen(false); void load(); }} />
      )}
      {mcpJsonOpen && (
        <McpJsonPasteDialog onClose={() => setMcpJsonOpen(false)} onSuccess={() => void load()} />
      )}
      {/* P2.1 Task 6：smithery 连接配置 + DXT/MCPB 本地包导入 */}
      {connectTarget && (
        <McpConnectDialog
          serverName={connectTarget.name}
          schema={connectTarget.schema}
          onSubmit={handleConnectSubmit}
          onClose={() => setConnectTarget(null)}
        />
      )}
      {bundleOpen && (
        <ImportBundleDialog onClose={() => setBundleOpen(false)} onSuccess={() => void load()} />
      )}
      {uploadSkillOpen && (
        <UploadSkillDialog onClose={() => setUploadSkillOpen(false)} onSuccess={() => void load()} />
      )}
      {skillCreateOpen && (
        <SkillCreateDialog onClose={() => setSkillCreateOpen(false)} onSuccess={() => void load()} />
      )}
      {importYamlOpen && (
        <ImportAgentYamlDialog onClose={() => setImportYamlOpen(false)} onSuccess={() => void load()} />
      )}
      {createAgentOpen && (
        <AgentCreateWizard onClose={() => { setCreateAgentOpen(false); void load(); }} onSuccess={() => void load()} />
      )}
      {editingDef && (
        <DefinitionEditor mode="edit" def={editingDef} onClose={() => { setEditingDef(null); void load(); }} />
      )}
      {presetTarget && (
        <EnablePresetDialog slug={presetTarget.slug} name={presetTarget.name} def={presetTarget.def} onClose={closePresetDialog} />
      )}
    </div>
  );
}
