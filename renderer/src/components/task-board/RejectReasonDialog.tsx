// renderer/src/components/task-board/RejectReasonDialog.tsx
//
// 打回返工理由弹框（v2 生命周期 Task 21，预览合同
// .omo/previews/2026-11-13-task-lifecycle-board.html 定值清单 #17）：
// submitted 卡拖入「排队中」列（submitted → assigned = 打回）由 useBoardDrop
// 拦截弹本框——理由必填（trim 后 min 1 字符，空理由确认钮禁用），确认后
// move(id, {column:'assigned', groupId}, {reason})，理由将注入新 run 上下文；
// 取消零副作用（调用方 cancelReject 清拦截态，卡片归位）。
import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { TaskRow } from '../../ipc/types';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';

interface RejectReasonDialogProps {
  task: TaskRow;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}

export function RejectReasonDialog({ task, onConfirm, onClose }: RejectReasonDialogProps) {
  const [reason, setReason] = useState('');
  const canConfirm = reason.trim() !== '';

  return (
    <Dialog
      open
      onClose={onClose}
      title="打回返工"
      width={320}
      icon={<RotateCcw size={14} strokeWidth={1.75} aria-hidden className="text-status-error" />}
    >
      <div className="flex flex-col gap-2">
        <div className="truncate text-[11px] text-tertiary">
          #{task.id.slice(0, 6)} · {task.title} → 排队中（新 run）
        </div>
        <textarea
          aria-label="打回理由"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus
          placeholder="打回理由（必填，将注入新 run 上下文）…"
          className="min-h-[68px] w-full resize-none rounded-md border border-subtle bg-surface-2 px-2 py-1.5 text-xs leading-relaxed text-primary placeholder:text-disabled focus:border-focus focus:outline-none"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" disabled={!canConfirm} onClick={() => onConfirm(reason.trim())}>
            确认打回
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
