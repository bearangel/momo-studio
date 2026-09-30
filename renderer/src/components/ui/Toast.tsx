// renderer/src/components/ui/Toast.tsx
//
// 通用错误/告知通知条原子件(看板重构 Task 13):fixed 底部居中、3s 自动消散。
// 单例语义:同一时刻至多一条,新 toast 覆盖旧条并重置计时。
// 选型说明:renderer 无既有通用 toast——NoticeStack 是浏览器通知专用通道
// (订阅 ipc.browser.onBrowserNotice),故新建本最简原子件;视觉对齐 NoticeStack
// 的语义 token(bg-surface-1 / border-subtle / text-secondary)。
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { CircleAlert, X } from 'lucide-react';

const TOAST_TTL_MS = 3_000;

interface ToastEntry {
  id: number;
  text: string;
}

// 模块级单例 state:跨组件实例共享,useSyncExternalStore 订阅重渲染
let currentToast: ToastEntry | null = null;
let nextToastId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 显示一条 toast(单例:覆盖当前条并重置 3s 计时) */
export function showToast(text: string): void {
  // ID 生成在函数体(每次调用恰好一次),不在 render/updater 中——重放不消耗序号
  currentToast = { id: nextToastId++, text };
  emit();
}

/** 立即关闭当前 toast(手动关闭钮 / 测试复位) */
export function dismissToast(): void {
  if (currentToast === null) return;
  currentToast = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ToastEntry | null {
  return currentToast;
}

/** 底部居中通知条:消费方挂载一次,内容由 showToast 驱动 */
export function Toast(): ReactNode {
  const toast = useSyncExternalStore(subscribe, getSnapshot);

  // 3s 自动消散:toast 引用变化(新条覆盖)即重置计时
  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(dismissToast, TOAST_TTL_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  if (toast === null) return null;
  return (
    <div
      data-testid="ui-toast"
      role="status"
      className="pointer-events-auto fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-start gap-2 rounded-lg border border-subtle bg-surface-1 p-3 text-sm text-secondary shadow-lg"
    >
      <CircleAlert size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-status-error" aria-hidden />
      <p className="min-w-0 max-w-[420px] break-words text-xs leading-4">{toast.text}</p>
      <button
        type="button"
        aria-label="关闭提示"
        onClick={dismissToast}
        className="shrink-0 text-tertiary hover:text-primary"
      >
        <X size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}
