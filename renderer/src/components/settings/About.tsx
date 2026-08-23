// renderer/src/components/settings/About.tsx
//
// 关于面板（P2 Task 7）：复用 `ipc.system.getInfo()` 既有通道展示版本/平台信息。
// SystemInfo 类型只声明 renderer 需要的字段（platform/arch/nodeVersion/appVersion/userDataDir），
// electron 端额外返回的 electronVersion 暂不展示（无对应字段类型；如需后续可扩展）。
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
        <h2 className="text-neutral-100 text-base">关于</h2>
        {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
        {!error && <p className="text-sm text-neutral-400">加载中...</p>}
      </div>
    );
  }

  const rows: Array<{ label: string; value: string }> = [
    { label: '应用版本', value: info.appVersion },
    { label: '平台', value: info.platform },
    { label: '架构', value: info.arch },
    { label: 'Node 版本', value: info.nodeVersion },
  ];

  return (
    <div className="space-y-4 max-w-[560px]">
      <h2 className="text-neutral-100 text-base">关于</h2>
      <p className="text-sm text-neutral-400">Momo Studio 是本地桌面端多 agent 协作平台。</p>

      <div className="border border-border-subtle rounded-lg bg-bg-secondary p-4 flex flex-col gap-2"
        data-testid="about-info-card">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-3 text-sm">
            <span className="text-neutral-500 w-24">{r.label}</span>
            <span className="text-neutral-100 font-mono">{r.value}</span>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-neutral-500">
        数据目录：<code className="font-mono">{info.userDataDir}</code>
      </p>
    </div>
  );
}