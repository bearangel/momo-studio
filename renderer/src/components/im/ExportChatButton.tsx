// renderer/src/components/im/ExportChatButton.tsx
//
// 会话导出：数量输入弹窗 + ipc.session.exportMessages + Blob 下载。
// v2.1：⤓→Download；手写 modal 收敛 Dialog 原子件。失败红字保留、导出中禁双击。
import { useState } from 'react';
import { Download } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';

interface Props {
  sessionId: string;
}

export function ExportChatButton({ sessionId }: Props) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(100);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async (): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    setError(null);
    try {
      const { filename, content } = await ipc.session.exportMessages(sessionId, limit);
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
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-secondary hover:bg-surface-3 hover:text-primary"
        onClick={() => setOpen(true)}
        title="导出会话为 Markdown"
      >
        <Download size={12} strokeWidth={1.75} aria-hidden />
        导出
      </button>

      <Dialog
        open={open}
        onClose={exporting ? () => undefined : () => setOpen(false)}
        title="导出会话"
        width={384}
      >
        <div className="flex flex-col gap-3">
          <Input
            label="消息数量（最近 N 条）"
            type="number"
            min={1}
            max={1000}
            value={limit}
            onChange={(e) => setLimit(Math.max(1, Math.min(1000, Number(e.target.value) || 100)))}
            disabled={exporting}
          />
          {error && <div className="text-sm text-status-error">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={() => setOpen(false)} disabled={exporting}>
              取消
            </Button>
            <Button type="button" onClick={handleConfirm} disabled={exporting}>
              {exporting ? '导出中…' : '确定'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
