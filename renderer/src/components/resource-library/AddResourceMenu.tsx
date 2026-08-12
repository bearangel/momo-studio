// renderer/src/components/resource-library/AddResourceMenu.tsx
// AddResourceMenu：单按钮「+ 添加资源 ▼」+ 下拉菜单（创建 Agent / 添加 MCP / 上传 Skill）。
// 默认折叠；点击按钮切换展开/收起；点击菜单项触发对应 callback 并自动关闭；
// 点击菜单外部（document mousedown）自动关闭。
import { useState, useRef, useEffect } from 'react';
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
      <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
        + 添加资源 ▼
      </Button>
      {open && (
        <div className="absolute right-0 mt-1 w-56 bg-bg-secondary border border-border-subtle rounded-md shadow-lg z-20 py-1">
          <button
            type="button"
            className="block w-full text-left px-3 py-2 text-sm text-neutral-200 hover:bg-bg-tertiary"
            onClick={() => { setOpen(false); onCreateAgent(); }}
          >
            🤖 创建自定义 Agent...
          </button>
          <button
            type="button"
            className="block w-full text-left px-3 py-2 text-sm text-neutral-200 hover:bg-bg-tertiary"
            onClick={() => { setOpen(false); onRegisterMcp(); }}
          >
            🔌 添加 MCP Server...
          </button>
          <button
            type="button"
            className="block w-full text-left px-3 py-2 text-sm text-neutral-200 hover:bg-bg-tertiary"
            onClick={() => { setOpen(false); onUploadSkill(); }}
          >
            📦 上传 Skill 包...
          </button>
        </div>
      )}
    </div>
  );
}
