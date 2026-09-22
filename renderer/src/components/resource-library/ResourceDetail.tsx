// renderer/src/components/resource-library/ResourceDetail.tsx
//
// 详情面板（右侧滑出）。按 source 分支显示不同字段：
//   - builtin/marketplace（含 catalog 元数据）: README + 作者 + 校验状态 + 下载地址
//   - custom MCP: command + args + env（KEY=*** 隐藏值）+ 上传时间
//   - custom Skill: frontmatter（name/version）+ 上传时间
//   - custom Agent: systemPromptHash + 上传时间
//   - p2p: 来源节点（peerName）——「导入」按钮走 onInstall（安装后端为 P4 Task 5）
//
// 底部按钮区按 installed / installable / removable 三态切换：
//   - installable && !installed     → 显示「安装/导入」按钮（p2p 源文案为「导入」）
//   - installed && removable        → 显示「删除」按钮（Trash2 图标）
//   - installed && !removable       → 显示「已安装」静态标记（Check 图标，builtin）
//   - type=agent && source=custom   → 显示「编辑」按钮（Pencil 图标，调用 onEdit 挂载
//                                       DefinitionEditor 编辑定义；仅 installed 渲染）
//   - builtin agent 未启用            → 「启用」按钮（onEnable；spec 2026-09-22）
//   - builtin 已启用 / marketplace 装 → 「配置」按钮（onConfigure）+ builtin「已启用」标记
//
// v2.1 P3：token 化；类型兜底 emoji → lucide（Bot/Puzzle/Package，iconEmoji 用户数据照渲染）；
// × 关闭 / 🗑 删除 / ✓ 已安装 / ✏️ 编辑 → X / Trash2 / Check / Pencil lucide。
//
// v2.1 Task 15：内容区三段式（状态 / 配置预览 / 元数据，「描述」保留为导语）；
// custom agent 新增定义预览——经 ipc.agent.list 反查 def（资源 slug = def.id，
// 与 View 层 handleEditAgent 同口径），YAML-ish 只读渲染 systemPrompt 前 200 字。
import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Bot, Check, Package, Pencil, Puzzle, Settings2, Trash2, X } from 'lucide-react';
import type { ResourceItem } from '../../ipc/types';
import { ipc } from '../../ipc/client';
import { Button } from '../ui/Button';
import { SourceBadge } from './SourceBadge';
import { sourceLabel } from '../../lib/resource-helpers';

interface Props {
  item: ResourceItem;
  onClose: () => void;
  onDelete?: (id: string) => void;
  onInstall?: (id: string) => void;
  /** 编辑 custom agent 定义（仅 type=agent && source=custom 显示按钮） */
  onEdit?: (id: string) => void;
  /** builtin agent 未启用 → 弹启用表单（spec 2026-09-22） */
  onEnable?: (id: string) => void;
  /** builtin 已启用 / marketplace 已安装 agent → 弹配置表单 */
  onConfigure?: (id: string) => void;
}

/** 资源类型兜底图标（item.iconEmoji 优先——用户数据照渲染） */
const TYPE_ICON: Record<ResourceItem['type'], LucideIcon> = {
  agent: Bot,
  mcp: Puzzle,
  skill: Package,
};

/** 兜底图标渲染件（16px 独立档） */
function TypeIcon({ type }: { type: ResourceItem['type'] }) {
  const Icon = TYPE_ICON[type];
  return <Icon size={16} strokeWidth={1.75} aria-hidden />;
}

