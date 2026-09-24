// renderer/src/components/resource-library/ResourceLibraryView.tsx
// 资源库壳（spec §2.1 重设计）：TypeSidebar（Agent/MCP/Skill 二级菜单）+ TypePageShell。
// 弹窗开关全部集中在本层；agent 专属回调和 preset/edit 逻辑自旧单页 View 平移。
// Task 10/12/13 接线三个新弹窗；Task 14 新建智能体入口已替换为 AgentCreateWizard。
// P2.3 Task 1：移除网络获取模式接线（registry 安装流 / smithery 连接配置弹窗）。
// P2.3 Task 4：AddMenu「启用预置库」入口（仅 agent 分支）→ PresetLibraryDialog →
// 选中 slug 复用 presetTarget/EnablePresetDialog 保留位完成启用即配。
import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
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
import { McpConfigDialog } from './McpConfigDialog';
import { McpJsonPasteDialog } from './McpJsonPasteDialog';
import { ImportBundleDialog } from './ImportBundleDialog';
import { SkillCreateDialog } from './SkillCreateDialog';
import { ImportAgentYamlDialog } from './ImportAgentYamlDialog';
import { PresetLibraryDialog } from './PresetLibraryDialog';
import type { AgentDefinition, McpConfigUpdateInput, ResourceItem, ResourceType } from '../../ipc/types';

