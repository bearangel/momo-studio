// renderer/src/components/resource-library/ResourceLibraryView.tsx
//
// v1.7 Task 9：资源库主视图。布局为「左主网格 + 右详情面板（条件渲染）+ 三类弹窗」。
//
// 关键设计：
//   - 双层 tab：第一行 4 个 type tab（全部/Agent/MCP/Skill），第二行 5 个 source tab
//     （全部/系统预置/我的上传/网络资源/P2P 共享）。两层 AND：filter = { type?, source? }
//   - 搜索：前端 in-memory filter（name/description/slug 模糊匹配），无 IPC
//   - 主网格：filteredItems 渲染为 ResourceCard 列表（grid auto-fill 220px）
//   - 选中卡片 → 右侧 ResourceDetail 滑出（条件渲染，selectedId 找不到则收起）
//   - 三类弹窗（RegisterMcpDialog / UploadSkillDialog / DefinitionEditor）由
//     AddResourceMenu 触发；前两者 onSuccess → load() 刷新 + 关弹窗
//   - 导入反馈：store installResource 成功后设置 installNotice（一次性绿色横幅），
//     store installResource 失败后设置 error（红色横幅覆盖主网格区）。view 端只读渲染。
//   - useEffect 依赖 [load, typeFilter, sourceFilter] —— filter 变化时自动 load；
//     setTypeFilter/setSourceFilter 也会主动 load（双保险）
import { useEffect, useState } from 'react';
import { useResourceStore } from '../../stores/resource.store';
import { Input } from '../ui/Input';
import { cn } from '../../lib/cn';
import { ResourceCard } from './ResourceCard';
import { ResourceDetail } from './ResourceDetail';
import { AddResourceMenu } from './AddResourceMenu';
import { RegisterMcpDialog } from '../agent/RegisterMcpDialog';
import { UploadSkillDialog } from '../agent/UploadSkillDialog';
import { DefinitionEditor } from '../agent/DefinitionEditor';
import type { ResourceItem, ResourceFilter } from '../../ipc/types';

/** 第一行：type tab（全部 / Agent / MCP / Skill） */
const TYPE_TABS: Array<{ key: ResourceFilter['type'] | 'all'; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'agent', label: 'Agent' },
  { key: 'mcp', label: 'MCP' },
  { key: 'skill', label: 'Skill' },
];

/** 第二行：source tab（全部 / 系统预置 / 我的上传 / 网络资源 / P2P 共享——P4 启用） */
const SOURCE_TABS: Array<{ key: ResourceFilter['source'] | 'all'; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'builtin', label: '系统预置' },
  { key: 'custom', label: '我的上传' },
  { key: 'marketplace', label: '网络资源' },
  { key: 'p2p', label: 'P2P 共享' },
];

export function ResourceLibraryView() {
  const {
    items,
    loading,
    error,
    installNotice,
    typeFilter,
    sourceFilter,
    query,
    load,
    setTypeFilter,
    setSourceFilter,
    setQuery,
    deleteResource,
    installResource,
  } = useResourceStore();

  // 当前选中的资源 id（null = 详情面板收起）
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 三类添加资源弹窗开关
  const [registerMcpOpen, setRegisterMcpOpen] = useState(false);
  const [uploadSkillOpen, setUploadSkillOpen] = useState(false);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);

  // filter 变化时自动 load（mount 时 typeFilter/sourceFilter 均为 'all'，触发首次拉取）
  useEffect(() => {
    void load();
  }, [load, typeFilter, sourceFilter]);

  // 详情面板数据：从 items 里查 selectedId（删除后 items 更新可能让 selected 失效 → 自动收起）
  const selected: ResourceItem | undefined = selectedId
    ? items.find((i) => i.id === selectedId)
    : undefined;

  // 前端搜索过滤（按 name / description / slug 模糊匹配，case-insensitive）
  const q = query.trim().toLowerCase();
  const filteredItems = q
    ? items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          i.slug.toLowerCase().includes(q),
      )
    : items;

  return (
    <div className="flex-1 flex overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header：标题 + 添加按钮 + 搜索框 */}
        <div className="px-4 py-3 border-b border-border-subtle flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-neutral-200">📚 资源库</h2>
            <div className="flex items-center gap-2">
              <AddResourceMenu
                onCreateAgent={() => setCreateAgentOpen(true)}
                onRegisterMcp={() => setRegisterMcpOpen(true)}
                onUploadSkill={() => setUploadSkillOpen(true)}
              />
              <div className="w-64">
                <Input
                  placeholder="搜索 agent / mcp / skill…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* 双层 tab 行 */}
          <div className="flex flex-col gap-1">
            {/* type 行 */}
            <div className="flex gap-1">
              <span className="text-xs text-neutral-500 mr-2 self-center">类型</span>
              {TYPE_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
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
            {/* source 行 */}
            <div className="flex gap-1">
              <span className="text-xs text-neutral-500 mr-2 self-center">来源</span>
              {SOURCE_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className={cn(
                    'text-xs px-2.5 py-1 rounded-md transition-colors',
                    sourceFilter === tab.key
                      ? 'bg-purple-500 text-white'
                      : 'text-neutral-400 hover:bg-bg-tertiary',
                  )}
                  onClick={() => setSourceFilter(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 主网格区 */}
        <div className="flex-1 overflow-auto p-4">
          {/* 导入成功一次性横幅——store filter 切换时清掉（保持简单：自然过期，不挂 setTimeout） */}
          {installNotice && (
            <div
              data-testid="install-notice"
              className="mb-3 px-3 py-2 rounded-md bg-green-500/15 text-green-300 text-sm border border-green-500/30"
            >
              ✓ {installNotice}
            </div>
          )}
          {error ? (
            <div className="text-center text-status-error text-sm py-8">
              加载失败：{error}
            </div>
          ) : loading && items.length === 0 ? (
            <div className="text-center text-neutral-500 text-sm py-8">加载中…</div>
          ) : filteredItems.length === 0 ? (
            <div className="text-center text-neutral-500 text-sm py-8">
              <div className="text-3xl mb-2">📚</div>
              <p>
                没有匹配的资源。
                {sourceFilter === 'custom' && '点击右上角「+ 添加资源」上传'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {filteredItems.map((item) => (
                <ResourceCard
                  key={item.id}
                  item={item}
                  selected={selectedId === item.id}
                  onSelect={setSelectedId}
                  onInstall={installResource}
                  onDelete={deleteResource}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 右侧详情面板（条件渲染） */}
      {selected && (
        <ResourceDetail
          item={selected}
          onClose={() => setSelectedId(null)}
          onInstall={installResource}
          onDelete={deleteResource}
        />
      )}

      {/* 三类添加资源弹窗 */}
      {registerMcpOpen && (
        <RegisterMcpDialog
          onClose={() => setRegisterMcpOpen(false)}
          onSuccess={() => {
            setRegisterMcpOpen(false);
            void load();
          }}
        />
      )}
      {uploadSkillOpen && (
        <UploadSkillDialog
          onClose={() => setUploadSkillOpen(false)}
          onSuccess={() => {
            setUploadSkillOpen(false);
            void load();
          }}
        />
      )}
      {createAgentOpen && (
        <DefinitionEditor mode="create" onClose={() => setCreateAgentOpen(false)} />
      )}
    </div>
  );
}