export function ResourceDetail({ item, onClose, onDelete, onInstall, onEdit, onEnable, onConfigure }: Props) {
  const mcpEnv = item.custom?.mcpConfig?.env;
  const envEntries = mcpEnv ? Object.entries(mcpEnv) : [];

  // custom agent 定义预览（只读 YAML-ish）；非 custom agent 项恒为 null
  const [defPreview, setDefPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!(item.source === 'custom' && item.type === 'agent')) {
      setDefPreview(null);
      return;
    }
    let cancelled = false;
    // custom agent 资源 slug = def.id（UUID）——与 View 层 handleEditAgent 同口径
    ipc.agent
      .list()
      .then((defs) => {
        if (cancelled) return;
        const def = defs.find((d) => d.source === 'custom' && d.id === item.slug);
        if (!def) {
          setDefPreview(null);
          return;
        }
        const promptHead = def.systemPrompt.slice(0, 200);
        setDefPreview(
          `# ${def.name} (${def.slug})\n` +
            `model: ${def.modelProviderId || '(未配置)'} / ${def.modelName}\n` +
            `tools: ${def.defaultTools.map((t) => t.ref).join(', ') || '(空)'}\n` +
            `mcps: ${(def.defaultMcps ?? []).map((m) => m.ref).join(', ') || '(空)'}\n` +
            `skills: ${(def.defaultSkills ?? []).map((s) => s.ref).join(', ') || '(空)'}\n\n` +
            `systemPrompt:\n${promptHead}${def.systemPrompt.length > 200 ? '…' : ''}`,
        );
      })
      .catch(() => {
        if (!cancelled) setDefPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [item]);

  return (
    <div className="w-80 border-l border-subtle bg-surface-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-subtle flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2 text-primary">
          {item.iconEmoji ? (
            <span className="text-xl leading-none">{item.iconEmoji}</span>
          ) : (
            <TypeIcon type={item.type} />
          )}
          <span>{item.name}</span>
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="关闭详情"
          className="inline-flex items-center"
        >
          <X size={14} strokeWidth={1.75} aria-hidden />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3 text-sm">
        {/* 导语：描述（不属于三段） */}
        <div>
          <div className="text-xs text-tertiary mb-1">描述</div>
          <div className="text-secondary">{item.description}</div>
        </div>

        {/* ── 状态 ── */}
        <section>
          <div className="text-xs text-tertiary mb-1">状态</div>
          <div className="flex gap-1 flex-wrap items-center">
            <SourceBadge source={item.source} />
            <span className="text-xs text-tertiary">
              {sourceLabel(item.source)} · {item.type}{item.version && ` · v${item.version}`}
            </span>
          </div>
        </section>

        {/* ── 配置预览 ── */}
        <section>
          <div className="text-xs text-tertiary mb-1">配置预览</div>
          <div className="flex flex-col gap-3">
            {/* custom MCP：command + args + env（KEY=*** 隐藏值） */}
            {item.source === 'custom' && item.type === 'mcp' && item.custom?.mcpConfig && (
              <>
                <div>
                  <div className="text-xs text-tertiary mb-1">命令</div>
                  <code className="text-xs text-secondary">{item.custom.mcpConfig.command}</code>
                </div>
                <div>
                  <div className="text-xs text-tertiary mb-1">参数</div>
                  <code className="text-xs text-secondary break-all">
                    {item.custom.mcpConfig.args.join(' ')}
                  </code>
                </div>
                {envEntries.length > 0 && (
                  <div>
                    <div className="text-xs text-tertiary mb-1">环境变量</div>
                    <div className="space-y-0.5">
                      {envEntries.map(([k]) => (
                        <code key={k} className="block text-xs text-secondary">{k}=***</code>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* custom Skill：frontmatter（name/version） */}
            {item.source === 'custom' && item.type === 'skill' && item.custom?.skillFrontmatter && (
              <div>
                <div className="text-xs text-tertiary mb-1">Frontmatter</div>
                <div className="text-secondary text-xs space-y-0.5">
                  {item.custom.skillFrontmatter.name && (
                    <div>name: {item.custom.skillFrontmatter.name}</div>
                  )}
                  {item.custom.skillFrontmatter.version && (
                    <div>version: {item.custom.skillFrontmatter.version}</div>
                  )}
                </div>
              </div>
            )}

            {/* custom Agent：定义预览（YAML-ish 只读，反查 def 结果） */}
            {defPreview && (
              <pre className="text-xs text-secondary font-mono whitespace-pre-wrap">{defPreview}</pre>
            )}

            {/* custom Agent：systemPromptHash */}
            {item.source === 'custom' && item.type === 'agent' && item.custom?.agentSystemPromptHash && (
              <div>
                <div className="text-xs text-tertiary mb-1">System Prompt Hash</div>
                <code className="text-xs text-secondary break-all">{item.custom.agentSystemPromptHash}</code>
              </div>
            )}

            {/* builtin / marketplace：README 折叠（catalog 元数据在「元数据」段） */}
            {(item.source === 'builtin' || item.source === 'marketplace') && item.marketplace && (
              <div>
                <div className="text-xs text-tertiary mb-1">README</div>
                <div className="text-secondary text-xs whitespace-pre-wrap max-h-60 overflow-y-auto">
                  {item.marketplace.readme}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ── 元数据 ── */}
        <section>
          <div className="text-xs text-tertiary mb-1">元数据</div>
          <div className="flex flex-col gap-3">
            {/* builtin / marketplace 共用 catalog 元数据（仅当 item.marketplace 存在时显示） */}
            {(item.source === 'builtin' || item.source === 'marketplace') && item.marketplace && (
              <>
                <div>
                  <div className="text-xs text-tertiary mb-1">作者</div>
                  <div className="text-secondary">{item.marketplace.author}</div>
                </div>
                <div>
                  <div className="text-xs text-tertiary mb-1">校验状态</div>
                  <div className="text-secondary">{item.marketplace.verificationStatus}</div>
                </div>
                {item.marketplace.downloadUrl && (
                  <div>
                    <div className="text-xs text-tertiary mb-1">下载地址</div>
                    <code className="text-xs text-secondary break-all">{item.marketplace.downloadUrl}</code>
                  </div>
                )}
              </>
            )}

            {/* p2p：来源节点（目录元数据不含完整定义，导入经 request/provide 拉取——T5） */}
            {item.source === 'p2p' && item.p2p && (
              <div>
                <div className="text-xs text-tertiary mb-1">来源节点</div>
                <div className="text-secondary">{item.p2p.peerName}</div>
              </div>
            )}

            {/* custom 共用：上传时间 */}
            {item.custom?.installedAt && (
              <div>
                <div className="text-xs text-tertiary mb-1">
                  {item.source === 'custom' ? '上传时间' : '安装时间'}
                </div>
                <div className="text-secondary">
                  {new Date(item.custom.installedAt).toLocaleString('zh-CN')}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="px-4 py-3 border-t border-subtle flex gap-2">
        {/* 安装按钮：仅 installable 且未安装时显示（p2p 源文案为「导入」） */}
        {item.installable && !item.installed && onInstall && (
          <Button size="sm" onClick={() => onInstall(item.id)}>
            {item.source === 'p2p' ? '导入' : '安装'}
          </Button>
        )}
        {/* 编辑按钮：仅 custom agent（installed）显示——挂载 DefinitionEditor 编辑定义 */}
        {item.type === 'agent' && item.source === 'custom' && item.installed && onEdit && (
          <Button
            size="sm"
            onClick={() => onEdit(item.id)}
            className="inline-flex items-center gap-1"
          >
            <Pencil size={12} strokeWidth={1.75} aria-hidden />
            编辑
          </Button>
        )}
        {/* 启用按钮：builtin agent 未启用（def 不在库）——落库 + 配模型一步完成（spec 2026-09-22） */}
        {item.type === 'agent' && item.source === 'builtin' && !item.builtin?.agentEnabled && onEnable && (
          <Button size="sm" onClick={() => onEnable(item.id)}>
            启用
          </Button>
        )}
        {/* 配置按钮：builtin 已启用 / marketplace 已安装（def 已落库，可改模型） */}
        {item.type === 'agent' && onConfigure &&
          ((item.source === 'builtin' && item.builtin?.agentEnabled) ||
            (item.source === 'marketplace' && item.installed)) && (
          <Button
            size="sm"
            onClick={() => onConfigure(item.id)}
            className="inline-flex items-center gap-1"
          >
            <Settings2 size={12} strokeWidth={1.75} aria-hidden />
            配置
          </Button>
        )}
        {/* 删除按钮：仅 installed 且 removable 时显示（custom 上传项） */}
        {item.installed && item.removable && onDelete && (
          <Button
            size="sm"
            variant="danger"
            onClick={() => onDelete(item.id)}
            className="inline-flex items-center gap-1"
          >
            <Trash2 size={12} strokeWidth={1.75} aria-hidden />
            删除
          </Button>
        )}
        {/* 已启用标记：builtin agent def 已在库（区别于「已安装」的随应用分发语义） */}
        {item.type === 'agent' && item.source === 'builtin' && item.builtin?.agentEnabled && (
          <span className="inline-flex items-center gap-1 text-xs text-status-success self-center">
            <Check size={12} strokeWidth={1.75} aria-hidden />
            已启用
          </span>
        )}
        {/* 已安装静态标记：installed 且不可删除（builtin 非 agent 项）时显示 */}
        {item.installed && !item.removable && !(item.type === 'agent' && item.source === 'builtin') && (
          <span className="inline-flex items-center gap-1 text-xs text-status-success self-center">
            <Check size={12} strokeWidth={1.75} aria-hidden />
            已安装
          </span>
        )}
      </div>
    </div>
  );
}
