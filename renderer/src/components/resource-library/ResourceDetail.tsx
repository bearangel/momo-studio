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
//   - installed && removable        → 显示「🗑 删除」按钮
//   - installed && !removable       → 显示「✓ 已安装」静态标记（builtin）
import type { ResourceItem } from '../../ipc/types';
import { Button } from '../ui/Button';
import { SourceBadge } from './SourceBadge';
import { sourceLabel } from '../../lib/resource-helpers';

interface Props {
  item: ResourceItem;
  onClose: () => void;
  onDelete?: (id: string) => void;
  onInstall?: (id: string) => void;
}

/** 资源类型默认 emoji 兜底（item.iconEmoji 优先） */
const TYPE_EMOJI: Record<ResourceItem['type'], string> = {
  agent: '🤖',
  mcp: '🔌',
  skill: '📦',
};

export function ResourceDetail({ item, onClose, onDelete, onInstall }: Props) {
  const mcpEnv = item.custom?.mcpConfig?.env;
  const envEntries = mcpEnv ? Object.entries(mcpEnv) : [];

  return (
    <div className="w-80 border-l border-border-subtle bg-bg-secondary flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <span className="text-xl">{item.iconEmoji || TYPE_EMOJI[item.type]}</span>
          <span>{item.name}</span>
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>×</Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3 text-sm">
        <div className="flex gap-1 flex-wrap items-center">
          <SourceBadge source={item.source} />
          <span className="text-xs text-neutral-500">
            {sourceLabel(item.source)} · {item.type}{item.version && ` · v${item.version}`}
          </span>
        </div>

        <div>
          <div className="text-xs text-neutral-500 mb-1">描述</div>
          <div className="text-neutral-200">{item.description}</div>
        </div>

        {/* builtin / marketplace 共用 catalog 元数据（仅当 item.marketplace 存在时显示） */}
        {(item.source === 'builtin' || item.source === 'marketplace') && item.marketplace && (
          <>
            <div>
              <div className="text-xs text-neutral-500 mb-1">作者</div>
              <div className="text-neutral-200">{item.marketplace.author}</div>
            </div>
            <div>
              <div className="text-xs text-neutral-500 mb-1">校验状态</div>
              <div className="text-neutral-200">{item.marketplace.verificationStatus}</div>
            </div>
            {item.marketplace.downloadUrl && (
              <div>
                <div className="text-xs text-neutral-500 mb-1">下载地址</div>
                <code className="text-xs text-neutral-300 break-all">{item.marketplace.downloadUrl}</code>
              </div>
            )}
            <div>
              <div className="text-xs text-neutral-500 mb-1">README</div>
              <div className="text-neutral-300 text-xs whitespace-pre-wrap max-h-60 overflow-y-auto">
                {item.marketplace.readme}
              </div>
            </div>
          </>
        )}

        {/* custom MCP：command + args + env（KEY=*** 隐藏值） */}
        {item.source === 'custom' && item.type === 'mcp' && item.custom?.mcpConfig && (
          <>
            <div>
              <div className="text-xs text-neutral-500 mb-1">命令</div>
              <code className="text-xs text-neutral-200">{item.custom.mcpConfig.command}</code>
            </div>
            <div>
              <div className="text-xs text-neutral-500 mb-1">参数</div>
              <code className="text-xs text-neutral-200 break-all">
                {item.custom.mcpConfig.args.join(' ')}
              </code>
            </div>
            {envEntries.length > 0 && (
              <div>
                <div className="text-xs text-neutral-500 mb-1">环境变量</div>
                <div className="space-y-0.5">
                  {envEntries.map(([k]) => (
                    <code key={k} className="block text-xs text-neutral-200">{k}=***</code>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* custom Skill：frontmatter（name/version） */}
        {item.source === 'custom' && item.type === 'skill' && item.custom?.skillFrontmatter && (
          <div>
            <div className="text-xs text-neutral-500 mb-1">Frontmatter</div>
            <div className="text-neutral-200 text-xs space-y-0.5">
              {item.custom.skillFrontmatter.name && (
                <div>name: {item.custom.skillFrontmatter.name}</div>
              )}
              {item.custom.skillFrontmatter.version && (
                <div>version: {item.custom.skillFrontmatter.version}</div>
              )}
            </div>
          </div>
        )}

        {/* custom Agent：systemPromptHash */}
        {item.source === 'custom' && item.type === 'agent' && item.custom?.agentSystemPromptHash && (
          <div>
            <div className="text-xs text-neutral-500 mb-1">System Prompt Hash</div>
            <code className="text-xs text-neutral-200 break-all">{item.custom.agentSystemPromptHash}</code>
          </div>
        )}

        {/* p2p：来源节点（目录元数据不含完整定义，导入经 request/provide 拉取——T5） */}
        {item.source === 'p2p' && item.p2p && (
          <div>
            <div className="text-xs text-neutral-500 mb-1">来源节点</div>
            <div className="text-neutral-200">{item.p2p.peerName}</div>
          </div>
        )}

        {/* custom 共用：上传时间 */}
        {item.custom?.installedAt && (
          <div>
            <div className="text-xs text-neutral-500 mb-1">
              {item.source === 'custom' ? '上传时间' : '安装时间'}
            </div>
            <div className="text-neutral-200">
              {new Date(item.custom.installedAt).toLocaleString('zh-CN')}
            </div>
          </div>
        )}
      </div>

      <div className="px-4 py-3 border-t border-border-subtle flex gap-2">
        {/* 安装按钮：仅 installable 且未安装时显示（p2p 源文案为「导入」） */}
        {item.installable && !item.installed && onInstall && (
          <Button size="sm" onClick={() => onInstall(item.id)}>
            {item.source === 'p2p' ? '导入' : '安装'}
          </Button>
        )}
        {/* 删除按钮：仅 installed 且 removable 时显示（custom 上传项） */}
        {item.installed && item.removable && onDelete && (
          <Button size="sm" variant="danger" onClick={() => onDelete(item.id)}>🗑 删除</Button>
        )}
        {/* 已安装静态标记：installed 且不可删除（builtin）时显示 */}
        {item.installed && !item.removable && (
          <span className="text-xs text-neutral-500 self-center">✓ 已安装</span>
        )}
      </div>
    </div>
  );
}
