// renderer/src/components/workgroup/UnifiedMirrorDialog.tsx
//
// 平行组「统一镜像」对话框（spec 2026-11-05 §6；形态预览
// .omo/previews/unified-mirror-dialog.html 2026-11-08 批准稿）：
//   - 打开即构建快照（CheckRow 进行时 → 七行真实计数 + 版本/大小/checksum 芯片）
//   - 成员多选（默认全勾就绪成员；不达标成员逐行列明原因，不再隐形过滤）
//   - 发起后逐行终态（成功含资源数 / 应用中 / 失败人话 + 单行重试）
//   - 壳按 MirrorWizard 节律自绘（560px / canvas 底 / subtle 边 / 10px 圆角）
//
// 防误关：任一行在途时关闭按钮/Esc/背景点击均无效（store.close 二道闸）。
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Check, Layers, Package, RefreshCw, TriangleAlert, X,
} from 'lucide-react';
import { useUnifiedMirrorStore } from '../../stores/unified-mirror.store';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Spinner } from '../ui/Spinner';
import { cn } from '../../lib/cn';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 构建清单行（对齐 MirrorWizard S2 CheckRow 形态） */
function CheckRow({ state, label, count }: { state: 'done' | 'run' | 'pend'; label: ReactNode; count?: ReactNode }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md px-2.5 py-[7px] text-[12.5px]',
        state === 'run' ? 'bg-surface-2 font-medium text-primary' : state === 'done' ? 'text-secondary' : 'text-tertiary',
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {state === 'done' ? (
          <Check size={16} strokeWidth={1.75} className="text-status-success" aria-hidden />
        ) : state === 'run' ? (
          <Spinner size={14} />
        ) : (
          <span className="text-border-strong">○</span>
        )}
      </span>
      <span className="min-w-0 flex-1">{label}</span>
      {count !== undefined && <span className="whitespace-nowrap text-[11px] text-tertiary">{count}</span>}
    </div>
  );
}

