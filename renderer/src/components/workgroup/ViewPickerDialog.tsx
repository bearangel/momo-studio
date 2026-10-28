// renderer/src/components/workgroup/ViewPickerDialog.tsx
//
// 查看工作空间选择器（momo-hub M2.1 Task 4，视觉合同 .omo/previews/hub-ia-fullapp.html
// S3b 屏）——「查看」入口点击后的中间步，hub-view.store 既有 picking 前置步的弹窗形态：
// - 壳 = MirrorWizard 同款自绘 modal（portal + 遮罩 + 440px / 12px 圆角 / canvas 底），
//   S3b 定值：头部 nicon 26px（Eye）+ 标题「查看 {节点名} 的工作空间」+ 副题
//   「远程只读 · 经 hub 定向拉取」+ 关闭位；行 = Folder 16px accent + 名称 + chevron；
//   底部 consent callout（WifiOff + 403 提示与「查看与镜像无关」话术）
// - 数据 = store 既有 picking 流。M3.2 起双数据源：远端模式（openRemotePick 置
//   pickerRemote——行来自 viewWorkspaces 远端清单产物 pickerWorkspaces，空态文案
//   指向目标节点）；本机回落模式（旧路径——workspace.list 本机清单，M2 迁移
//   语义）。行内「已镜像」徽标与会话/任务规模/最近活跃暂缺数据源，留待 RM-M21-7
//   （T6 镜像登记表）接入，此处不编造、不渲染
// - 行点击 → store.pickWorkspace(id, name)（选择后 loadAll 三发定向拉取）；
//   关闭位/遮罩点击 → store.close
// - 空清单空态（复用 store openPanel 同款文案）；错误人话（humanizeViewError
//   产物经 st.error）以 role=alert 呈现——防御路径，picking 期常态无 hub 调用
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Eye, Folder, WifiOff, X } from 'lucide-react';
import { useHubViewStore } from '../../stores/hub-view.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';

export function ViewPickerDialog() {
  const picking = useHubViewStore((s) => s.picking);
  const targetName = useHubViewStore((s) => s.targetName);
  const error = useHubViewStore((s) => s.error);
  const pickerRemote = useHubViewStore((s) => s.pickerRemote);
  const pickerWorkspaces = useHubViewStore((s) => s.pickerWorkspaces);
  const remoteLoading = useHubViewStore((s) => s.remoteLoading);
  const close = useHubViewStore((s) => s.close);
  const pickWorkspace = useHubViewStore((s) => s.pickWorkspace);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const loading = useWorkspaceStore((s) => s.loading);
  const loadWorkspaces = useWorkspaceStore((s) => s.load);

  useEffect(() => {
    if (useHubViewStore.getState().picking && !pickerRemote && workspaces.length === 0) void loadWorkspaces();
  }, [workspaces.length, loadWorkspaces, picking, pickerRemote]);

  if (!picking) return null;

  // 双数据源归一：远端模式行 = pickerWorkspaces（null = 拉取在途）；本机回落 = workspaceStore
  const rows = pickerRemote ? pickerWorkspaces ?? [] : workspaces.map((w) => ({ id: w.id, name: w.name }));
  const rowsLoading = pickerRemote ? remoteLoading : loading;
  const emptyText = pickerRemote
    ? '目标节点暂无工作空间——对方创建或镜像后可查看'
    : '本机尚无工作空间——先在工作空间页创建或镜像后查看';

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 bg-backdrop" aria-hidden onClick={close} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`查看 ${targetName} 的工作空间`}
        className="fixed left-1/2 top-16 z-50 flex w-[440px] -translate-x-1/2 flex-col gap-3 rounded-[12px] border border-subtle bg-canvas p-4 shadow-2xl"
      >
        <div className="flex items-center gap-2">
          <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md bg-surface-active text-accent-600 dark:text-accent-300">
            <Eye size={14} strokeWidth={1.75} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-primary">查看 {targetName} 的工作空间</div>
            <div className="text-[11px] text-tertiary">远程只读 · 经 hub 定向拉取</div>
          </div>
          <Button variant="ghost" size="sm" className="h-7 w-7 px-0" aria-label="取消查看" onClick={close}>
            <X size={14} strokeWidth={1.75} aria-hidden />
          </Button>
        </div>

        {error !== null && (
          <p className="rounded-md bg-status-error-tint px-2.5 py-2 text-xs text-status-error" role="alert">{error}</p>
        )}

        <div className="flex flex-col gap-1" aria-label="工作空间清单">
          {rows.length === 0 ? (
            rowsLoading ? (
              <p className="flex items-center gap-2 px-1 py-2.5 text-xs text-tertiary">
                <Spinner size={12} /> 拉取中…
              </p>
            ) : (
              <p className="rounded-lg border border-subtle bg-surface-1 px-3 py-3 text-center text-xs text-tertiary">
                {emptyText}
              </p>
            )
          ) : (
            rows.map((w) => (
              <button
                key={w.id}
                type="button"
                aria-label={`选择工作空间 ${w.name}`}
                onClick={() => pickWorkspace(w.id, w.name)}
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-subtle bg-surface-1 px-2.5 py-2 text-left hover:border-border-strong"
              >
                <Folder size={16} strokeWidth={1.75} className="shrink-0 text-accent-600 dark:text-accent-300" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-primary">{w.name}</span>
                {/* TODO RM-M21-7：已镜像徽标与会话/任务规模/最近活跃——镜像登记表（T6）与远端空间清单通道接入前无数据源，不编造 */}
                <ChevronRight size={14} strokeWidth={1.75} className="shrink-0 text-tertiary" aria-hidden />
              </button>
            ))
          )}
        </div>

        <div className="flex items-start gap-2 rounded-lg bg-surface-2 px-2.5 py-2 text-[11.5px] leading-relaxed text-secondary">
          <WifiOff size={12} strokeWidth={1.75} className="mt-0.5 shrink-0 text-accent-600 dark:text-accent-300" aria-hidden />
          <span>对方关闭「允许本组查看」时列表不可用（403 提示）；查看与镜像无关——读的是节点实况。</span>
        </div>
      </div>
    </>,
    document.body,
  );
}
