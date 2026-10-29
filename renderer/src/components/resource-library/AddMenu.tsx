// renderer/src/components/resource-library/AddMenu.tsx
// 类型专属「＋」下拉（spec §4，Cherry Studio MCP 模式）：命名路径 + 一句副文案。
// 点击外部收起（2026-10-09 组③补 Esc 关闭）；菜单项点击后必收起。图标 lucide（禁 emoji）。
// library-store-split：菜单项支持 separatorBefore（本地组与远端组之间的分隔线）
// + 样式对齐预览 §B 定值（宽 296px / 项 padding 8px 10px / 标题 13px/500 /
// 副文案 11.5px / 图标 15px）。
import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** 单条添加路径 */
export interface AddMenuItem {
  key: string;
  /** 菜单项标题（如「快速创建…」） */
  title: string;
  /** 一句副文案（如「名称 / 命令 / 参数」） */
  hint?: string;
  /** 可选前导图标（15px / stroke 1.75，语义 token 着色） */
  icon?: LucideIcon;
  /** true = 本项之前渲染分组分隔线（本地组 | 远端组） */
  separatorBefore?: boolean;
  onSelect: () => void;
}

interface AddMenuProps {
  /** 按钮文案（按类型命名，如「添加服务器」；前缀「+」由 lucide Plus 图标传达） */
  label: string;
  items: AddMenuItem[];
}

export function AddMenu({ label, items }: AddMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击外部 / Esc 收起（挂卸成对）
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onDocKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onDocKeyDown);
    };
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
        <div
          role="menu"
          className="absolute right-0 top-9 z-10 w-[296px] rounded-lg border border-strong bg-canvas shadow-[0_8px_28px_rgba(0,0,0,.16)] p-[5px]"
        >
          {items.map((item) => (
            <div key={item.key}>
              {item.separatorBefore && <div className="h-px bg-border-subtle mx-2 my-[5px]" />}
              <button
                type="button"
                role="menuitem"
                className="w-full text-left px-2.5 py-2 rounded-md hover:bg-surface-2 transition-colors"
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                <span className="flex items-start gap-[9px]">
                  {item.icon && <item.icon size={15} strokeWidth={1.75} aria-hidden className="shrink-0 mt-0.5 text-secondary" />}
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-primary">{item.title}</span>
                    {item.hint && <span className="block text-[11.5px] text-tertiary">{item.hint}</span>}
                  </span>
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
