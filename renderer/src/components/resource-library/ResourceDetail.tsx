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
import { Bot, Check, Copy, Package, Pencil, Power, Puzzle, Settings2, Trash2, X } from 'lucide-react';
import type { BuiltinPresetPreview, ResourceItem } from '../../ipc/types';
import { ipc } from '../../ipc/client';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import type { BadgeTone } from '../ui/Badge';
import { MarkdownBody } from '../im/MarkdownBody';
import { SourceBadge } from './SourceBadge';

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
  /** 已装远程 MCP → 弹配置编辑表单（仅 streamable_http；spec §6.1 / Task 7） */
  onEditMcpConfig?: (item: ResourceItem) => void;
  /** 已装 custom MCP → 弹全字段编辑表单（stdio+远程通吃；P2.5 D4） */
  onEditMcpEntry?: (item: ResourceItem) => void;
  /** 组⑤：MCP 启停（mcp DB 行派生项；View 层接 store.setMcpEnabled） */
  onToggleMcp?: (item: ResourceItem, next: boolean) => void;
  /** builtin agent 薄 fork（2026-10-08 预设可见化）：全量 preview 交 View 层预填创建向导 */
  onForkPreset?: (preview: BuiltinPresetPreview) => void;
  /** builtin agent 停用（2026-10-10）：View 层挂影响面披露确认框后走 disablePreset 级联 */
  onDisable?: (id: string) => void;
}

/** 资源类型兜底图标（item.iconEmoji 优先——用户数据照渲染） */
const TYPE_ICON: Record<ResourceItem['type'], LucideIcon> = {
  agent: Bot,
  mcp: Puzzle,
  skill: Package,
};

/** 类型中文标签（状态段文字行用；来源已由 SourceBadge 表达，不再重复，走查 N3） */
const TYPE_LABEL: Record<ResourceItem['type'], string> = {
  agent: '智能体',
  mcp: 'MCP',
  skill: '技能',
};

/** 校验状态本地化（走查 A4：禁原始枚举直出；tone 对齐设计系统状态徽标） */
const VERIFICATION: Record<
  NonNullable<ResourceItem['marketplace']>['verificationStatus'],
  { label: string; tone: BadgeTone }
> = {
  official: { label: '官方', tone: 'success' },
  verified: { label: '已验证', tone: 'success' },
  community: { label: '社区', tone: 'neutral' },
  unverified: { label: '未验证', tone: 'warning' },
};

/** 兜底图标渲染件（16px 独立档） */
function TypeIcon({ type }: { type: ResourceItem['type'] }) {
  const Icon = TYPE_ICON[type];
  return <Icon size={16} strokeWidth={1.75} aria-hidden />;
}

