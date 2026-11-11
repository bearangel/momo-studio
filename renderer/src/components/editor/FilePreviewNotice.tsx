// renderer/src/components/editor/FilePreviewNotice.tsx
// 不可预览文件占位卡（VS Code 式，2026-10-23 ④ 预览批准稿；2026-11-11 扩
// tooLarge 态——超过预览上限的文件不读内容，同样落此卡）。
// 编辑区无法预览的文件以此替代直接拉起外部程序——显式按钮触发，杜绝意外
// 启动外部应用。视觉定值出自 .omo/previews/binary-file-notice.html（P1 门禁）。
import { useState } from 'react';
import { FileQuestion, FileWarning } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { ipcErrorMessage } from '../../lib/ipc-error';
import type { PendingFileNotice } from '../../stores/editor.store';

interface Props {
  workspaceId: string;
  notice: PendingFileNotice;
}

/** 扩展名 → 类型描述（无 mime IPC，不虚构数据） */
function typeLabelOf(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const ext = dot <= 0 ? '' : filePath.slice(dot + 1).toUpperCase();
  return ext === '' ? '未知类型文件' : `「${ext}」文件`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function FilePreviewNotice({ workspaceId, notice }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { filePath } = notice;
  const tooLarge = notice.kind === 'tooLarge';

  const openExternal = async () => {
    setBusy(true);
    setError(null);
    try {
      await ipc.file.openWithDefaultApp(workspaceId, filePath);
    } catch (e) {
      // 主进程消息已带「外部应用打开失败:」上下文（D1 约定），剥净 IPC 包装
      setError(ipcErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const revealInFolder = async () => {
    setBusy(true);
    setError(null);
    try {
      await ipc.file.revealInFolder(workspaceId, filePath);
    } catch (e) {
      setError(`打开所在目录失败：${ipcErrorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center" data-testid="file-preview-notice">
      <div className="text-center max-w-[380px] px-6">
        <div className="text-tertiary mb-3 flex justify-center">
          {tooLarge ? (
            <FileWarning size={40} strokeWidth={1.75} aria-hidden />
          ) : (
            <FileQuestion size={40} strokeWidth={1.75} aria-hidden />
          )}
        </div>
        <div className="text-sm font-semibold mb-1.5">
          {tooLarge ? '文件过大，未加载预览' : '二进制文件，无法在编辑器中预览'}
        </div>
        <div className="text-xs text-tertiary mb-1 font-mono break-all">{filePath}</div>
        <div className="text-[11px] text-tertiary mb-5">
          {typeLabelOf(filePath)} ·{' '}
          {tooLarge ? `${formatSize(notice.size)} · 超出预览上限` : '可交由系统默认应用打开'}
        </div>
        <div className="flex gap-2.5 justify-center mb-3.5">
          <button
            type="button"
            onClick={() => void openExternal()}
            disabled={busy}
            className="bg-accent-500 hover:bg-accent-600 text-white rounded-md px-3.5 py-1.5 text-[13px] disabled:opacity-50"
          >
            用系统默认应用打开
          </button>
          <button
            type="button"
            onClick={() => void revealInFolder()}
            disabled={busy}
            className="bg-surface-2 hover:bg-surface-3 text-primary border border-subtle rounded-md px-3.5 py-1.5 text-[13px] disabled:opacity-50"
          >
            在文件夹中显示
          </button>
        </div>
        <div className="text-[11px] text-tertiary">
          点击任意 tab 或其他文件即返回编辑器；右键菜单亦可直接打开
        </div>
        {error && (
          <div className="mt-2.5 flex items-center justify-center gap-2 text-xs text-status-error">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
