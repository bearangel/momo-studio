// renderer/src/components/task-board/TaskOriginFilter.tsx
//
// 来源多选下拉（2026-11-12 看板治理，预览 v2 批准定值）：
//   - 按钮摘要：全选 →「来源：全部」（中性 pill 样式）；部分选择 →
//     「来源：用户任务 + 平行草稿」（border-focus + bg-surface-active 高亮）
//   - popover：三项复选（TASK_ORIGINS 固定序）+ 至少保留一项守卫（仅剩一项
//     时该项禁点——防空看板）+ 底部说明行
//   - 勾选集合经 onChange 上抛（TaskBoardView 持久化 + task.store 查询级过滤）
//   - 关闭通道：全屏遮罩点击 / Escape / 勾选后保持开（多选语义——连续勾选）
import { useEffect, useState } from 'react';
import { Check, ChevronDown, ListFilter } from 'lucide-react';
import type { TaskOrigin } from '../../ipc/types';
import { TASK_ORIGIN_DESCS, TASK_ORIGIN_LABELS, TASK_ORIGINS } from '../../lib/board';
import { cn } from '../../lib/cn';

interface TaskOriginFilterProps {
  /** 当前勾选集合（父层持久化与加载消费；长度恒 ≥ 1——守卫在组件内） */
  value: TaskOrigin[];
  onChange: (next: TaskOrigin[]) => void;
}

/** 摘要文案：全选 →「全部」；部分 → 全名 ' + ' 连接（预览 v2 合同） */
export function originFilterSummary(value: TaskOrigin[]): string {
  if (value.length >= TASK_ORIGINS.length) return '全部';
  return TASK_ORIGINS.filter((o) => value.includes(o))
    .map((o) => TASK_ORIGIN_LABELS[o])
    .join(' + ');
}

export function TaskOriginFilter({ value, onChange }: TaskOriginFilterProps): JSX.Element {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const toggle = (origin: TaskOrigin): void => {
    if (value.includes(origin)) {
      // 至少保留一项：仅剩一项时禁点（按钮 disabled 已挡，此处双保险）
      if (value.length <= 1) return;
      onChange(value.filter((o) => o !== origin));
    } else {
      onChange([...value, origin]);
    }
  };

  const filtered = value.length < TASK_ORIGINS.length;

  return (
    <div className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`按任务来源筛选（当前：${originFilterSummary(value)}）`}
        title="勾选的任务来源才加载（查询级过滤，不占看板 500 行窗口）"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors',
          filtered
            ? 'border-focus bg-surface-active text-primary'
            : 'border-subtle bg-surface-2 text-secondary hover:bg-surface-3 hover:text-primary',
        )}
      >
        <ListFilter size={14} strokeWidth={1.75} aria-hidden />
        来源：{originFilterSummary(value)}
        <ChevronDown
          size={12}
          strokeWidth={1.75}
          aria-hidden
          className={cn('transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <>
          {/* 全屏遮罩：点击关闭（不拦截右键原生菜单——本菜单非上下文菜单） */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <ul
            role="listbox"
            aria-label="任务来源选择"
            aria-multiselectable="true"
            className="absolute left-0 top-[calc(100%+4px)] z-50 min-w-[218px] rounded-md border border-subtle bg-surface-1 py-1 text-[13px] text-secondary shadow-lg"
          >
            {TASK_ORIGINS.map((origin) => {
              const checked = value.includes(origin);
              const isLast = value.length <= 1 && checked;
              return (
                <li key={origin}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={checked}
                    aria-disabled={isLast}
                    disabled={isLast}
                    title={isLast ? '至少保留一项来源' : undefined}
                    onClick={() => toggle(origin)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left',
                      isLast ? 'cursor-not-allowed opacity-45' : 'cursor-pointer hover:bg-surface-3',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border',
                        checked ? 'border-accent-500 bg-accent-500' : 'border-strong',
                      )}
                    >
                      {checked && <Check size={11} strokeWidth={2.5} className="text-white" />}
                    </span>
                    {TASK_ORIGIN_LABELS[origin]}
                    <span className="ml-auto text-[11px] text-tertiary">{TASK_ORIGIN_DESCS[origin]}</span>
                  </button>
                </li>
              );
            })}
            <li className="border-t border-subtle" />
            <li className="px-3 pb-0.5 pt-1 text-[11px] text-tertiary">至少保留一项 · 偏好本地记忆</li>
          </ul>
        </>
      )}
    </div>
  );
}
