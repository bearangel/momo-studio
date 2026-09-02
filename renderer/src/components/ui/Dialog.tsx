// renderer/src/components/ui/Dialog.tsx
// 模态弹窗原子件：portal 到 body + 遮罩 + Esc/点遮罩关闭。
// 已知边界：SettingsView 的全局 Esc 返回与本组件 Esc 关闭会同时触发——
// P1 迁移设置页弹窗时由消费方处理（stopPropagation / 状态优先），此处保持简单语义。
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** 内容区宽度 px，默认 480 */
  width?: number;
}

export function Dialog({ open, onClose, title, children, footer, width = 480 }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    // 仅当内部无元素持焦时聚焦容器（autoFocus 输入框优先）；tabIndex=-1 使容器可编程聚焦
    if (dialogRef.current && !dialogRef.current.contains(document.activeElement)) {
      dialogRef.current.focus();
    }
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 bg-backdrop" onClick={onClose} aria-hidden />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-strong bg-surface-1 shadow-2xl outline-none',
        )}
        style={{ width }}
      >
        <header className="px-5 pb-3 pt-4">
          <h2 className="text-sm font-semibold text-primary">{title}</h2>
        </header>
        <div className="flex-1 overflow-auto px-5 pb-2 text-[13px] text-secondary">{children}</div>
        {footer ? <footer className="flex justify-end gap-2 px-5 py-4">{footer}</footer> : null}
      </div>
    </>,
    document.body,
  );
}