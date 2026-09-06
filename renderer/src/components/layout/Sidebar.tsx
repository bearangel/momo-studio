// renderer/src/components/layout/Sidebar.tsx
//
// 侧边栏容器（v2.2 宽度拖拽 + 完全收起改造）：ViewSidebar 的展开态外壳。
// - 顶部 36px 头部行：视图标题 + 收起按钮（PanelLeftClose）
// - 右缘 4px 分隔条：拖拽调宽（本地预览，pointerup/pointercancel 一次提交 onWidthCommit）；
//   双击重置默认 260
// - 收起态（完全消失）由 ViewSidebar 判定 return null，本组件不再渲染 48px 图标轨
//
// 拖拽 move/up 监听挂 window：真实 DOM 中 setPointerCapture 后事件仍冒泡到 window，
// jsdom 无 capture API（try/catch guard），两环境语义一致——移出侧边栏仍可跟踪。
import { useRef, useState, type ReactNode } from 'react';
import { PanelLeftClose } from 'lucide-react';
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from '../../stores/ui.store';

interface SidebarProps {
  label: string;
  /** 当前宽度（px），来自 ui.store.sidebarWidths[view] */
  width: number;
  /** 拖拽结束 / 双击重置时提交新宽度（ViewSidebar 绑 setSidebarWidth） */
  onWidthCommit: (width: number) => void;
  /** 头部收起按钮回调（ViewSidebar 绑 toggleSidebar） */
  onCollapse: () => void;
  children?: ReactNode;
}

const clampWidth = (w: number): number =>
  Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(w)));

export function Sidebar({ label, width, onWidthCommit, onCollapse, children }: SidebarProps) {
  // 拖拽本地预览宽度：null = 非拖拽。拖拽期间不写 store（避免每帧 setState + localStorage）
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  // 手势上下文：起点 clientX / 起始宽度；lastX 记录最新位置供 up 时提交
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const lastX = useRef(0);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    dragStart.current = { x: e.clientX, width };
    lastX.current = e.clientX;
    // 真实 DOM：锁定指针；jsdom 无此 API，guard 调用
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom: setPointerCapture not implemented */
    }
    const onMove = (ev: PointerEvent): void => {
      if (!dragStart.current) return;
      lastX.current = ev.clientX;
      setPreviewWidth(clampWidth(dragStart.current.width + ev.clientX - dragStart.current.x));
    };
    // up / cancel 同路径：提交最新预览宽度（spec §6）
    const finish = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      const start = dragStart.current;
      dragStart.current = null;
      setPreviewWidth(null);
      if (start) onWidthCommit(clampWidth(start.width + lastX.current - start.x));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  const effectiveWidth = previewWidth ?? width;

  return (
    <div
      data-testid="view-sidebar"
      className={`relative shrink-0 border-r border-subtle bg-surface-1 flex overflow-hidden ${
        previewWidth !== null ? 'select-none' : ''
      }`}
      style={{ width: effectiveWidth }}
    >
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* 头部行（spec §5.5）：视图标题 + 收起按钮 */}
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-subtle pl-3.5 pr-1.5">
          <span className="text-xs font-medium text-secondary">{label}</span>
          <button
            type="button"
            aria-label="收起侧边栏"
            title="收起侧边栏（Ctrl/Cmd+B）"
            onClick={onCollapse}
            className="flex h-7 w-7 items-center justify-center rounded-md text-tertiary transition-colors hover:bg-surface-3 hover:text-primary"
          >
            <PanelLeftClose size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">{children}</div>
      </div>
      {/* 拖拽分隔条（spec §5.3） */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度（双击重置默认宽度）"
        data-testid="sidebar-resizer"
        onPointerDown={handlePointerDown}
        onDoubleClick={() => onWidthCommit(SIDEBAR_WIDTH_DEFAULT)}
        className={`w-1 shrink-0 cursor-col-resize touch-none transition-colors ${
          previewWidth !== null ? 'bg-accent-500' : 'bg-subtle hover:bg-accent-500'
        }`}
      />
      {/* 拖拽宽度角标：跟随分隔条位置，触界提示最小/最大 */}
      {previewWidth !== null && (
        <div
          data-testid="sidebar-width-badge"
          className="absolute top-2 z-10 -translate-x-1/2 rounded-md border border-accent-500 bg-surface-3 px-2 py-0.5 font-mono text-xs text-primary"
          style={{ left: effectiveWidth - 2 }}
        >
          {previewWidth}
          {previewWidth === SIDEBAR_WIDTH_MIN
            ? ' px · 最小'
            : previewWidth === SIDEBAR_WIDTH_MAX
              ? ' px · 最大'
              : ' px'}
        </div>
      )}
    </div>
  );
}
