// renderer/src/components/resource-library/ResourceLibraryView.tsx
// 资源库壳（spec §2.1 重设计）：TypeSidebar（Agent/MCP/Skill 二级菜单）+ TypePageShell。
// 弹窗开关全部集中在本层；agent 专属回调和 preset/edit 逻辑自旧单页 View 平移。
// Task 10/12/13 接线三个新弹窗；Task 14 起向导替换 CreateAgentDialog。
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
import { CreateAgentDialog } from '../agent/CreateAgentDialog';
import { DefinitionEditor } from '../agent/DefinitionEditor';
import { EnablePresetDialog } from '../agent/EnablePresetDialog';
import { McpJsonPasteDialog } from './McpJsonPasteDialog';
import { SkillCreateDialog } from './SkillCreateDialog';
import type { AgentDefinition, ResourceType } from '../../ipc/types';

export function ResourceLibraryView() {
  const { activeType, setActiveType, setMode, items, installResource, load } = useResourceStore();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const loadDefinitions = useAgentStore((s) => s.loadDefinitions);
  const loadMembers = useAgentStore((s) => s.loadMembers);
  // 弹窗开关（本层集中）
  const [registerMcpOpen, setRegisterMcpOpen] = useState(false);
  const [uploadSkillOpen, setUploadSkillOpen] = useState(false);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  // Task 13/14 接线新弹窗前暂无读取方——值加 '_' 前缀过 no-unused-vars（接线时去前缀）
  const [_importYamlOpen, setImportYamlOpen] = useState(false);
  const [mcpJsonOpen, setMcpJsonOpen] = useState(false);
  const [skillCreateOpen, setSkillCreateOpen] = useState(false);
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
    const ok = await installResource(itemId);
    // marketplace agent 安装成功 → 配置引导（def 刚落库需配模型；取消可稍后从「配置」再配）
    if (ok && item?.type === 'agent' && item.source === 'marketplace') {
      await openPresetDialog(itemId);
    }
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
      {uploadSkillOpen && (
        <UploadSkillDialog onClose={() => setUploadSkillOpen(false)} onSuccess={() => void load()} />
      )}
      {skillCreateOpen && (
        <SkillCreateDialog onClose={() => setSkillCreateOpen(false)} onSuccess={() => void load()} />
      )}
      {createAgentOpen && (
        <CreateAgentDialog source="library" onClose={() => { setCreateAgentOpen(false); void load(); }} />
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
