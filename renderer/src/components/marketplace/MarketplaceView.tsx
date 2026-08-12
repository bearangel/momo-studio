// Marketplace 主视图：搜索栏 + 类型 tabs（全部/Agent/MCP/Skill）+ 卡片网格 + 右侧详情。
// 进入视图时自动 loadCatalog；搜索/类型切换纯前端过滤（store.setQuery / setTypeFilter）。
// 选中卡片 → 右侧 ItemDetail 展开；再次点击或点关闭收起。
//
// v1.6 Task 15：
//   - 顶部 header 新增「+ 添加 MCP」「+ 上传 Skill」按钮，分别打开 RegisterMcpDialog / UploadSkillDialog
//   - 弹窗 onSuccess → 三重刷新（catalog + listRegistered + listInstalled）
//   - 底部新增「已注册的自定义资源」折叠区（<details>）：
//       MCP 区：列 ipc.mcp.listRegistered()，source==='custom' 项可删（→ ipc.mcp.deleteRegistered）
//       Skill 区：列 ipc.skill.listInstalled()，source==='custom' 项可删（→ ipc.skill.deleteCustom）
//       marketplace / builtin 项展示但不可删
import { useEffect, useState } from 'react';
import { useMarketplaceStore, type TypeFilter } from '../../stores/marketplace.store';
import { ipc } from '../../ipc/client';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { cn } from '../../lib/cn';
import { ItemCard } from './ItemCard';
import { ItemDetail } from './ItemDetail';
import { RegisterMcpDialog } from '../agent/RegisterMcpDialog';
import { UploadSkillDialog } from '../agent/UploadSkillDialog';
import type {
  InstalledSkill,
  MarketplaceItem,
  RegisteredMcp,
} from '../../ipc/types';

/** 类型 tab 定义 */
const TYPE_TABS: Array<{ key: TypeFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'agent', label: 'Agent' },
  { key: 'mcp', label: 'MCP' },
  { key: 'skill', label: 'Skill' },
];

