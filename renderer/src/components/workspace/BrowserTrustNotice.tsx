// renderer/src/components/workspace/BrowserTrustNotice.tsx
//
// v2.7 浏览器信任卡（spec §5.2）：trust=ask 且 agent 首次调用浏览器工具时，主进程
// 经 browser:notice 推送 kind='trust-request'，本组件在右下角呈现三按钮卡
// （SandboxNotice/ResumeNotice 同款基建，样式照抄）：
//   - 「本次会话允许」→ answerTrust('session')（会话放行，内存态）
//   - 「永久允许」→ answerTrust('always')（落库 trust=always）
//   - 「取消」→ answerTrust('deny')（无操作，工具侧保持 NotTrusted 失败语义）
// 应答成功卡片即消散；失败保留卡片 + 错误行（ResumeNotice 同语义，不静默吞）。
//
// 挂载点 App 层（与 SandboxNotice/ResumeNotice 一致）。v2.7 review M7 起信任卡路由
// 用 notice.workspaceId（载荷携带）替代 useWorkspaceStore 的当前激活 workspace 推导——
// 后者在用户切 ws / tool 跨 ws 上下文场景下脆弱：用户切到 B ws，agent 在 A ws 首调工具
// 推出的卡片可能错误路由到 B ws；载荷携带保证「卡的目标 = notice 的发送方 ws」。
import { useEffect, useState } from 'react';
import { ShieldQuestion } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { BrowserNotice, BrowserTrustAnswer } from '../../ipc/types';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';

export function BrowserTrustNotice() {
  const [notice, setNotice] = useState<BrowserNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 防御用：notice.workspaceId 缺失时（极旧版本 main 推）回退到当前活跃 ws——空串表示无目标
  const activeWorkspace = useWorkspaceStore((s) => s.getActive());

  // 订阅统一通知推送（卸载清理）；只消费 trust-request，其余 kind 忽略
  useEffect(() => {
    const unsubscribe = ipc.browser.onBrowserNotice((n) => {
      if (n.kind === 'trust-request') setNotice(n);
    });
    return unsubscribe;
  }, []);

  // 应答目标 = notice.workspaceId（M7）；无载荷时回退活跃 ws，仍无则不渲染（应答无目标）
  const targetWsId = notice?.workspaceId || activeWorkspace?.id;
  if (!notice || !targetWsId) return null;

  const answer = async (value: BrowserTrustAnswer): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.browser.answerTrust(targetWsId, value);
      setNotice(null); // 应答成功 → 卡片消散
    } catch (err) {
      // 失败保留卡片 + 错误行——决策未完成，用户可重试或换一个应答
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="browser-trust-notice"
      className="fixed right-4 bottom-4 z-40 w-[360px] max-w-[calc(100vw-2rem)] rounded-lg border border-subtle bg-surface-1 shadow-xl p-4 text-sm text-secondary"
    >
      <div className="flex items-start gap-2 mb-2">
        <ShieldQuestion size={16} strokeWidth={1.75} className="text-tertiary shrink-0 mt-0.5" aria-hidden />
        <div>
          <h2 className="text-base font-semibold text-primary">agent 请求使用浏览器</h2>
          <p className="text-xs text-tertiary mt-0.5">{notice.text}</p>
        </div>
      </div>
      {error !== null && (
        <div className="mb-2 rounded border border-status-error/40 bg-status-error-tint px-2 py-1 text-xs text-status-error">
          应答失败：{error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => void answer('deny')}>
          取消
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void answer('session')}>
          本次会话允许
        </Button>
        <Button disabled={busy} onClick={() => void answer('always')}>
          永久允许
        </Button>
      </div>
    </div>
  );
}
