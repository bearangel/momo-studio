// renderer/src/components/common/ResizableSidebar.tsx
//
// 可拖拽调整宽度的侧边栏容器。支持鼠标拖拽右边缘调整宽度 + 一键收起。
// 宽度持久化到 localStorage。
import { useEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** localStorage key（持久化宽度 + 收起状态） */
  storageKey: string;
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
  /** 收起状态下显示的标签（竖排） */
  collapsedLabel?: string;
}

export function ResizableSidebar({
  children,
  storageKey,
  minWidth = 180,
  maxWidth = 400,
  defaultWidth = 240,
  collapsedLabel,
}: Props) {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(storageKey) : null;
  const initialCollapsed = stored === 'collapsed';
  const initialWidth = stored && stored !== 'collapsed' ? parseInt(stored, 10) || defaultWidth : defaultWidth;

  const [width, setWidth] = useState(initialWidth);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const dragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newWidth = Math.max(minWidth, Math.min(maxWidth, e.clientX - rect.left));
      setWidth(newWidth);
    };
    const onUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem(storageKey, String(width));
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [width, minWidth, maxWidth, storageKey]);

  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(storageKey, next ? 'collapsed' : String(width));
  };

  if (collapsed) {
    return (
      <div className="shrink-0 w-8 border-r border-border-subtle bg-bg-secondary flex flex-col items-center py-2 cursor-pointer"
        onClick={toggleCollapse}
        title="展开侧边栏"
      >
        <span className="text-neutral-400 hover:text-neutral-200 text-sm">▶</span>
        {collapsedLabel && (
          <span className="text-xs text-neutral-500 mt-4" style={{ writingMode: 'vertical-rl' }}>
            {collapsedLabel}
          </span>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="shrink-0 flex" style={{ width }}>
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* 收起按钮 */}
        <div className="flex justify-end px-1 py-0.5 shrink-0">
          <button
            type="button"
            onClick={toggleCollapse}
            title="收起侧边栏"
            className="text-neutral-500 hover:text-neutral-200 text-xs px-1"
          >
            ◀
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          {children}
        </div>
      </div>
      {/* 拖拽条 */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          dragging.current = true;
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }}
        onDoubleClick={toggleCollapse}
        className="w-1 cursor-col-resize bg-border-subtle hover:bg-accent-blue/50 transition-colors shrink-0"
        title="拖拽调整宽度（双击收起）"
      />
    </div>
  );
}
