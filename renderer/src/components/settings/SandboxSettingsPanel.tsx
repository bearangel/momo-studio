// renderer/src/components/settings/SandboxSettingsPanel.tsx
//
// v2.4 安全沙箱设置（spec §6.4）：沙箱模式 / 沙箱内网络出站 / 探测状态只读区。
// 状态与重探测走 ipc.sandbox（Task 7）；设置保存走 ipc.settings.updateGlobal。
// 2026-09-13 修订 B：网络出站三态收敛双态（永久允许（默认）/ 拒绝）——
// ask 信任卡机制已下线，垂直单选列表 + 行内说明保持既有形态。
// v2.5 工具链授权（Task 7，spec §10）：网络出站区块后追加工具链目录写入双态
// radio + 目录清单 textarea（显式「保存清单」/「恢复默认」按钮，失焦不自动存）。
// 全语义 token；lucide ShieldCheck 图标由 SettingsNav 持有。
import { useEffect, useState } from 'react';
import { ipc } from '../../ipc/client';
import type { SandboxInfo, SandboxMode, NetworkPolicy, ToolchainPolicy } from '../../ipc/types';
import { Button } from '../ui/Button';

const NETWORK_POLICY_OPTIONS: readonly { value: NetworkPolicy; label: string; hint: string }[] = [
  { value: 'allow', label: '永久允许（默认）', hint: '沙箱内 bash 全放行网络（含端口监听）' },
  { value: 'deny', label: '拒绝', hint: '沙箱内 bash 一律禁网，网络失败时显示一次性引导卡' },
];

const TOOLCHAIN_POLICY_OPTIONS: readonly { value: ToolchainPolicy; label: string; hint: string }[] = [
  { value: 'deny', label: '拦截（默认）', hint: '沙箱内不可写工具链目录' },
  { value: 'allow', label: '永久允许', hint: '清单内目录可写' },
];

/** 默认五项清单——与 electron 端 toolchain-grant.ts DEFAULT_TOOLCHAIN_DIRS 对齐
 * （事实源在主进程，此处镜像供「恢复默认」写回；漂移由面板测试五项断言拦截）。 */
export const DEFAULT_TOOLCHAIN_DIRS: readonly string[] = [
  '~/.rustup',
  '~/.cargo',
  '~/go',
  'npm:global-prefix',
  'pip:user',
];

export function SandboxSettingsPanel() {
  const [info, setInfo] = useState<SandboxInfo | null>(null);
  const [busy, setBusy] = useState(false);
  // 清单编辑态：dirty = 用户改过 textarea 且未保存——info 刷新（reprobe）不覆盖
  const [dirsText, setDirsText] = useState('');
  const [dirsDirty, setDirsDirty] = useState(false);

  useEffect(() => {
    void ipc.sandbox.getState().then(setInfo);
  }, []);

  // info 刷新（挂载 / reprobe / 保存乐观 setInfo）同步清单文本；dirty 时保留用户输入。
  // 依赖数组用 toolchainDirs 引用：radio 类保存复用原数组引用 → 不误触同步。
  useEffect(() => {
    if (!dirsDirty) setDirsText((info?.settings.toolchainDirs ?? []).join('\n'));
  }, [info?.settings.toolchainDirs, dirsDirty]);

  // 乐观更新：本地先改 UI，保存 fire-and-forget（与全局设置单一真相源弱一致）
  const save = (patch: {
    sandboxMode?: SandboxMode;
    sandboxNetworkPolicy?: NetworkPolicy;
    sandboxToolchainPolicy?: ToolchainPolicy;
    sandboxToolchainDirs?: string[];
  }): void => {
    if (!info) return;
    setInfo({
      ...info,
      settings: {
        mode: patch.sandboxMode ?? info.settings.mode,
        networkPolicy: patch.sandboxNetworkPolicy ?? info.settings.networkPolicy,
        toolchainPolicy: patch.sandboxToolchainPolicy ?? info.settings.toolchainPolicy,
        toolchainDirs: patch.sandboxToolchainDirs ?? info.settings.toolchainDirs,
      },
    });
    // IPC 拒绝不冒泡 unhandled rejection（乐观 UI 弱一致，下次拉取自然校正）
    void ipc.settings.updateGlobal(patch).catch(() => {});
  };

  // 显式保存：按行拆分 + trim + 去空行；清 dirty 让同步 effect 归一化回显
  const saveDirs = (): void => {
    const dirs = dirsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    setDirsDirty(false);
    save({ sandboxToolchainDirs: dirs });
  };

  const resetDirs = (): void => {
    setDirsDirty(false);
    save({ sandboxToolchainDirs: [...DEFAULT_TOOLCHAIN_DIRS] });
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

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-primary">沙箱内网络出站</legend>
        {NETWORK_POLICY_OPTIONS.map((o) => (
          <label key={o.value} className="flex items-start gap-2 text-sm text-secondary">
            <input
              type="radio"
              name="sandbox-network-policy"
              checked={info.settings.networkPolicy === o.value}
              onChange={() => save({ sandboxNetworkPolicy: o.value })}
              className="mt-1"
              aria-label={o.label}
            />
            <span>
              {o.label}——{o.hint}
            </span>
          </label>
        ))}
        <p className="text-xs text-tertiary">仅影响沙箱内 bash；LLM API 调用不受影响。</p>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-primary">工具链目录写入</legend>
        {TOOLCHAIN_POLICY_OPTIONS.map((o) => (
          <label key={o.value} className="flex items-start gap-2 text-sm text-secondary">
            <input
              type="radio"
              name="sandbox-toolchain-policy"
              checked={info.settings.toolchainPolicy === o.value}
              onChange={() => save({ sandboxToolchainPolicy: o.value })}
              className="mt-1"
              aria-label={o.label}
            />
            <span>
              {o.label}——{o.hint}
            </span>
          </label>
        ))}
        <p className="text-xs text-tertiary">仅影响清单内目录；拦截时会话引导卡可临时授权。</p>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-primary">工具链目录清单</legend>
        <textarea
          aria-label="工具链目录清单"
          className="w-full min-h-24 rounded-md border border-subtle bg-surface-1 p-2 font-mono text-xs text-secondary"
          value={dirsText}
          onChange={(e) => {
            setDirsText(e.target.value);
            setDirsDirty(true);
          }}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={resetDirs}>
            恢复默认
          </Button>
          <Button size="sm" onClick={saveDirs}>
            保存清单
          </Button>
        </div>
        <p className="text-xs text-tertiary">每行一个路径；支持 ~ 前缀；npm:global-prefix / pip:user 为自动探测项。</p>
      </fieldset>

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
