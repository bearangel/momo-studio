// renderer/src/components/hub/HubInstallNotice.tsx
//
// P2-7 补装进度通知面（M2.2 T5）：右下角固定补装条，worker 侧镜像补装
// （大包如 56MB 插件下载/解压）全程可见。数据源 hub-install-progress.store
// （hub:installProgress 推送）；本组件自带订阅生命周期（MainShell 挂载一次，
// 与 ConflictDialogMount 同层纪律）。视觉对齐 Toast 原子件语义 token。
import { useEffect, type ReactNode } from 'react';
import { CircleCheck, CircleX, Package } from 'lucide-react';
import { initHubInstallProgress, useHubInstallProgressStore } from '../../stores/hub-install-progress.store';
import type { HubInstallProgressEvent } from '../../ipc/types';

/** 字节人话（B/KB/MB，一位小数——56MB 级大包主场景） */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function statusText(e: HubInstallProgressEvent): string {
  switch (e.stage) {
    case 'downloading': {
      if (typeof e.receivedBytes !== 'number') return '下载中';
      const received = fmtBytes(e.receivedBytes);
      return typeof e.totalBytes === 'number' ? `下载中 ${received} / ${fmtBytes(e.totalBytes)}` : `下载中 ${received}`;
    }
    case 'extracting':
      return '解压中';
    case 'done':
      return '完成';
    case 'failed':
      return '失败';
  }
}

function StageIcon({ stage }: { stage: HubInstallProgressEvent['stage'] }): ReactNode {
  if (stage === 'downloading' || stage === 'extracting') {
    return (
      <span
        role="img"
        aria-label={stage === 'downloading' ? '下载中' : '解压中'}
        className="mt-0.5 h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-status-violet border-t-transparent"
      />
    );
  }
  if (stage === 'done') {
    return <CircleCheck size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-status-success" aria-hidden />;
  }
  return <CircleX size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-status-error" aria-hidden />;
}

/** 右下角补装进度条栈（空态零渲染） */
export function HubInstallNotice(): ReactNode {
  const entries = useHubInstallProgressStore((s) => s.entries);
  useEffect(() => initHubInstallProgress(), []);

  const list = Object.values(entries);
  if (list.length === 0) return null;
  return (
    <div
      data-testid="hub-install-notice"
      role="status"
      className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-80 flex-col gap-2"
    >
      {list.map((e) => (
        <div
          key={`${e.type}:${e.slug}`}
          data-testid={`hub-install-notice-${e.type}:${e.slug}`}
          className="pointer-events-auto flex items-start gap-2 rounded-lg border border-subtle bg-surface-1 p-3 shadow-lg"
        >
          <StageIcon stage={e.stage} />
          <p
            className="min-w-0 flex-1 break-words text-xs leading-4 text-secondary"
            title={e.stage === 'failed' ? e.message : undefined}
          >
            <b className="font-medium text-primary">补装 {e.slug}</b>
            <span className={e.stage === 'failed' ? ' text-status-error' : ''}>：{statusText(e)}</span>
            {e.stage === 'failed' && e.message && (
              <span className="block truncate text-status-error">{e.message}</span>
            )}
          </p>
          <Package size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-tertiary" aria-hidden />
        </div>
      ))}
    </div>
  );
}
