// renderer/src/components/resource-library/ResourceLibraryView.tsx
// 资源库壳（spec §2.1 重设计）：TypeSidebar（Agent/MCP/Skill 二级菜单）+ TypePageShell。
// 弹窗开关全部集中在本层；agent 专属回调和 preset/edit 逻辑自旧单页 View 平移。
// Task 10/12/13 接线三个新弹窗；Task 14 新建智能体入口已替换为 AgentCreateWizard。
// P2.3 Task 1：移除网络获取模式接线（registry 安装流 / smithery 连接配置弹窗）。
// 「启用预置库」入口已删（与列表行「启用」完全重复：同起点同终点 EnablePresetDialog，
// 且 catalog 与 YAML 双源有漂移风险）——预置启用走列表行/详情面板，批量启用走 onboarding。
import { useEffect, useState } from 'react';
import { useResourceStore } from '../../stores/resource.store';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSessionStore } from '../../stores/session.store';
import { ipc } from '../../ipc/client';
import { TypeSidebar } from './TypeSidebar';
import { TypePageShell, buildImpactMessage } from './TypePageShell';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import type { AddMenuItem } from './AddMenu';
import { RegisterMcpDialog } from '../agent/RegisterMcpDialog';
import { UploadSkillDialog } from '../agent/UploadSkillDialog';
import { AgentCreateWizard } from '../agent/AgentCreateWizard';
import { DefinitionEditor } from '../agent/DefinitionEditor';
import { EnablePresetDialog } from '../agent/EnablePresetDialog';
import { McpConfigDialog } from './McpConfigDialog';
import { McpJsonPasteDialog } from './McpJsonPasteDialog';
import { ImportBundleDialog } from './ImportBundleDialog';
import { SkillCreateDialog } from './SkillCreateDialog';
import { ImportAgentYamlDialog } from './ImportAgentYamlDialog';
import { GitImportDialog } from './GitImportDialog';
import { InstallPluginZipDialog } from './InstallPluginZipDialog';
import { RegisterPluginDirDialog } from './RegisterPluginDirDialog';
import type { AgentDefinition, BuiltinPresetPreview, DefinitionImpact, McpConfigUpdateInput, ResourceItem, ResourceType } from '../../ipc/types';

