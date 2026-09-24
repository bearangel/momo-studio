// renderer/src/components/ui/KeyValueRows.tsx
// 键值对行编辑器原子件（P2.4 D5）：环境变量与请求头同构复用。
// 每行 KEY + VALUE 两列输入 + 行尾删除钮（IconButton + lucide X 14px），
// 底部文字钮追加空行；空行过滤由消费方提交时处理（组件只管受控回传）。
import { X, Plus } from 'lucide-react';
import { IconButton } from './IconButton';

export interface KVRow {
  key: string;
  value: string;
}

export interface KeyValueRowsProps {
  rows: KVRow[];
  onChange: (rows: KVRow[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  /** 列组可访问名（如「环境变量」「请求头」）——行内输入 aria-label 前缀 */
  ariaLabel: string;
}

export function KeyValueRows({ rows, onChange, keyPlaceholder, valuePlaceholder, addLabel, ariaLabel }: KeyValueRowsProps): JSX.Element {
  const patch = (idx: number, part: Partial<KVRow>): void => {
    onChange(rows.map((r, i) => (i === idx ? { ...r, ...part } : r)));
  };
  return (
    <div className="flex flex-col gap-1">
      {rows.map((row, idx) => (
        <div key={idx} className="flex items-center gap-1">
          <input
            type="text"
            value={row.key}
            aria-label={`${ariaLabel}名 ${idx + 1}`}
            placeholder={keyPlaceholder}
            onChange={(e) => patch(idx, { key: e.target.value })}
            className="w-2/5 rounded-md border border-subtle bg-surface-2 px-3 py-2 text-[13px] text-primary placeholder:text-disabled focus:border-focus focus:outline-none"
          />
          <input
            type="text"
            value={row.value}
            aria-label={`${ariaLabel}值 ${idx + 1}`}
            placeholder={valuePlaceholder}
            onChange={(e) => patch(idx, { value: e.target.value })}
            className="flex-1 rounded-md border border-subtle bg-surface-2 px-3 py-2 text-[13px] text-primary placeholder:text-disabled focus:border-focus focus:outline-none"
          />
          <IconButton aria-label={`删除第 ${idx + 1} 行`} size="sm" onClick={() => onChange(rows.filter((_, i) => i !== idx))}>
            <X size={14} strokeWidth={1.75} aria-hidden />
          </IconButton>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { key: '', value: '' }])}
        className="self-start rounded-md px-2 py-1 text-xs text-accent-600 hover:bg-surface-3 dark:text-accent-300"
      >
        <span className="inline-flex items-center gap-1">
          <Plus size={12} strokeWidth={1.75} aria-hidden />
          {addLabel}
        </span>
      </button>
    </div>
  );
}
