// renderer/src/components/workspace/CreateWorkspaceDialog.tsx
// 新建工作空间对话框：输入名称、选择本地目录，
// 提交后调用 store.create 并关闭
//
// v2.1 P3：手写 modal 外壳 → Dialog 原子件（RegisterMcpDialog 先例）；
// 提交/目录选择业务逻辑逐字保留。计划裁定「iconEmoji 选择器如为 emoji grid →
// 保留」——本表单实际不含 iconEmoji 采集 UI（workspace 图标由主进程缺省），
// 条件不成立，无豁免项。
// embedded 内嵌形态（P2 Task 3 首启空态）保留自绘卡片仅 token 化：
// Dialog 只有 portal 遮罩形态，首启空态无上级界面、遮罩/Esc 关闭不适用。
import { useState, type FormEvent } from 'react';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { ipc } from '../../ipc/client';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';

interface Props {
  onClose: () => void;
  /** 内嵌形态（P2 Task 3 首启空态）：不渲染 Dialog 遮罩，由父容器定位——避免盖住 TitleBar */
  embedded?: boolean;
}

export function CreateWorkspaceDialog({ onClose, embedded }: Props) {
  const { create } = useWorkspaceStore();
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handlePickDirectory = async (): Promise<void> => {
    const picked = await ipc.dialog.pickDirectory({
      title: '选择工作空间目录',
    });
    if (picked) setDir(picked);
  };

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

  const formFields = (
    <>
      <Input
        label="名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="我的项目"
        autoFocus
      />
      <div className="flex flex-col gap-1">
        <label className="text-sm text-secondary">目录路径</label>
        <div className="flex gap-2">
          <Input
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="点击右侧按钮选择目录"
            className="flex-1"
          />
          <Button
            type="button"
            variant="ghost"
            onClick={handlePickDirectory}
            className="shrink-0"
          >
            选择目录
          </Button>
        </div>
      </div>
      {error && <div className="text-status-error text-sm">{error}</div>}
      <div className="flex gap-2 justify-end mt-2">
        <Button variant="ghost" type="button" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" disabled={loading || !name || !dir}>
          {loading ? '创建中…' : '创建'}
        </Button>
      </div>
    </>
  );

  // 内嵌形态：首启空态没有可关闭的上级界面，不套 Dialog；
  // 标题由本卡片自带（App.test 依赖 heading「新建工作空间」）
  if (embedded) {
    return (
      <form
        onSubmit={handleSubmit}
        className="bg-surface-1 rounded-lg border border-subtle p-6 w-full max-w-md"
      >
        <h2 className="text-xl font-bold mb-4">新建工作空间</h2>
        <div className="flex flex-col gap-3">{formFields}</div>
      </form>
    );
  }

  return (
    <Dialog open onClose={onClose} title="新建工作空间" width={448}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {formFields}
      </form>
    </Dialog>
  );
}
