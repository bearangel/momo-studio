// renderer/src/components/settings/About.tsx
//
// 关于面板（P2 Task 7 / Fix 1）：复用 `ipc.system.getInfo()` 既有通道展示版本/平台信息。
// SystemInfo 与 electron 端 system.handlers.ts 返回结构对齐（含 electronVersion）。
import { useEffect, useState } from 'react';
import { ipc } from '../../ipc/client';
import type { SystemInfo } from '../../ipc/types';

export function About() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setInfo(await ipc.system.getInfo());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  if (!info) {
    return (
      <div className="space-y-4">
        <h2 className="text-primary text-base">关于</h2>
        {error && <p className="text-xs text-status-error" role="alert">{error}</p>}
        {!error && <p className="text-sm text-secondary">加载中...</p>}
      </div>
    );
  }

  const rows: Array<{ label: string; value: string }> = [
    { label: '应用版本', value: info.appVersion },
    { label: '平台', value: info.platform },
    { label: '架构', value: info.arch },
    { label: 'Electron 版本', value: info.electronVersion },
    { label: 'Node 版本', value: info.nodeVersion },
  ];

  return (
    <div className="space-y-4 max-w-[560px]">
      <h2 className="text-primary text-base">关于</h2>
      <p className="text-sm text-secondary">Momo Studio 是本地桌面端多 agent 协作平台。</p>

      <div className="rounded-lg border border-subtle bg-surface-1 p-4 flex flex-col gap-2"
        data-testid="about-info-card">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-3 text-sm">
            <span className="text-tertiary w-24">{r.label}</span>
            <span className="text-primary font-mono">{r.value}</span>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-tertiary">
        数据目录：<code className="font-mono">{info.userDataDir}</code>
      </p>
    </div>
  );
}