export function ResourceLibraryView() {
  const { activeType, setActiveType, items, installResource, load, setMcpEnabled, setPluginEnabled } = useResourceStore();
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
  // P2.6 Task 3：Git 仓库导入弹窗开关（入口仅 skill 页组装）
  const [gitImportOpen, setGitImportOpen] = useState(false);
  // 插件系统 P1（spec 2026-10-15）：zip 安装 / dev 目录注册弹窗开关
  const [pluginZipOpen, setPluginZipOpen] = useState(false);
  const [pluginDevOpen, setPluginDevOpen] = useState(false);
  // P2.2 Task 7：远程 MCP 配置编辑目标（null = 弹窗关）。name 是 MCP 定义名
  // （ResourceItem.slug），displayName 是展示名——getMcpConfig/updateMcpConfig
  // 入参走 name（spec §6.2），弹窗标题用 displayName。
  const [configTarget, setConfigTarget] = useState<{ name: string; displayName: string } | null>(null);
  // P2.5：MCP 全字段编辑目标（null = 弹窗关）。值为 MCP 定义名（ResourceItem.slug）
  const [mcpEditTarget, setMcpEditTarget] = useState<string | null>(null);
  // 2026-10-08 薄 fork：预置能力预览 → AgentCreateWizard 预填种子（null = 非 fork 模式）
  const [forkSeed, setForkSeed] = useState<BuiltinPresetPreview | null>(null);
  // 停用确认目标（2026-10-10 披露式级联；impact null = 预查失败回落通用文案）
  const [disableTarget, setDisableTarget] = useState<{
    defId: string;
    name: string;
    impact: DefinitionImpact | null;
  } | null>(null);

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

  // 2026-10-08 薄 fork：预置能力预览 → 预填创建向导（source='library' 语义——仅建全局
  // 定义；名称自动加「 副本」，模型留给用户选）。
  const handleForkPreset = (preview: BuiltinPresetPreview): void => {
    setForkSeed(preview);
    setCreateAgentOpen(true);
  };

  // 停用预设（2026-10-10 披露式级联）：详情页「停用」→ 影响面预查 → 确认框披露 →
  // disablePreset 级联（回到未启用态，可随时重新启用）。预查失败不阻断——回落通用文案
  const handleDisablePreset = (itemId: string): void => {
    const item = items.find((i) => i.id === itemId);
    if (!item || item.type !== 'agent' || item.source !== 'builtin') return;
    const defId = `builtin-${item.slug}`;
    void ipc.agent
      .definitionImpact(defId)
      .then((impact) => setDisableTarget({ defId, name: item.name, impact }))
      .catch(() => setDisableTarget({ defId, name: item.name, impact: null }));
  };

  const confirmDisablePreset = (): void => {
    if (!disableTarget) return;
    const { defId, name } = disableTarget;
    void ipc.agent
      .disablePreset(defId)
      .then(() => {
        useResourceStore.setState({ installNotice: `已停用「${name}」，可随时重新启用` });
        void load();
        void loadDefinitions(activeWorkspaceId ?? undefined);
        if (activeWorkspaceId) void loadMembers(activeWorkspaceId);
        // 停用级联可能清空会话成员 → 主动刷新会话列表与激活会话成员
        // （activeSessionReadOnly 三层判定的 loadMembers 权威层；不发消息即只读）
        refreshActiveSessionMembers();
      })
      .catch((err: unknown) => {
        useResourceStore.setState({
          error: `停用失败：${err instanceof Error ? err.message : String(err)}`,
        });
      });
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

  /** agent 级联（删除/停用）后刷新会话面：列表 summaries + 激活会话成员（readOnly 权威重算） */
  const refreshActiveSessionMembers = (): void => {
    const ss = useSessionStore.getState();
    ss.pullSessionList();
    if (ss.activeSessionId) void ss.loadMembers(ss.activeSessionId);
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
      ];
    }
    if (type === 'mcp') {
      return [
        { key: 'form', title: '快速创建…', hint: '本地 stdio / 远程 HTTP，名称命令或 URL', onSelect: () => setRegisterMcpOpen(true) },
        { key: 'json', title: '导入 JSON…', hint: 'mcpServers / VS Code servers 格式，支持一次导入多条', onSelect: () => setMcpJsonOpen(true) },
        { key: 'import-bundle', title: '导入 DXT / MCPB 包', hint: '本地 .dxt / .mcpb 文件', onSelect: () => setBundleOpen(true) },
      ];
    }
    if (type === 'plugin') {
      return [
        { key: 'zip', title: '安装插件 zip…', hint: '校验 momo-plugin.json 后落位注册', onSelect: () => setPluginZipOpen(true) },
        { key: 'dev', title: '注册开发目录…', hint: '指向本地源码目录，改码后重载生效', onSelect: () => setPluginDevOpen(true) },
      ];
    }
    return [
      { key: 'zip', title: '导入 zip 包…', hint: '拖放或选择文件（SKILL.md 打包）', onSelect: () => setUploadSkillOpen(true) },
      { key: 'create', title: '新建 SKILL.md…', hint: 'frontmatter（name/description）+ Markdown 正文', onSelect: () => setSkillCreateOpen(true) },
      // P2.6 Task 3：Git 仓库导入（下载 zip 归档自动发现全部 SKILL.md，两阶段确认）
      { key: 'git-import', title: '从 Git 仓库导入…', hint: 'GitHub / GitLab 地址，自动发现全部 SKILL.md', onSelect: () => setGitImportOpen(true) },
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
          onToggleMcp={(item, next) => void setMcpEnabled(item.slug, next)}
          onTogglePlugin={(item, next) => {
            if (activeWorkspaceId) void setPluginEnabled(item.slug, activeWorkspaceId, next);
          }}
          onReloadPlugin={(item) => {
            void ipc.plugin
              .reload(item.slug)
              .then((s) => {
                useResourceStore.setState({
                  installNotice: `已重载「${s.name}」（v${s.version}，受影响的运行实例已重建）`,
                });
                void load();
              })
              .catch((err: unknown) => {
                useResourceStore.setState({
                  error: `重载失败：${err instanceof Error ? err.message : String(err)}`,
                });
              });
          }}
        onForkPreset={handleForkPreset}
        onDisableAgent={handleDisablePreset}
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
      {/* P2.6 Task 3：Git 仓库导入弹窗（扫描 → 预览 → 确认导入，弹窗内部自治） */}
      {gitImportOpen && (
        <GitImportDialog onClose={() => setGitImportOpen(false)} onSuccess={() => void load()} />
      )}
      {/* 插件系统 P1（spec 2026-10-15）：zip 安装 / dev 目录注册弹窗（成功即关，
          反馈走 installNotice 横幅——冒烟修复） */}
      {pluginZipOpen && (
        <InstallPluginZipDialog
          onClose={() => setPluginZipOpen(false)}
          onSuccess={(s) => {
            useResourceStore.setState({
              installNotice: `已安装插件「${s.name}」（v${s.version}，组件 ${s.components.length} 项）`,
            });
            void load();
          }}
        />
      )}
      {pluginDevOpen && (
        <RegisterPluginDirDialog
          onClose={() => setPluginDevOpen(false)}
          onSuccess={(s) => {
            useResourceStore.setState({ installNotice: `已注册插件「${s.name}」（dev 源 v${s.version}）` });
            void load();
          }}
        />
      )}
      {importYamlOpen && (
        <ImportAgentYamlDialog onClose={() => setImportYamlOpen(false)} onSuccess={() => void load()} />
      )}
      {createAgentOpen && (
        <AgentCreateWizard
          initialDef={forkSeed ?? undefined}
          onClose={() => { setCreateAgentOpen(false); setForkSeed(null); void load(); }}
          onSuccess={() => void load()}
        />
      )}
      {editingDef && (
        <DefinitionEditor mode="edit" def={editingDef} onClose={() => { setEditingDef(null); void load(); }} />
      )}
      {presetTarget && (
        <EnablePresetDialog slug={presetTarget.slug} name={presetTarget.name} def={presetTarget.def} onClose={closePresetDialog} />
      )}
      {/* 停用确认（2026-10-10 披露式级联）：影响面逐条披露后才可确认 */}
      {disableTarget && (
        <ConfirmDialog
          title={`停用 ${disableTarget.name}？`}
          message={
            disableTarget.impact
              ? buildImpactMessage('停用后该预设回到未启用状态，可随时重新启用。将同时：', disableTarget.impact)
              : '停用后该预设回到未启用状态，可随时重新启用。'
          }
          confirmLabel="停用"
          onConfirm={confirmDisablePreset}
          onClose={() => setDisableTarget(null)}
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
