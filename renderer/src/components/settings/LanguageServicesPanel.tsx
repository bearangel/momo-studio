// renderer/src/components/settings/LanguageServicesPanel.tsx
//
// 设置页「语言服务」面板（多语言 LSP 子系统 Task 6，spec §10 已确认线框）：
//   - 数据源：invoke lsp:status(workspaceId) / lsp:redetect(workspaceId)（主进程
//     detect.ts 单一真相源；本组件不做任何探测）
//   - 每语言一行三态：ready（工程标志 ✓ + 二进制 ✓ + 运行态）/ missing-binary
//     （工程标志 ✓ + 二进制 ✗ → 第二行「未安装 + installHint」；installable 行
//     含一键「安装」按钮（D3 修正案——npm 分发语言装到 <userData>/lsp-bin），
//     其余保持复制命令引导）/ inactive（工程标志 ✗ → 整行灰显「未检测到工程标志」）
//   - 实验性徽标仅 experimental 行；「重新检测」busy 态禁用 + 图标旋转
//   - 加载失败只渲染错误行，不抛错不阻塞设置页其余 section
import { useCallback, useEffect, useState } from 'react';
import { Check, PackagePlus, RefreshCw, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { CopyButton } from '../ui/CopyButton';
import { cn } from '../../lib/cn';
import { ipc } from '../../ipc/client';
import type { LanguageStatus } from '../../ipc/types';

const RUNNING_LABEL: Record<LanguageStatus['running'], string> = {
  running: '运行中',
  idle: '闲置',
  stopped: '未启动',
};

const RUNNING_CLASS: Record<LanguageStatus['running'], string> = {
  running: 'text-status-success',
  idle: 'text-status-warning',
  stopped: 'text-tertiary',
};

export function LanguageServicesPanel({ workspaceId }: { workspaceId: string }): JSX.Element {
  const [statuses, setStatuses] = useState<LanguageStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 一键安装（D3 修正案）：安装中语言（null = 空闲）；失败文案保留列表呈现
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const load = useCallback(async (fn: (id: string) => Promise<LanguageStatus[]>) => {
    setBusy(true);
    setError(null);
    try {
      setStatuses(await fn(workspaceId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [workspaceId]);

  const install = useCallback(async (languageId: string) => {
    setInstalling(languageId);
    setInstallError(null);
    try {
      setStatuses(await ipc.lsp.install(workspaceId, languageId));
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(null);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load(ipc.lsp.status);
  }, [load]);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-primary">语言服务</h3>
          <p className="text-xs text-tertiary">
            检测本 workspace 的工程标志与语言 server 安装状态（16 门语言，4 门实验性）
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load(ipc.lsp.redetect)} disabled={busy}>
          <RefreshCw
            size={16}
            strokeWidth={1.75}
            aria-hidden
            className={busy ? 'animate-spin' : undefined}
          />
          重新检测
        </Button>
      </div>

      {error && <div className="text-sm text-status-error">加载失败：{error}</div>}

      {installError && (
        <div className="whitespace-pre-line text-xs text-status-error">安装失败：{installError}</div>
      )}

      {statuses === null && !error && <div className="text-sm text-tertiary py-4">检测中…</div>}

      {statuses !== null && (
        <ul className="flex flex-col gap-1.5">
          {statuses.map((s) => (
            <li
              key={s.languageId}
              className="flex flex-col gap-1 rounded border border-subtle bg-surface-2 px-2.5 py-2"
            >
              <div className="flex items-center gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span
                    className={cn(
                      'truncate text-sm',
                      s.toolchain ? 'text-primary' : 'text-disabled',
                    )}
                  >
                    {s.label}
                  </span>
                  {s.tier === 'experimental' && (
                    <span className="shrink-0 rounded bg-status-violet-tint px-1.5 py-px text-[10px] text-status-violet">
                      实验
                    </span>
                  )}
                </div>
                {s.toolchain ? (
                  <>
                    <span className="flex w-[4.5rem] shrink-0 items-center justify-end gap-1 text-xs text-secondary">
                      <Check size={16} strokeWidth={1.75} aria-hidden className="text-status-success" />
                      工程标志
                    </span>
                    <span className="flex w-14 shrink-0 items-center justify-end gap-1 text-xs text-secondary">
                      {s.binary ? (
                        <Check size={16} strokeWidth={1.75} aria-hidden className="text-status-success" />
                      ) : (
                        <X size={16} strokeWidth={1.75} aria-hidden className="text-status-error" />
                      )}
                      二进制
                    </span>
                    <span className={cn('w-14 shrink-0 text-right text-xs', RUNNING_CLASS[s.running])}>
                      {RUNNING_LABEL[s.running]}
                    </span>
                  </>
                ) : (
                  <span className="shrink-0 text-xs text-disabled">未检测到工程标志</span>
                )}
              </div>
              {s.toolchain && !s.binary && (
                <div className="flex min-w-0 items-center gap-2 pl-1 text-xs">
                  <span className="shrink-0 text-status-error">未安装</span>
                  <code className="min-w-0 flex-1 truncate font-mono text-secondary">
                    {s.installHint}
                  </code>
                  {s.installable ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="shrink-0"
                      onClick={() => void install(s.languageId)}
                      disabled={installing !== null}
                    >
                      <PackagePlus size={16} strokeWidth={1.75} aria-hidden />
                      {installing === s.languageId ? '安装中…' : '安装'}
                    </Button>
                  ) : (
                    <CopyButton text={s.installHint} />
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
