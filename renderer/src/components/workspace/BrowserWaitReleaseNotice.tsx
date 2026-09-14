// renderer/src/components/workspace/BrowserWaitReleaseNotice.tsx
//
// 接管释放提示卡（spec 2026-09-14 §4.3）：agent 的 browser_* 工具驻留等待时，
// 主进程推 kind=agent-waiting-release notice。三个卸载出口：
//   1. browser:state takeover='agent'（手动释放 / 空闲自愈——目标 ws 匹配才卸载）
//   2. 本地 durationMs 兜底计时（超时出口——takeover 不翻转，state 不触发）
//   3. 收到新的 agent-waiting-release notice 刷新计时（单飞下不应出现，防御）
// 动作：单一按钮走既有 releaseTakeover 通道（零新 IPC）；失败保留卡片 +
// 错误行（信任卡同语义，不静默吞），按钮复能可重试。
// 挂载点 App 层（与 BrowserTrustNotice 一致）；路由用 notice.workspaceId（M7 语义）。
import { useEffect, useRef, useState } from 'react';
import { MousePointerClick } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { BrowserNotice } from '../../ipc/types';
import { Button } from '../ui/Button';

export function BrowserWaitReleaseNotice() {
  const [notice, setNotice] = useState<BrowserNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const offNotice = ipc.browser.onBrowserNotice((n) => {
      if (n.kind === 'agent-waiting-release') {
        setError(null); // 新一轮等待开始——上一轮的释放失败不跨轮残留（终审 I2）
        setNotice(n);
      }
    });
    const offState = ipc.browser.onBrowserState((s) => {
      // 仅目标 ws 回切才卸载（用户切走查看其他 ws 不误删卡片）
      if (notice && s.workspaceId === notice.workspaceId && s.takeover === 'agent') {
        setNotice(null);
        setError(null); // 卡片生命周期结束即清——error 不跨生命周期存活（终审 I2）
      }
    });
    return () => { offNotice(); offState(); };
  }, [notice]);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (notice?.durationMs && notice.durationMs > 0) {
      timerRef.current = setTimeout(() => setNotice(null), notice.durationMs + 2_000);
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [notice]);

  if (!notice) return null;

  const release = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.browser.releaseTakeover(notice.workspaceId);
      setNotice(null);
    } catch (err) {
      // 失败保留卡片 + 错误行——释放未完成，用户可重试（信任卡同语义，不静默吞）
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="browser-wait-release-notice"
      className="fixed right-4 bottom-4 z-40 w-[360px] max-w-[calc(100vw-2rem)] rounded-lg border border-subtle bg-surface-1 shadow-xl p-4 text-sm text-secondary"
    >
      <div className="flex items-start gap-2 mb-2">
        <MousePointerClick size={16} strokeWidth={1.75} className="text-tertiary shrink-0 mt-0.5" aria-hidden />
        <div>
          <h2 className="text-base font-semibold text-primary">agent 正在等待浏览器</h2>
          <p className="text-xs text-tertiary mt-0.5">{notice.text}</p>
        </div>
      </div>
      {error !== null && (
        <div className="mb-2 rounded border border-status-error/40 bg-status-error-tint px-2 py-1 text-xs text-status-error">
          释放失败：{error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button disabled={busy} onClick={() => void release()}>释放并继续</Button>
      </div>
    </div>
  );
}
