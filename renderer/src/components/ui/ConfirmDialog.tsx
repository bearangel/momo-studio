// renderer/src/components/ui/ConfirmDialog.tsx
// 确认弹窗原子件（P2.5 D5）：危险操作二次确认——删除资源等。
// 确认钮 danger 变体；Esc/遮罩关闭走 Dialog 既有语义。
import { Dialog } from './Dialog';
import { Button } from './Button';

interface Props {
  title: string;
  message: string;
  /** 确认钮文案（缺省「删除」） */
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel = '删除', onConfirm, onClose }: Props) {
  return (
    <Dialog open onClose={onClose} title={title} width={400}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-secondary">{message}</p>
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" type="button" onClick={onClose}>取消</Button>
          {/* 先 onConfirm 后 onClose：消费方 onConfirm 闭包常读待删态（pendingDelete.id），先清空即崩 */}
          <Button variant="danger" type="button" onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</Button>
        </div>
      </div>
    </Dialog>
  );
}
