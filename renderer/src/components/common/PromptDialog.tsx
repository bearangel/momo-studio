import { useState, type FormEvent } from 'react';

// 替代 Electron 不支持的 window.prompt（Electron 中 prompt 恒返回 null）。
interface Props {
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  password?: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

export function PromptDialog({ title, label, defaultValue = '', placeholder, password, onSubmit, onClose }: Props) {
  const [value, setValue] = useState(defaultValue);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(value);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="bg-bg-secondary border border-border-subtle rounded-lg p-4 flex flex-col gap-2 w-80"
      >
        <h3 className="text-neutral-100 text-sm">{title}</h3>
        {label && <p className="text-xs text-neutral-400">{label}</p>}
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          placeholder={placeholder}
          type={password ? 'password' : 'text'}
          className="bg-bg-tertiary border border-border-subtle rounded px-2 py-1 text-sm text-neutral-100"
        />
        <div className="flex justify-end gap-2 mt-1">
          <button type="button" onClick={onClose} className="text-xs text-neutral-400 hover:text-neutral-200 px-2 py-1">
            取消
          </button>
          <button type="submit" className="text-xs px-2 py-1 rounded bg-accent-blue text-white">
            确定
          </button>
        </div>
      </form>
    </div>
  );
}