export function MarketplaceView() {
  const {
    items,
    installed,
    installing,
    typeFilter,
    query,
    loading,
    error,
    loadCatalog,
    setQuery,
    setTypeFilter,
    install,
    uninstall,
  } = useMarketplaceStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 顶部两个弹窗的开关
  const [registerMcpOpen, setRegisterMcpOpen] = useState(false);
  const [uploadSkillOpen, setUploadSkillOpen] = useState(false);
  // 底部自定义资源管理区数据
  const [registeredMcps, setRegisteredMcps] = useState<RegisteredMcp[]>([]);
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([]);

  /** 拉取自定义资源列表（MCP + Skill 并行）。错误打到 console——之前静默吞错让用户看不到 listInstalled 失败的真实原因。 */
  const refreshCustomResources = async (): Promise<void> => {
    try {
      const [mcps, skills] = await Promise.all([
        ipc.mcp.listRegistered(),
        ipc.skill.listInstalled(),
      ]);
      setRegisteredMcps(mcps);
      setInstalledSkills(skills);
    } catch (err) {
      console.error('[MarketplaceView] refreshCustomResources 失败', err);
    }
  };

  /** 弹窗 onSuccess：刷新 catalog + 自定义资源（三重刷新）。 */
  const handleDialogSuccess = async (): Promise<void> => {
    await Promise.all([loadCatalog(), refreshCustomResources()]);
  };

  // 进入视图加载 catalog + 自定义资源（store 内部幂等处理已安装列表）
  useEffect(() => {
    void loadCatalog();
    void refreshCustomResources();
  }, [loadCatalog]);

  /** 删除一个自定义 MCP：confirm → ipc.mcp.deleteRegistered → 刷新自定义资源。 */
  const handleDeleteMcp = async (name: string): Promise<void> => {
    if (!window.confirm(`确定删除自定义 MCP「${name}」？`)) return;
    try {
      await ipc.mcp.deleteRegistered(name);
      await refreshCustomResources();
    } catch (err) {
      // 失败也刷新一次（可能后端有部分变更）
      void refreshCustomResources();
      window.alert(`删除失败：${(err as Error).message}`);
    }
  };

  /** 删除一个自定义 Skill：confirm → ipc.skill.deleteCustom → 刷新自定义资源。 */
  const handleDeleteSkill = async (slug: string): Promise<void> => {
    if (!window.confirm(`确定删除自定义 Skill「${slug}」？`)) return;
    try {
      await ipc.skill.deleteCustom(slug);
      await refreshCustomResources();
    } catch (err) {
      void refreshCustomResources();
      window.alert(`删除失败：${(err as Error).message}`);
    }
  };

  const selected: MarketplaceItem | undefined = selectedId
    ? items.find((i) => i.id === selectedId) ??
      // 切换类型 tab 后选中项可能不在当前 items 内，从 catalog 兜底查找
      useMarketplaceStore.getState().catalog?.items.find((i) => i.id === selectedId)
    : undefined;

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* 左侧：搜索 + tabs + 网格 + 底部自定义资源区 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-border-subtle flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-neutral-200">Marketplace</h2>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRegisterMcpOpen(true)}
              >
                + 添加 MCP
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setUploadSkillOpen(true)}
              >
                + 上传 Skill
              </Button>
              <div className="w-64">
                <Input
                  placeholder="搜索 agent / mcp / skill…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </div>
          </div>
          <div className="flex gap-1">
            {TYPE_TABS.map((tab) => (
              <button
                key={tab.key}
                className={cn(
                  'text-xs px-2.5 py-1 rounded-md transition-colors',
                  typeFilter === tab.key
                    ? 'bg-accent-blue text-white'
                    : 'text-neutral-400 hover:bg-bg-tertiary',
                )}
                onClick={() => setTypeFilter(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {error ? (
            <div className="text-center text-status-error text-sm py-8">加载失败：{error}</div>
          ) : loading && items.length === 0 ? (
            <div className="text-center text-neutral-500 text-sm py-8">加载中…</div>
          ) : items.length === 0 ? (
            <div className="text-center text-neutral-500 text-sm py-8">
              <div className="text-3xl mb-2">🛒</div>
              <p>没有匹配的项。试试调整搜索关键词或类型。</p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {items.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  installed={installed[item.id]}
                  installing={installing[item.id]}
                  selected={selectedId === item.id}
                  onSelect={() => setSelectedId(selectedId === item.id ? null : item.id)}
                  onInstall={() => void install(item)}
                />
              ))}
            </div>
          )}
        </div>

        {/* 底部自定义资源管理区：v1.6.3 改为默认 open（之前折叠导致用户看不到上传的 skill）。custom 项可删，marketplace/builtin 仅展示。 */}
        <details open className="border-t border-border-subtle px-4 py-3">
          <summary className="text-sm text-neutral-300 cursor-pointer select-none">
            已注册的自定义资源（MCP {registeredMcps.length} · Skill {installedSkills.length}）
          </summary>
          <div className="mt-3 flex flex-col gap-4">
            <div>
              <div className="text-xs text-neutral-500 mb-1">MCP</div>
              {registeredMcps.length === 0 ? (
                <div className="text-xs text-neutral-600">暂无已注册 MCP</div>
              ) : (
                <div className="flex flex-col gap-1">
                  {registeredMcps.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between text-xs py-0.5"
                    >
                      <span className="text-neutral-300">
                        {m.name}{' '}
                        <span className="text-neutral-600">[{m.source}]</span>
                      </span>
                      {m.source === 'custom' && (
                        <button
                          className="text-red-400 hover:text-red-300 px-2 py-0.5 rounded"
                          aria-label={`删除 MCP ${m.name}`}
                          onClick={() => void handleDeleteMcp(m.name)}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="text-xs text-neutral-500 mb-1">Skill</div>
              {installedSkills.length === 0 ? (
                <div className="text-xs text-neutral-600">暂无已安装 Skill</div>
              ) : (
                <div className="flex flex-col gap-1">
                  {installedSkills.map((s) => (
                    <div
                      key={s.slug}
                      className="flex items-center justify-between text-xs py-0.5"
                    >
                      <span className="text-neutral-300">
                        {s.slug}{' '}
                        <span className="text-neutral-600">[{s.source}]</span>
                      </span>
                      {s.source === 'custom' && (
                        <button
                          className="text-red-400 hover:text-red-300 px-2 py-0.5 rounded"
                          aria-label={`删除 Skill ${s.slug}`}
                          onClick={() => void handleDeleteSkill(s.slug)}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </details>
      </div>

      {/* 右侧：详情 */}
      {selected && (
        <ItemDetail
          item={selected}
          installed={installed[selected.id]}
          installing={installing[selected.id]}
          onInstall={() => void install(selected)}
          onUninstall={() => void uninstall(selected.id)}
          onClose={() => setSelectedId(null)}
        />
      )}

      {/* v1.6 Task 15：自定义 MCP / Skill 注册弹窗 */}
      {registerMcpOpen && (
        <RegisterMcpDialog
          onClose={() => setRegisterMcpOpen(false)}
          onSuccess={() => void handleDialogSuccess()}
        />
      )}
      {uploadSkillOpen && (
        <UploadSkillDialog
          onClose={() => setUploadSkillOpen(false)}
          onSuccess={() => void handleDialogSuccess()}
        />
      )}
    </div>
  );
}
