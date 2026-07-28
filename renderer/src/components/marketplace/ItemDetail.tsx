// Marketplace 详情面板：选中项的完整 readme + 元信息 + 安装/卸载按钮。
// readme 用 react-markdown + remark-gfm 渲染（与项目既有依赖一致）。
// 元信息包含 slug / 版本 / 作者 / 类型 / 大小 / 标签。
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '../ui/Button';
import { cn } from '../../lib/cn';
import type { InstalledPackage, MarketplaceItem } from '../../ipc/types';

interface Props {
  item: MarketplaceItem;
  installed?: InstalledPackage;
  installing?: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onClose: () => void;
}

/** 字节数 → 人类可读（KB/MB） */
function formatSize(bytes: number): string {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 元信息键值对 */
function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-neutral-500">{label}</span>
      <span className="text-sm text-neutral-200 break-all">{value}</span>
    </div>
  );
}

export function ItemDetail({
  item,
  installed,
  installing = false,
  onInstall,
  onUninstall,
  onClose,
}: Props) {
  const isInstalled = Boolean(installed);
  const typeLabel =
    item.type === 'agent' ? 'Agent' : item.type === 'mcp' ? 'MCP' : 'Skill';

  return (
    <div className="w-96 border-l border-border-subtle bg-bg-secondary flex flex-col overflow-hidden">
      {/* 头部：图标 + 名称 + 关闭 */}
      <div className="flex items-start gap-3 p-4 border-b border-border-subtle">
        <span className="text-3xl leading-none">{item.iconEmoji || '📦'}</span>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-neutral-100 break-words">{item.name}</h2>
          <p className="text-xs text-neutral-500">{typeLabel}</p>
        </div>
        <button
          className="text-neutral-500 hover:text-neutral-200 text-lg leading-none px-1"
          onClick={onClose}
          aria-label="关闭详情"
        >
          ×
        </button>
      </div>

      {/* 操作区 */}
      <div className="px-4 py-3 border-b border-border-subtle flex gap-2">
        {isInstalled ? (
          <>
            <span className="flex-1 text-xs text-green-400 self-center">已安装 v{installed?.version}</span>
            <Button size="sm" variant="danger" onClick={onUninstall}>
              卸载
            </Button>
          </>
        ) : (
          <Button size="sm" className="flex-1" disabled={installing} onClick={onInstall}>
            {installing ? '安装中…' : `安装 v${item.version}`}
          </Button>
        )}
      </div>

      {/* 元信息 */}
      <div className="grid grid-cols-2 gap-3 px-4 py-3 border-b border-border-subtle">
        <Meta label="Slug" value={item.slug} />
        <Meta label="版本" value={item.version} />
        <Meta label="作者" value={item.author} />
        <Meta label="大小" value={formatSize(item.sizeBytes)} />
        <div className="col-span-2">
          <span className="text-xs text-neutral-500">标签</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {item.tags.length === 0 ? (
              <span className="text-xs text-neutral-600">无</span>
            ) : (
              item.tags.map((t) => (
                <span
                  key={t}
                  className={cn(
                    'text-xs px-1.5 py-0.5 rounded-full',
                    'bg-bg-tertiary text-neutral-400 border border-border-subtle',
                  )}
                >
                  {t}
                </span>
              ))
            )}
          </div>
        </div>
      </div>

      {/* readme */}
      <div className="flex-1 overflow-auto px-4 py-3">
        <div className="text-sm text-neutral-300 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:text-neutral-100 [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-neutral-100 [&_h2]:mt-3 [&_h2]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-neutral-200 [&_h3]:mt-2 [&_h3]:mb-1 [&_p]:my-2 [&_p]:leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-2 [&_li]:my-0.5 [&_a]:text-accent-blue [&_a]:underline [&_code]:text-accent-purple [&_code]:bg-bg-tertiary [&_code]:px-1 [&_code]:rounded [&_pre]:bg-bg-tertiary [&_pre]:p-2 [&_pre]:rounded-md [&_pre]:overflow-x-auto [&_pre]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border-strong [&_blockquote]:pl-3 [&_blockquote]:text-neutral-400">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.readme || '暂无说明'}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
