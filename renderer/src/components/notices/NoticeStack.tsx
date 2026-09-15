// renderer/src/components/notices/NoticeStack.tsx
//
// Tier B 告知性提示堆叠（spec 2026-09-15 §4.3）：按安全区右下锚定（避让浏览器
// 侧栏——原生 WebContentsView 在 OS 合成层盖住一切 DOM），纵向堆叠、上限 4 条
// （超出丢最旧 + 计数行）、条目 6s 自动消散可手动关。
//
// kind 路由表（唯一渲染归属，防双渲染）：本组件只消费 INFO_KINDS 三 kind；
// trust-request → Tier A BrowserTrustNotice；agent-waiting-release → Tier A
// BrowserWaitReleaseBanner；未来新 kind 默认落此处（前向兼容）。
import { useEffect, useState } from 'react';
import { Info, X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { BrowserNotice } from '../../ipc/types';
import { useSafeArea } from '../../stores/browser-sidebar-rect.store';

const NOTICE_TTL_MS = 6_000;
const MAX_VISIBLE = 4;

/** Tier B 消费的 kind 集（路由表见文件头注） */
const INFO_KINDS = new Set(['crash-reloaded', 'popup-blocked', 'navigation-error']);

interface ToastEntry {
  id: number;
  kind: string;
  text: string;
}

let nextToastId = 1;

export function NoticeStack({ children }: { children?: React.ReactNode }) {
  const safe = useSafeArea();
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [overflowCount, setOverflowCount] = useState(0);

  useEffect(() => {
    const off = ipc.browser.onBrowserNotice((n: BrowserNotice) => {
      if (!INFO_KINDS.has(n.kind)) return;
      setToasts((prev) => {
        const appended = [...prev, { id: nextToastId++, kind: n.kind, text: n.text }];
        if (appended.length <= MAX_VISIBLE) return appended;
        setOverflowCount((c) => c + (appended.length - MAX_VISIBLE));
        return appended.slice(-MAX_VISIBLE);
      });
    });
    return off;
  }, []);

  // 自动消散：以队列首条为计时锚（6s 逐条滑出）
  useEffect(() => {
    if (toasts.length === 0) return;
    const t = setTimeout(() => {
      setToasts((prev) => prev.slice(1));
    }, NOTICE_TTL_MS);
    return () => clearTimeout(t);
  }, [toasts]);

  const dismiss = (id: number): void => {
    setToasts((prev) => prev.filter((e) => e.id !== id));
  };

  return (
    <div
      data-testid="notice-stack"
      className="pointer-events-none fixed bottom-4 z-40 flex w-[360px] flex-col gap-2"
      style={{ right: Math.max(16, window.innerWidth - safe.right + 16) }}
    >
      {overflowCount > 0 && (
        <div
          data-testid="notice-overflow"
          className="pointer-events-auto self-end rounded border border-subtle bg-surface-1 px-2 py-0.5 text-xs text-tertiary"
        >
          还有 {overflowCount} 条更早提示
        </div>
      )}
      {children}
      {toasts.map((e) => (
        <div
          key={e.id}
          data-testid="notice-toast"
          className="pointer-events-auto flex items-start gap-2 rounded-lg border border-subtle bg-surface-1 p-3 text-sm text-secondary shadow-lg"
        >
          <Info size={16} strokeWidth={1.75} className="text-tertiary shrink-0 mt-0.5" aria-hidden />
          <p className="min-w-0 flex-1 break-words text-xs leading-4">{e.text}</p>
          <button
            type="button"
            aria-label="关闭"
            onClick={() => dismiss(e.id)}
            className="shrink-0 text-tertiary hover:text-primary"
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