export function UnifiedMirrorDialog() {
  const st = useUnifiedMirrorStore();

  // Esc 关闭（在途禁关——与关闭按钮同一闸）
  useEffect(() => {
    if (!st.open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      useUnifiedMirrorStore.getState().close();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [st.open]);

  if (!st.open) return null;

  const s = st.snapshot?.summary;
  const inFlight = st.rows.some((r) => r.status === 'sending' || r.status === 'sent');
  const done = st.launched && !inFlight && !st.launching;
  const successCount = st.rows.filter((r) => r.status === 'success').length;
  const failedCount = st.rows.filter((r) => r.status === 'failed').length;
  const eligible = st.rows.filter((r) => r.eligible);
  const selectedCount = eligible.filter((r) => r.selected).length;
  const ineligibleCount = st.rows.length - eligible.length;

  const buildRows = (rowState: 'done' | 'pend'): ReactNode => (
    <>
      <CheckRow state={rowState} label="Agent 定义与成员清单" count={rowState === 'done' && s ? `${s.members} 定义 · ${s.members - s.embeddedMembers} 引用 + ${s.embeddedMembers} 内嵌` : undefined} />
      <CheckRow state={rowState} label="团队配置" count={rowState === 'done' && s ? `${s.teams} 个` : undefined} />
      <CheckRow state={rowState} label="MCP 启用清单（仅 stdio 引用）" count={rowState === 'done' && s ? `${s.mcp} 个` : undefined} />
      <CheckRow state={rowState} label="Skill 清单（补装 + 内嵌）" count={rowState === 'done' && s ? `${s.skillResources} 补装 + ${s.skillEmbedded} 内嵌` : undefined} />
      <CheckRow state={rowState} label="插件启用清单（hub 引用）" count={rowState === 'done' && s ? `${s.plugins} 个` : undefined} />
      <CheckRow state={rowState} label="Provider 引用与偏好（不含 Key）" count={rowState === 'done' && s ? `${s.providers} 个` : undefined} />
      <CheckRow state={rowState} label="打包 tar.gz 并计算校验和" count={rowState === 'done' && st.snapshot ? `v${st.snapshot.version} · ${formatBytes(st.snapshot.sizeBytes)}` : undefined} />
    </>
  );

  let primary: ReactNode;
  if (st.buildStatus === 'error') {
    primary = (
      <Button variant="secondary" size="sm" onClick={() => void st.rebuild()}>
        <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
        重试构建
      </Button>
    );
  } else if (!st.launched) {
    primary = (
      <Button
        variant="primary"
        size="sm"
        disabled={st.buildStatus !== 'done' || st.launching || selectedCount === 0}
        onClick={() => void st.launch()}
      >
        {st.launching ? '发起中…' : `向 ${selectedCount} 个成员发起镜像`}
      </Button>
    );
  } else if (done) {
    primary = (
      <Button variant="primary" size="sm" onClick={() => st.close()}>
        完成
      </Button>
    );
  } else {
    primary = (
      <Button variant="primary" size="sm" disabled>
        进行中 · {successCount + failedCount}/{st.rows.filter((r) => r.selected || r.status !== 'idle').length}
      </Button>
    );
  }

  let footLeft: ReactNode;
  if (!st.launched) {
    footLeft = st.buildStatus === 'done'
      ? `${selectedCount} 个成员就绪${ineligibleCount > 0 ? ` · ${ineligibleCount} 个不参与` : ''}`
      : '快照构建完成后可发起';
  } else {
    const parts: string[] = [];
    if (successCount > 0) parts.push(`${successCount} 成功`);
    if (inFlight) parts.push(`${st.rows.filter((r) => r.status === 'sending' || r.status === 'sent').length} 进行中`);
    if (failedCount > 0) parts.push(`${failedCount} 失败`);
    footLeft = parts.join(' · ');
  }

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 bg-backdrop" aria-hidden onClick={() => useUnifiedMirrorStore.getState().close()} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="统一镜像"
        className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-2rem)] w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[10px] border border-subtle bg-canvas shadow-2xl"
      >
        <div className="px-5 pb-3 pt-4">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-secondary">
              <Layers size={16} strokeWidth={1.75} aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-primary">统一镜像 · {st.groupName}</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-secondary">
                源空间：{st.sourceWorkspaceName}（组长绑定空间）→ 覆盖各成员的承接空间
              </p>
            </div>
            <button
              type="button"
              aria-label="关闭统一镜像"
              className="ml-auto shrink-0 rounded-md p-1 text-tertiary hover:bg-surface-3 hover:text-primary"
              onClick={() => useUnifiedMirrorStore.getState().close()}
            >
              <X size={16} strokeWidth={1.75} aria-hidden />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-5 pb-2">
          {st.buildStatus === 'building' && (
            <div className="rounded-lg border border-subtle bg-surface-1 p-1.5">
              <CheckRow state="run" label="正在构建快照并上传 hub 存档…" />
              {buildRows('pend')}
            </div>
          )}
          {st.buildStatus === 'error' && (
            <div className="rounded-lg border border-status-error bg-status-error-tint p-3">
              <div className="flex items-center gap-2 text-[13px] font-medium text-status-error">
                <TriangleAlert size={16} strokeWidth={1.75} aria-hidden />
                快照构建失败
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-secondary">{st.buildError}</p>
            </div>
          )}
          {(st.buildStatus === 'done' || st.buildStatus === 'idle') && (
            <div className="rounded-lg border border-subtle bg-surface-1 p-1.5">{buildRows(st.buildStatus === 'done' ? 'done' : 'pend')}</div>
          )}
          {st.buildStatus === 'done' && st.snapshot && (
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-[9px] py-1 text-[11.5px] text-secondary">
                <Package size={12} strokeWidth={1.75} aria-hidden />版本 <b className="font-semibold text-primary">v{st.snapshot.version}</b>
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-[9px] py-1 text-[11.5px] text-secondary">
                大小 <b className="font-semibold text-primary">{formatBytes(st.snapshot.sizeBytes)}</b>
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-[9px] py-1 text-[11.5px] text-secondary">
                checksum <b className="font-mono text-[11px] font-semibold text-primary">sha256:{st.snapshot.checksum.slice(0, 8)}…</b>
              </span>
              <Badge tone="success"><Check size={12} strokeWidth={1.75} aria-hidden />已上传 hub 存档</Badge>
            </div>
          )}

          <p className="pt-0.5 text-[12px] font-semibold text-primary">
            接收成员
            <span className="ml-1.5 font-normal text-tertiary">——不达标成员逐行列明原因，不再隐形过滤</span>
          </p>
          <div className="overflow-hidden rounded-lg border border-subtle">
            {st.rows.length === 0 && (
              <p className="px-3 py-2.5 text-xs text-tertiary">组内暂无其他成员</p>
            )}
            {st.rows.map((r) => {
              return (
                <div
                  key={r.nodeId}
                  data-mirror-row={r.nodeId}
                  className={cn(
                    'flex items-center gap-2.5 border-t border-subtle px-3 py-2 first:border-t-0',
                    r.eligible ? 'bg-canvas' : 'bg-surface-1',
                  )}
                >
                  <Checkbox
                    aria-label={`选择 ${r.name}`}
                    checked={r.selected}
                    disabled={!r.eligible || st.launched}
                    onChange={() => useUnifiedMirrorStore.getState().toggleTarget(r.nodeId)}
                  />
                  <span
                    role="img"
                    aria-label={r.online ? '在线' : '离线'}
                    className={cn('h-[7px] w-[7px] shrink-0 rounded-full', r.online ? 'bg-status-success' : 'bg-disabled')}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] font-medium text-primary">{r.name}</p>
                    <p className="truncate text-[11px] text-tertiary">
                      {[
                        ...(r.bound && r.boundWorkspaceName ? [`承接空间「${r.boundWorkspaceName}」`] : []),
                        ...(r.eligible ? ['已接受镜像'] : r.ineligibleReasons),
                      ].join(' · ')}
                    </p>
                  </div>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {r.status === 'idle' && !r.eligible && <Badge tone="warning">不参与</Badge>}
                    {r.status === 'idle' && r.eligible && <Badge>待发起</Badge>}
                    {r.status === 'sending' && <Badge tone="violet">发起中…</Badge>}
                    {r.status === 'sent' && <Badge tone="violet">应用中…</Badge>}
                    {r.status === 'success' && (
                      <Badge tone="success">
                        <Check size={12} strokeWidth={1.75} aria-hidden />
                        应用成功 · {r.appliedCount ?? 0} 资源{r.unresolvedCount ? ` · ${r.unresolvedCount} 软失败` : ''}
                      </Badge>
                    )}
                    {r.status === 'failed' && (
                      <>
                        <span className="max-w-[220px] truncate text-[11px] text-status-error" title={r.error ?? undefined}>
                          {r.error}
                        </span>
                        <button
                          type="button"
                          className="rounded-md border border-subtle bg-canvas px-2 py-0.5 text-[11px] text-accent-600 dark:text-accent-300 hover:bg-surface-2"
                          onClick={() => void useUnifiedMirrorStore.getState().retryRow(r.nodeId)}
                        >
                          重试
                        </button>
                      </>
                    )}
                  </span>
                </div>
              );
            })}
          </div>

          <p className="flex items-start gap-2 rounded-md bg-status-error-tint px-2.5 py-2 text-[11.5px] leading-relaxed text-status-error">
            <TriangleAlert size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              快照不含 API Key、MCP 凭证与聊天历史；镜像将<b>整体覆盖</b>接收成员的承接空间内容（成员绑定接受时已知晓）。
            </span>
          </p>
        </div>

        <div className="flex items-center justify-between border-t border-subtle px-5 pb-3 pt-2.5">
          <span className="text-[11.5px] text-tertiary">{footLeft}</span>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={inFlight}
              title={inFlight ? '镜像进行中，完成后可关闭' : undefined}
              onClick={() => useUnifiedMirrorStore.getState().close()}
            >
              关闭
            </Button>
            {primary}
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
