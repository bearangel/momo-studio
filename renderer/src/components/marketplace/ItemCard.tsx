// Marketplace 卡片：单条可安装项的网格单元。
// 展示 icon + name + description + 校验徽章 + 安装/已安装按钮。
// 点击卡片选中（由父级控制 selected），点击安装按钮触发 store.install。
import { Button } from '../ui/Button';
import { cn } from '../../lib/cn';
import type { InstalledPackage, MarketplaceItem } from '../../ipc/types';

interface Props {
  item: MarketplaceItem;
  installed?: InstalledPackage;
  installing?: boolean;
  selected?: boolean;
  onSelect: () => void;
  onInstall: () => void;
}

/** 校验状态 → 徽章文案 + 颜色 class */
const VERIFICATION_BADGE: Record<
  MarketplaceItem['verificationStatus'],
  { label: string; cls: string }
> = {
  official: { label: '官方', cls: 'bg-accent-blue/20 text-accent-blue' },
  verified: { label: '已验证', cls: 'bg-green-500/20 text-green-400' },
  community: { label: '社区', cls: 'bg-amber-500/20 text-amber-400' },
  unverified: { label: '未验证', cls: 'bg-neutral-500/20 text-neutral-400' },
};

export function ItemCard({
  item,
  installed,
  installing = false,
  selected = false,
  onSelect,
  onInstall,
}: Props) {
  const badge = VERIFICATION_BADGE[item.verificationStatus];
  const isInstalled = Boolean(installed);
  const typeLabel =
    item.type === 'agent' ? 'Agent' : item.type === 'mcp' ? 'MCP' : 'Skill';

  return (
    <div
      className={cn(
        'flex flex-col gap-2 p-3 rounded-lg bg-bg-tertiary border cursor-pointer transition-colors',
        selected ? 'border-accent-blue' : 'border-border-subtle hover:border-border-strong',
      )}
      onClick={onSelect}
    >
      <div className="flex items-start gap-2">
        <span className="text-2xl leading-none">{item.iconEmoji || '📦'}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-neutral-100 truncate">{item.name}</h3>
            <span className={cn('text-xs px-1.5 py-0.5 rounded-full', badge.cls)}>
              {badge.label}
            </span>
          </div>
          <div className="text-xs text-neutral-500 truncate">
            {typeLabel} · v{item.version} · {item.author}
          </div>
        </div>
      </div>

      <p className="text-xs text-neutral-400 line-clamp-2 min-h-[2rem]">{item.description}</p>

      <div className="flex items-center justify-between gap-2 mt-auto">
        <span className="text-xs text-neutral-600">
          {item.installCount > 0 ? `${item.installCount} 次安装` : '新'}
        </span>
        <Button
          size="sm"
          variant={isInstalled ? 'ghost' : 'primary'}
          disabled={isInstalled || installing}
          onClick={(e) => {
            e.stopPropagation();
            if (!isInstalled) onInstall();
          }}
        >
          {installing ? '安装中…' : isInstalled ? '已安装' : '安装'}
        </Button>
      </div>
    </div>
  );
}