export function ResourceDetail({ item, onClose, onDelete, onInstall, onEdit, onEnable, onConfigure, onEditMcpConfig, onEditMcpEntry, onToggleMcp, onForkPreset, onDisable }: Props) {
  const mcpEnv = item.custom?.mcpConfig?.env;
  const envEntries = mcpEnv ? Object.entries(mcpEnv) : [];

  // hub 源（smithery）经 marketplace 元数据段渲染（spec 2026-09-22 §4.4）；
  // builtin/marketplace 也走同一段——一处定义两处复用，避免门控漂移
  const hasMarketplaceMeta =
    item.source === 'builtin' ||
    item.source === 'marketplace' ||
    item.source === 'smithery';

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

  // builtin agent 能力预览（2026-10-08 预设可见化）：恒 YAML 最新版（previewBuiltinPreset
  // 直读内置目录，不受已启用 DB 行版本影响）；失败红字不阻塞面板其余部分。
  const isBuiltinAgent = item.type === 'agent' && item.source === 'builtin';
  const [presetPreview, setPresetPreview] = useState<BuiltinPresetPreview | null>(null);
  const [presetPreviewError, setPresetPreviewError] = useState<string | null>(null);
  useEffect(() => {
    if (!isBuiltinAgent) {
      setPresetPreview(null);
      setPresetPreviewError(null);
      return;
    }
    let cancelled = false;
    setPresetPreview(null);
    setPresetPreviewError(null);
    ipc.resource
      .previewBuiltinPreset(item.slug)
      .then((preview) => {
        if (!cancelled) setPresetPreview(preview);
      })
      .catch((err: unknown) => {
        if (!cancelled) setPresetPreviewError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [isBuiltinAgent, item.slug]);

  return (
    <div className="w-full h-full border-l border-subtle bg-surface-1 flex flex-col overflow-hidden">
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
              {TYPE_LABEL[item.type]}{item.version && ` · v${item.version}`}
            </span>
            {/* 组⑤：禁用态徽章（mcp DB 行派生项） */}
            {item.mcp && !item.mcp.enabled && <Badge tone="warning">已禁用</Badge>}
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

            {/* builtin Agent：能力清单（YAML 最新版；2026-10-08 预设可见化） */}
            {isBuiltinAgent && (
              <div>
                <div className="text-xs text-tertiary mb-1">能力清单（YAML 最新版）</div>
                {presetPreviewError !== null ? (
                  <div className="text-xs text-status-error">
                    能力预览加载失败：{presetPreviewError}
                  </div>
                ) : presetPreview !== null ? (
                  <pre className="text-xs text-secondary font-mono whitespace-pre-wrap">
                    {`tools: ${presetPreview.tools.join(', ') || '(空)'}\n` +
                      `mcps: ${presetPreview.mcps.join(', ') || '(空)'}\n` +
                      `skills: ${presetPreview.skills.join(', ') || '(空)'}\n\n` +
                      `systemPrompt:\n${presetPreview.systemPrompt.slice(0, 200)}${
                        presetPreview.systemPrompt.length > 200 ? '…' : ''
                      }`}
                  </pre>
                ) : (
                  <div className="text-xs text-tertiary">能力预览加载中…</div>
                )}
              </div>
            )}

            {/* custom Agent：systemPromptHash */}
            {item.source === 'custom' && item.type === 'agent' && item.custom?.agentSystemPromptHash && (
              <div>
                <div className="text-xs text-tertiary mb-1">System Prompt Hash</div>
                <code className="text-xs text-secondary break-all">{item.custom.agentSystemPromptHash}</code>
              </div>
            )}

            {/* builtin / marketplace / hub（smithery）：README Markdown 渲染（组③ B7：复用会话区 MarkdownBody，禁裸 # 直出） */}
            {hasMarketplaceMeta && item.marketplace && (
              <div>
                <div className="text-xs text-tertiary mb-1">README</div>
                <div className="max-h-60 overflow-y-auto text-secondary text-[13px]">
                  <MarkdownBody>{item.marketplace.readme}</MarkdownBody>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ── 元数据 ── */}
        <section>
          <div className="text-xs text-tertiary mb-1">元数据</div>
          <div className="flex flex-col gap-3">
            {/* builtin / marketplace / hub（smithery）共用 catalog 元数据（仅当 item.marketplace 存在时显示） */}
            {hasMarketplaceMeta && item.marketplace && (
              <>
                <div>
                  <div className="text-xs text-tertiary mb-1">作者</div>
                  <div className="text-secondary">{item.marketplace.author}</div>
                </div>
                <div>
                  <div className="text-xs text-tertiary mb-1">校验状态</div>
                  <Badge tone={VERIFICATION[item.marketplace.verificationStatus].tone}>
                    {VERIFICATION[item.marketplace.verificationStatus].label}
                  </Badge>
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
        {/* 停用按钮：builtin agent 已启用——回到未启用态（级联影响面由确认框披露）。
            danger 变体与删除同级：级联会解散团队/移出成员，破坏面同样不可逆 */}
        {item.type === 'agent' && item.source === 'builtin' && item.builtin?.agentEnabled && onDisable && (
          <Button size="sm" variant="danger" onClick={() => onDisable(item.id)}>
            停用
          </Button>
        )}
        {/* 复制为自定义（2026-10-08 薄 fork）：全量预填创建向导；预览未就绪/失败时禁用 */}
        {item.type === 'agent' && item.source === 'builtin' && onForkPreset && (
          <Button
            size="sm"
            variant="secondary"
            disabled={presetPreview === null}
            onClick={() => presetPreview !== null && onForkPreset(presetPreview)}
            className="inline-flex items-center gap-1"
          >
            <Copy size={12} strokeWidth={1.75} aria-hidden />
            复制为自定义
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
        {/* 配置按钮：已装远程 MCP（spec §6.1 / Task 7）——与卸载按钮同排；stdio 不编辑（D1） */}
        {item.type === 'mcp' && item.installed && item.custom?.transport === 'streamable_http' && onEditMcpConfig && (
          <Button
            size="sm"
            onClick={() => onEditMcpConfig(item)}
            className="inline-flex items-center gap-1"
          >
            <Settings2 size={12} strokeWidth={1.75} aria-hidden />
            配置
          </Button>
        )}
        {/* P2.5 D4：custom 源已装 MCP 全字段编辑（stdio+远程）；smithery/marketplace 走上方「配置」 */}
        {item.type === 'mcp' && item.installed && item.source === 'custom' && onEditMcpEntry && (
          <Button size="sm" onClick={() => onEditMcpEntry(item)} className="inline-flex items-center gap-1">
            <Pencil size={12} strokeWidth={1.75} aria-hidden />
            编辑
          </Button>
        )}
        {/* 组⑤：MCP 启停（mcp_definitions DB 行派生项）。禁用 = 定义保留、运行时切断 */}
        {item.type === 'mcp' && item.installed && item.mcp && onToggleMcp && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onToggleMcp(item, !item.mcp?.enabled)}
            className="inline-flex items-center gap-1"
          >
            <Power size={12} strokeWidth={1.75} aria-hidden />
            {item.mcp.enabled ? '禁用' : '启用'}
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
