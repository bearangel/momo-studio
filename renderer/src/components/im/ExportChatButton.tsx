// renderer/src/components/im/ExportChatButton.tsx
//
// 会话导出按钮：弹窗（数量输入默认 100）+ 调 ipc.im.exportRoomMessages +
// 用 Blob + <a download> 触发浏览器原生下载（macOS Finder save sheet）。
//
// 失败时红字展示错误，弹窗保持打开；导出中所有按钮 disabled 防双击。
import { useState } from 'react';
import { ipc } from '../../ipc/client';
import { Button } from '../ui/Button';

interface Props {
  roomId: string;
}

export function ExportChatButton({ roomId }: Props) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(100);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async (): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    setError(null);
    try {
      const { filename, content } = await ipc.im.exportRoomMessages(roomId, limit);
      // Blob + a.download 触发浏览器下载
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="text-xs px-2 py-1 rounded text-neutral-400 hover:text-neutral-100 hover:bg-bg-tertiary"
        onClick={() => setOpen(true)}
        title="导出会话为 Markdown"
      >
        ⤓ 导出
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={exporting ? undefined : () => setOpen(false)}
        >
          <div
            className="bg-bg-secondary rounded-xl border border-border-subtle p-6 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold mb-4">导出会话</h2>
            <div className="flex flex-col gap-3">
              <label className="text-sm text-neutral-300">
                消息数量（最近 N 条）
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={limit}
                  onChange={(e) =>
                    setLimit(
                      Math.max(1, Math.min(1000, Number(e.target.value) || 100)),
                    )
                  }
                  className="ml-2 w-24 px-2 py-1 rounded bg-bg-tertiary border border-border-subtle text-neutral-100"
                  disabled={exporting}
                />
              </label>
              {error && <div className="text-red-400 text-sm">{error}</div>}
              <div className="flex gap-2 justify-end">
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => setOpen(false)}
                  disabled={exporting}
                >
                  取消
                </Button>
                <Button type="button" onClick={handleConfirm} disabled={exporting}>
                  {exporting ? '导出中…' : '确定'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
