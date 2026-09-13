// renderer/src/components/settings/NetworkTrustCard.tsx
//
// v2.4.x 网络信任卡（spec 2026-09-13 §6，方案 A 阻塞式——镜像 BrowserTrustNotice
// 结构）：策略 ask 且 agent 的 bash 命令因网络被拦截失败时，主进程经 sandbox:notice
// 推送 kind='net-trust-request'，agent 环路在主进程侧阻塞等待本卡应答（180s 内有效；
// 超时主进程侧自动按拒绝收敛、卡片倒计时归零自散——此后补点为 no-op，spec §5 协议 6）：
//   - 「允许本次任务」→ answerNetworkTrust(session)（该 streamSessionId 后续 spawn
//     net-on；任务结束即失效）
//   - 「永久允许」→ answerNetworkTrust(always)（落库 networkPolicy=allow + 本任务即刻生效）
//   - 「保持拒绝」→ answerNetworkTrust(deny)（本任务内不再询问；不持久化）
// 应答目标 = notice.streamSessionId（镜像 BrowserNotice.workspaceId 的 M7 路由语义——
// 应答必须回到发卡的任务流）。卡片出现时一并置位 netBlockedSeen（spec §6 防双弹：
// ask 策略下网络失败由本卡负责，SandboxNotice 的 netOff 信息卡不再弹）。
// 挂载点 App 层（与 SandboxNotice / BrowserTrustNotice 一致）。
import { useEffect, useState } from 'react';
import { ShieldQuestion } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { NetworkTrustNotice, NetworkTrustAnswer } from '../../ipc/types';
import { useStreamStore } from '../../stores/stream.store';
import { Button } from '../ui/Button';

/** 倒计时窗口（秒）——主进程 NETWORK_TRUST_TIMEOUT_MS 的渲染端镜像（同一机器时钟） */
const TRUST_WINDOW_SEC = 180;

export function NetworkTrustCard() {
  const [notice, setNotice] = useState<NetworkTrustNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remainSec, setRemainSec] = useState<number>(TRUST_WINDOW_SEC);
  const markNetBlockedSeen = useStreamStore((s) => s.markNetBlockedSeen);

  // 订阅统一通知推送（卸载清理）；只消费 net-trust-request，其余 kind 忽略
  useEffect(() => {
    const unsubscribe = ipc.sandbox.onNetworkNotice((n) => {
      if (n.kind !== 'net-trust-request') return;
      setNotice(n);
      // spec §6 防双弹：信任卡路径一并置位 netBlockedSeen——SandboxNotice 的 netOff
      // 信息卡（仅 deny 策略展示）不与本卡叠加
      markNetBlockedSeen();
    });
    return unsubscribe;
  }, [markNetBlockedSeen]);

  // 倒计时（秒级）：窗口从 notice.createdAt 起算（两端同机时钟）。归零卡片自散——
  // 主进程同刻已按拒绝收敛，此后应答为迟到 no-op（spec §5 协议 5/6）
  useEffect(() => {
    if (notice === null) return;
    const tick = (): void => {
      const remain = Math.max(
        0,
        Math.ceil((notice.createdAt + TRUST_WINDOW_SEC * 1000 - Date.now()) / 1000),
      );
      setRemainSec(remain);
      if (remain <= 0) setNotice(null);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [notice]);

  if (notice === null) return null;

  const answer = async (value: NetworkTrustAnswer): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.sandbox.answerNetworkTrust(notice.streamSessionId, value);
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
      data-testid="network-trust-card"
      className="fixed right-4 bottom-4 z-40 w-[360px] max-w-[calc(100vw-2rem)] rounded-lg border border-subtle bg-surface-1 shadow-xl p-4 text-sm text-secondary"
    >
      <div className="flex items-start gap-2 mb-2">
        <ShieldQuestion size={16} strokeWidth={1.75} className="text-tertiary shrink-0 mt-0.5" aria-hidden />
        <div>
          <h2 className="text-base font-semibold text-primary">agent 请求使用网络</h2>
          <p className="text-xs text-tertiary mt-0.5">{notice.text}</p>
        </div>
      </div>
      <p className="text-xs text-tertiary mb-2" data-testid="network-trust-countdown">
        {remainSec} 秒内未应答将自动按拒绝处理
      </p>
      {error !== null && (
        <div className="mb-2 rounded border border-status-error/40 bg-status-error-tint px-2 py-1 text-xs text-status-error">
          应答失败：{error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => void answer('deny')}>
          保持拒绝
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void answer('session')}>
          允许本次任务
        </Button>
        <Button disabled={busy} onClick={() => void answer('always')}>
          永久允许
        </Button>
      </div>
    </div>
  );
}
