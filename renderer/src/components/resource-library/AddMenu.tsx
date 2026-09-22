// renderer/src/components/resource-library/AddMenu.tsx
// 类型专属「＋」下拉（spec §4，Cherry Studio MCP 模式）：命名路径 + 一句副文案。
// 点击外部收起；菜单项点击后必收起。图标 lucide Plus（禁 emoji）。
import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';

/** 单条添加路径 */
export interface AddMenuItem {
  key: string;
  /** 菜单项标题（如「手动配置…」） */
  title: string;
  /** 一句副文案（如「名称 / 命令 / 参数」） */
  hint?: string;
  onSelect: () => void;
}

interface AddMenuProps {
  /** 按钮文案（按类型命名，如「＋ 添加服务器」） */
  label: string;
  items: AddMenuItem[];
}

export function AddMenu({ label, items }: AddMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击外部收起（挂卸成对）
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1 h-7 px-3 rounded-md bg-accent-500 text-inverse text-[13px] font-medium hover:opacity-90"
        onClick={() => setOpen((v) => !v)}
      >
        <Plus size={14} strokeWidth={1.75} aria-hidden />
        {label}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-9 z-10 w-64 rounded-lg border border-subtle bg-surface-3 shadow-lg py-1">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className="w-full text-left px-3 py-1.5 hover:bg-surface-active transition-colors"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              <span className="block text-[13px] text-primary">{item.title}</span>
              {item.hint && <span className="block text-xs text-tertiary">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
