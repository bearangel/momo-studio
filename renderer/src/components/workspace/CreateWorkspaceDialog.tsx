// renderer/src/components/workspace/CreateWorkspaceDialog.tsx
// 创建 workspace 对话框：输入名称和目录路径，
// 提交后调用 store.create 并关闭
import { useState, type FormEvent } from 'react';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

interface Props {
  onClose: () => void;
}

export function CreateWorkspaceDialog({ onClose }: Props) {
  const { create } = useWorkspaceStore();
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !dir.trim()) {
      setError('名称和目录不能为空');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await create({ name: name.trim(), directoryPath: dir.trim() });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="bg-bg-secondary rounded-xl border border-border-subtle p-6 w-full max-w-md"
      >
        <h2 className="text-xl font-bold mb-4">新建 workspace</h2>
        <div className="flex flex-col gap-3">
          <Input
            label="名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="我的项目"
          />
          <Input
            label="目录路径"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="~/projects/my-app"
          />
          {error && <div className="text-red-400 text-sm">{error}</div>}
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="ghost" type="button" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={loading || !name || !dir}>
              {loading ? '创建中…' : '创建'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