export function ResourceLibraryView() {
  const { activeType, setActiveType, items, installResource, load } = useResourceStore();
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
  const [editingDef, setEditingDef] = useState<AgentDefinition | null>(null);
  const [presetTarget, setPresetTarget] = useState<{ slug: string; name: string; def?: AgentDefinition } | null>(null);
  // P2.3 Task 4：预置库弹窗开关（入口仅 agent 页组装）
  const [presetLibraryOpen, setPresetLibraryOpen] = useState(false);
  // P2.2 Task 7：远程 MCP 配置编辑目标（null = 弹窗关）。name 是 MCP 定义名
  // （ResourceItem.slug），displayName 是展示名——getMcpConfig/updateMcpConfig
  // 入参走 name（spec §6.2），弹窗标题用 displayName。
  const [configTarget, setConfigTarget] = useState<{ name: string; displayName: string } | null>(null);
  // P2.5：MCP 全字段编辑目标（null = 弹窗关）。值为 MCP 定义名（ResourceItem.slug）
  const [mcpEditTarget, setMcpEditTarget] = useState<string | null>(null);

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

  // P2.3 Task 4：预置库选中 slug → 打开 EnablePresetDialog（复用 presetTarget 挂载位）。
  // def 反查与 openPresetDialog 同形状（builtin-<slug> 优先、slug 兜底——启用链
  // enablePresetDef 落库 id 即 builtin-<slug>）；展示名优先 store 同 slug builtin
  // 清单项（catalog 是展示名权威）、退 def 名、退 slug——不依赖 catalog 必含该预置。
  const openPresetBySlug = async (slug: string): Promise<void> => {
    try {
      const defs = await ipc.agent.list();
      const def = defs.find((d) => d.id === `builtin-${slug}`) ?? defs.find((d) => d.slug === slug);
      const name =
        items.find((i) => i.type === 'agent' && i.source === 'builtin' && i.slug === slug)?.name ??
        def?.name ??
        slug;
      setPresetTarget({ slug, name, def });
    } catch (err) {
      console.error('打开预设 agent 配置失败', { slug, error: err instanceof Error ? err.message : String(err) });
    }
  };

  // 本地安装流（installed 列表 installable 项——p2p 导入）：直连 store.installResource，
  // 错误与成功横幅均由 store 落位（P2.3 Task 1 起 registry 安装包装流已移除）
  const handleInstall = (itemId: string): void => {
    void installResource(itemId);
  };

  const closePresetDialog = (): void => {
    setPresetTarget(null);
    void load();
    void loadDefinitions(activeWorkspaceId ?? undefined);
    if (activeWorkspaceId) void loadMembers(activeWorkspaceId);
  };

  // P2.2 Task 7：远程 MCP 配置编辑。ResourceDetail「配置」按钮触发——
  // 透传整 item（item.slug 作为 MCP 定义名供 getMcpConfig/updateMcpConfig）。
  const handleEditMcpConfig = (item: ResourceItem): void => {
    setConfigTarget({ name: item.slug, displayName: item.name });
  };

  // 配置编辑提交：updateMcpConfig 写盘 → load 刷新（headers/查询参数变化
  // 不改 installedAt，但 ResourceItem 字段不变，主要靠下一轮 list 拿新元数据）→
  // 「已更新」横幅走 installNotice 机制。失败由 McpConfigDialog 自渲染红字。
  const handleMcpConfigSubmit = async (input: McpConfigUpdateInput): Promise<void> => {
    if (!configTarget) return;
    await ipc.resource.updateMcpConfig(configTarget.name, input);
    await load();
    useResourceStore.setState({ installNotice: `配置已更新：${configTarget.displayName}` });
  };

  // ── 三类页的「＋」菜单（本地导入单态；P2.3 Task 1 移除「从网络获取」项）───
  const addItemsFor = (type: ResourceType): AddMenuItem[] => {
    if (type === 'agent') {
      return [
        { key: 'wizard', title: '新建智能体…', hint: '分步向导：基础信息 → 提示词 → 能力 → 模型', onSelect: () => setCreateAgentOpen(true) },
        { key: 'import-yaml', title: '导入 YAML 文件…', hint: 'manifest 格式，校验后注册为自定义 agent', onSelect: () => setImportYamlOpen(true) },
        // 预置库入口仅 agent 页（Task 0 裁定：只有 agent 有启用管线）
        { key: 'preset-library', title: '启用预置库', hint: '从内置预设清单选择 agent，配置模型后启用', icon: Sparkles, onSelect: () => setPresetLibraryOpen(true) },
      ];
    }
    if (type === 'mcp') {
      return [
        { key: 'form', title: '快速创建…', hint: '本地 stdio / 远程 HTTP，名称命令或 URL', onSelect: () => setRegisterMcpOpen(true) },
        { key: 'json', title: '导入 JSON…', hint: 'mcpServers / VS Code servers 格式，支持一次导入多条', onSelect: () => setMcpJsonOpen(true) },
        { key: 'import-bundle', title: '导入 DXT / MCPB 包', hint: '本地 .dxt / .mcpb 文件', onSelect: () => setBundleOpen(true) },
      ];
    }
    return [
      { key: 'zip', title: '导入 zip 包…', hint: '拖放或选择文件（SKILL.md 打包）', onSelect: () => setUploadSkillOpen(true) },
      { key: 'create', title: '新建 SKILL.md…', hint: 'frontmatter（name/description）+ Markdown 正文', onSelect: () => setSkillCreateOpen(true) },
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
        onEditMcpConfig={handleEditMcpConfig}
        onEditMcpEntry={(item) => setMcpEditTarget(item.slug)}
      />

      {/* 弹窗组（Task 10/12/13 的新弹窗接线后追加在此） */}
      {registerMcpOpen && (
        <RegisterMcpDialog onClose={() => setRegisterMcpOpen(false)} onSuccess={() => { setRegisterMcpOpen(false); void load(); }} />
      )}
      {mcpJsonOpen && (
        <McpJsonPasteDialog onClose={() => setMcpJsonOpen(false)} onSuccess={() => void load()} />
      )}
      {/* DXT/MCPB 本地包导入（P2.1 Task 6） */}
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
      {/* P2.3 Task 4：预置库弹窗（选中 slug → 关预置库 → 复用 presetTarget 打开 EnablePresetDialog） */}
      {presetLibraryOpen && (
        <PresetLibraryDialog
          type={activeType}
          onSelect={(slug) => {
            setPresetLibraryOpen(false);
            void openPresetBySlug(slug);
          }}
          onClose={() => setPresetLibraryOpen(false)}
        />
      )}
      {/* P2.5 Task 3：MCP 全字段编辑弹窗（RegisterMcpDialog edit 模式，mount 拉 getMcpEditView 预填） */}
      {mcpEditTarget && (
        <RegisterMcpDialog
          edit={{ name: mcpEditTarget }}
          onClose={() => setMcpEditTarget(null)}
          onSuccess={() => { setMcpEditTarget(null); void load(); }}
        />
      )}
      {/* P2.2 Task 7：远程 MCP 配置编辑弹窗（McpConfigDialog mount 拉 getMcpConfig） */}
      {configTarget && (
        <McpConfigDialog
          name={configTarget.name}
          serverName={configTarget.displayName}
          onSubmit={handleMcpConfigSubmit}
          onClose={() => setConfigTarget(null)}
        />
      )}
    </div>
  );
}
