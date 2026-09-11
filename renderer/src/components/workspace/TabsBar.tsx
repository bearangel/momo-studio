// renderer/src/components/workspace/TabsBar.tsx
//
// v2.7 McpBrowser tabs 栏（spec §3.5）：tab pill 列表 + 当前高亮（aria-current）
// + 每 tab 关闭钮（stopPropagation 不触发选中）+「+」新建。
// 纯展示组件——onSelect/onClose/onOpen 由父组件接 switchTab/closeTab/openTab IPC。
import { Plus, X } from 'lucide-react';
import type { BrowserTabInfo } from '../../ipc/types';
import { cn } from '../../lib/cn';
import { IconButton } from '../ui/IconButton';

interface Props {
  tabs: BrowserTabInfo[];
  /** 当前 tab 下标（tabs[current] 即活跃页——BrowserState.current 透传） */
  current: number;
  onSelect: (index: number) => void;
  onClose: (index: number) => void;
  onOpen: () => void;
}

export function TabsBar({ tabs, current, onSelect, onClose, onOpen }: Props) {
  return (
    <div
      role="tablist"
      aria-label="浏览器标签页"
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
    >
      {tabs.map((tab) => {
        // 标题缺失回退 url（about:blank 早期 getTitle 为空）
        const label = tab.title || tab.url;
        const active = tab.index === current;
        return (
          <div
            key={tab.index}
            className={cn(
              'flex h-7 max-w-40 shrink-0 items-center gap-0.5 rounded-md border pl-2 pr-0.5',
              active
                ? 'border-strong bg-surface-3 text-primary'
                : 'border-subtle bg-surface-2 text-tertiary hover:text-secondary',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-current={active ? 'true' : undefined}
              title={label}
              className="max-w-32 truncate text-xs outline-none"
              onClick={() => {
                onSelect(tab.index);
              }}
            >
              {label}
            </button>
            <IconButton
              aria-label={`关闭 ${label}`}
              size="sm"
              onClick={(e) => {
                // 关闭不冒泡——不触发所在 pill 的选中语义
                e.stopPropagation();
                onClose(tab.index);
              }}
            >
              <X size={16} strokeWidth={1.75} aria-hidden />
            </IconButton>
          </div>
        );
      })}
      <IconButton
        aria-label="新建标签页"
        className="shrink-0"
        onClick={() => {
          onOpen();
        }}
      >
        <Plus size={16} strokeWidth={1.75} aria-hidden />
      </IconButton>
    </div>
  );
}
