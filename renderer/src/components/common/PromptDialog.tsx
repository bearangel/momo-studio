// renderer/src/components/common/PromptDialog.tsx
// Electron window.prompt 替代件（Electron 中 prompt 恒返回 null）。
// v2.1 P1：外壳收敛到 Dialog 原子件——遮罩/Esc/焦点语义统一。
import { useState, type FormEvent } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

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
    <Dialog open onClose={onClose} title={title} width={320}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {label && <p className="text-xs text-secondary">{label}</p>}
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          placeholder={placeholder}
          type={password ? 'password' : 'text'}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit">确定</Button>
        </div>
      </form>
    </Dialog>
  );
}
