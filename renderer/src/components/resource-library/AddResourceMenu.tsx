// renderer/src/components/resource-library/AddResourceMenu.tsx
// AddResourceMenu：单按钮「添加资源」+ 下拉菜单（创建 Agent / 添加 MCP / 上传 Skill）。
// 默认折叠；点击按钮切换展开/收起；点击菜单项触发对应 callback 并自动关闭；
// 点击菜单外部（document mousedown）自动关闭。
// v2.1 P3：token 化（弹出层 surface-1 + 行 hover surface-3）；+/▼ 字形与 🤖🔌📦 →
// Plus/ChevronDown/Bot/Puzzle/Package lucide（P3 裁定：MCP 用 Puzzle，与资源库语义配）。
import { useState, useRef, useEffect } from 'react';
import { Bot, ChevronDown, Package, Plus, Puzzle } from 'lucide-react';
import { Button } from '../ui/Button';

interface Props {
  /** 点击「创建自定义 Agent」回调 */
  onCreateAgent: () => void;
  /** 点击「添加 MCP Server」回调 */
  onRegisterMcp: () => void;
  /** 点击「上传 Skill 包」回调 */
  onUploadSkill: () => void;
}

export function AddResourceMenu({ onCreateAgent, onRegisterMcp, onUploadSkill }: Props) {
  const [open, setOpen] = useState(false);
  // 容器 ref——用于判断 mousedown 是否发生在菜单外部
  const ref = useRef<HTMLDivElement>(null);

  // 展开时挂载 document mousedown 监听，点击外部即收起
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1"
      >
        <Plus size={12} strokeWidth={1.75} aria-hidden />
        添加资源
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden />
      </Button>
      {open && (
        <div className="absolute right-0 mt-1 w-56 border border-subtle bg-surface-1 rounded-md shadow-lg z-20 py-1">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-secondary hover:bg-surface-3"
            onClick={() => { setOpen(false); onCreateAgent(); }}
          >
            <Bot size={12} strokeWidth={1.75} aria-hidden />
            创建自定义 Agent...
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-secondary hover:bg-surface-3"
            onClick={() => { setOpen(false); onRegisterMcp(); }}
          >
            <Puzzle size={12} strokeWidth={1.75} aria-hidden />
            添加 MCP Server...
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-secondary hover:bg-surface-3"
            onClick={() => { setOpen(false); onUploadSkill(); }}
          >
            <Package size={12} strokeWidth={1.75} aria-hidden />
            上传 Skill 包...
          </button>
        </div>
      )}
    </div>
  );
}
