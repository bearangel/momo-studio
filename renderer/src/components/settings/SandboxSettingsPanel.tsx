// renderer/src/components/settings/SandboxSettingsPanel.tsx
//
// v2.4 安全沙箱设置（spec §6.4）：沙箱模式 / 沙箱内网络出站 / 探测状态只读区。
// 状态与重探测走 ipc.sandbox（Task 7）；设置保存走 ipc.settings.updateGlobal。
// 全语义 token；lucide ShieldCheck 图标由 SettingsNav 持有。
import { useEffect, useState } from 'react';
import { ipc } from '../../ipc/client';
import type { SandboxInfo, SandboxMode } from '../../ipc/types';
import { Button } from '../ui/Button';

export function SandboxSettingsPanel() {
  const [info, setInfo] = useState<SandboxInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void ipc.sandbox.getState().then(setInfo);
  }, []);

  // 乐观更新：本地先改 UI，保存 fire-and-forget（与全局设置单一真相源弱一致）
  const save = (patch: { sandboxMode?: SandboxMode; sandboxNetwork?: boolean }): void => {
    if (!info) return;
    setInfo({
      ...info,
      settings: {
        mode: patch.sandboxMode ?? info.settings.mode,
        networkEnabled: patch.sandboxNetwork ?? info.settings.networkEnabled,
      },
    });
    void ipc.settings.updateGlobal(patch);
  };

  const reprobe = async (): Promise<void> => {
    setBusy(true);
    try {
      setInfo(await ipc.sandbox.reprobe());
    } finally {
      setBusy(false);
    }
  };

  if (!info) return <div className="p-4 text-secondary text-sm">加载中...</div>;

  const st = info.state;
  const statusText =
    st === null
      ? '未探测'
      : st.available
        ? `${st.toolVersion ?? st.sandboxTool} · 已启用`
        : st.platform === 'win32'
          ? `${st.windowsShell ?? 'powershell'} · 无 OS 沙箱（Windows）`
          : `不可用：${st.unavailableReason ?? '未知'}`;

  return (
    <section className="flex flex-col gap-6" aria-label="安全沙箱设置">
      <div>
        <h2 className="text-base text-primary mb-1">安全沙箱</h2>
        <p className="text-sm text-secondary">
          bash 工具的 OS 级隔离（macOS Seatbelt / Linux bubblewrap；Windows 无 OS 沙箱）。
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-primary">沙箱模式</legend>
        {(['strict', 'permissive'] as const).map((m) => (
          <label key={m} className="flex items-start gap-2 text-sm text-secondary">
            <input
              type="radio"
              name="sandbox-mode"
              checked={info.settings.mode === m}
              onChange={() => save({ sandboxMode: m })}
              className="mt-1"
            />
            <span>
              {m === 'strict'
                ? 'strict（推荐）——沙箱不可用时 bash 拒绝执行'
                : 'permissive——沙箱不可用时降级运行（无 OS 隔离，审计标记 unsandboxed）'}
            </span>
          </label>
        ))}
      </fieldset>

      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium text-primary">沙箱内网络出站</div>
        <label className="flex items-center gap-2 text-sm text-secondary">
          <input
            type="checkbox"
            checked={info.settings.networkEnabled}
            onChange={(e) => save({ sandboxNetwork: e.target.checked })}
          />
          <span>允许沙箱内 bash 访问网络（仅影响 bash；LLM API 调用不受影响）</span>
        </label>
      </div>

      <div className="rounded-lg border border-subtle bg-surface-2 p-3 flex flex-col gap-2">
        <div className="text-sm">
          <span className="text-tertiary">当前状态：</span>
          <span className="font-mono text-xs text-secondary">{statusText}</span>
        </div>
        <Button onClick={() => void reprobe()} disabled={busy}>
          {busy ? '探测中...' : '重新探测'}
        </Button>
      </div>
    </section>
  );
}
