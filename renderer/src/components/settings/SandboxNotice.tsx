// renderer/src/components/settings/SandboxNotice.tsx
//
// v2.4 首启提示卡（spec §6.3）：Linux bwrap 安装引导 / Windows ExecutionPolicy 授权指引。
// 非模态、可忽略（kv 记忆经主进程 dismissPrompt 持久化）；安装/授权后 reprobe 刷新，
// 满足可用条件即自然消失。显隐条件（单卡容器，三者并存时 netOff 优先——最可行动）：
//   - netOff 卡：netBlockedSeen（stream.store 实时检测标志）&& !netPromptDismissed
//   - bwrap 卡：linux && !available && !bwrapPromptDismissed && installCommand 存在
//   - 授权卡：win32 && executionPolicy === 'Restricted' && !winPolicyPromptDismissed
// 样式照抄 UpgradeNotice（fixed right-4 bottom-4 非模态卡片 + 语义 token）。
import { useEffect, useState } from 'react';
import { ClipboardCopy, X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { SandboxInfo } from '../../ipc/types';
import { useStreamStore } from '../../stores/stream.store';
import { useUiStore } from '../../stores/ui.store';
import { Button } from '../ui/Button';

/** PowerShell 授权命令（CurrentUser 作用域 + RemoteSigned）；卡片展示与复制单点对齐 */
const WIN_POLICY_COMMAND = 'Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned';

/** 复制到剪贴板；失败静默——code 块本身 select-all，用户仍可手动选中复制 */
const copyText = (text: string): void => {
  try {
    void navigator.clipboard.writeText(text).catch(() => {});
  } catch {
    // clipboard API 不可用（非安全上下文等）：静默降级为手动选中复制
  }
};

export function SandboxNotice() {
  const [info, setInfo] = useState<SandboxInfo | null>(null);
  const [busy, setBusy] = useState(false);
  // netOff 拦截一次性标志（stream.store 实时检测）；导航走真实 ui.store（不强求定位到安全沙箱分类）
  const netBlockedSeen = useStreamStore((s) => s.netBlockedSeen);
  const setActiveView = useUiStore((s) => s.setActiveView);

  // 挂载一次性拉取聚合信息
  useEffect(() => {
    void ipc.sandbox.getState().then(setInfo);
  }, []);

  // netOff 卡不依赖探测 state（tag 在场即证明沙箱当时在跑）；bwrap/授权卡仍需 state
  if (!info) return null;

  const showNetOff = netBlockedSeen && !info.netPromptDismissed;
  const showBwrap =
    !showNetOff &&
    info.state !== null &&
    info.state.platform === 'linux' &&
    !info.state.available &&
    !info.bwrapPromptDismissed &&
    info.installCommand !== null;
  const showWinPolicy =
    !showNetOff &&
    info.state !== null &&
    info.state.platform === 'win32' &&
    info.state.executionPolicy === 'Restricted' &&
    !info.winPolicyPromptDismissed;
  if (!showNetOff && !showBwrap && !showWinPolicy) return null;

  // 忽略提示卡：kv 持久化（主进程）+ 本地立即隐藏
  const dismiss = (kind: 'bwrap' | 'winPolicy' | 'netOff'): void => {
    void ipc.sandbox.dismissPrompt(kind);
    setInfo(
      kind === 'bwrap'
        ? { ...info, bwrapPromptDismissed: true }
        : kind === 'winPolicy'
          ? { ...info, winPolicyPromptDismissed: true }
          : { ...info, netPromptDismissed: true },
    );
  };

  // 一键安装：pkexec 装包 → 重新探测刷新。装好（available=true）卡片自然消失；
  // 失败（ok:false）reprobe 后仍不可用，卡片保留——用户可改用展示中的手动命令。
  const install = async (): Promise<void> => {
    setBusy(true);
    try {
      await ipc.sandbox.installBwrap();
      setInfo(await ipc.sandbox.reprobe());
    } finally {
      setBusy(false);
    }
  };

  // 手动授权后重新检测：仅 reprobe 刷新（策略放开 → 卡片消失）
  const recheck = async (): Promise<void> => {
    setInfo(await ipc.sandbox.reprobe());
  };

  return (
    <div
      data-testid="sandbox-notice"
      className="fixed right-4 bottom-4 z-40 w-[360px] max-w-[calc(100vw-2rem)] rounded-lg border border-subtle bg-surface-1 shadow-xl p-4 text-sm text-secondary"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h2 className="text-base font-semibold text-primary">
          {showNetOff
            ? 'agent 的网络访问被沙箱拦截'
            : showBwrap
              ? 'bash 沙箱需要 bubblewrap'
              : 'PowerShell 脚本执行未授权'}
        </h2>
        <button
          type="button"
          aria-label="关闭"
          onClick={() =>
            dismiss(showNetOff ? 'netOff' : showBwrap ? 'bwrap' : 'winPolicy')
          }
          className="text-tertiary hover:text-primary leading-none -mt-1"
        >
          <X size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      {showNetOff ? (
        <>
          <p className="mb-3 leading-relaxed">
            bash 沙箱的网络开关当前为关，agent
            无法监听端口或访问网络（含 DNS）。如需其启动 dev server 或联网，请到
            设置 → 安全沙箱 打开网络开关——即时生效，无需重启。
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setActiveView('settings')}>
              去设置
            </Button>
            <Button onClick={() => dismiss('netOff')}>知道了</Button>
          </div>
        </>
      ) : showBwrap ? (
        <>
          <p className="mb-3 leading-relaxed">
            未安装 bwrap 时，bash 工具的 OS 沙箱不可用（strict 模式下 bash 将拒绝执行）。建议安装：
          </p>
          <code className="block border border-subtle bg-canvas rounded px-2 py-1.5 font-mono text-xs text-secondary select-all break-all mb-3">
            {info.installCommand}
          </code>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => copyText(info.installCommand ?? '')}>
              <ClipboardCopy size={16} strokeWidth={1.75} aria-hidden />
              复制命令
            </Button>
            <Button variant="ghost" onClick={() => dismiss('bwrap')}>
              暂不
            </Button>
            <Button onClick={() => void install()} disabled={busy}>
              {busy ? '安装中…' : '一键安装'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="mb-3 leading-relaxed">
            Windows 默认禁止运行 .ps1
            脚本。如需 agent 执行脚本文件，请在 PowerShell 中手动运行以下命令授权（当前用户作用域），完成后回到此处重新检测：
          </p>
          <code className="block border border-subtle bg-canvas rounded px-2 py-1.5 font-mono text-xs text-secondary select-all break-all mb-3">
            {WIN_POLICY_COMMAND}
          </code>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => copyText(WIN_POLICY_COMMAND)}>
              <ClipboardCopy size={16} strokeWidth={1.75} aria-hidden />
              复制
            </Button>
            <Button onClick={() => void recheck()}>我已授权，重新检测</Button>
          </div>
        </>
      )}
    </div>
  );
}
