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
import { useEffect, useState, type FormEvent } from 'react';
import { Plus, TriangleAlert } from 'lucide-react';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { ipc } from '../../ipc/client';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { showToast } from '../ui/Toast';

/** 名称清洗 → 目录名片段。单源指针：electron/src/main/hub/mirror-applier.ts
 *  的 sanitizeDirName（镜像落位同款规则——保留字母/数字/中文/._-，余者 -，
 *  截 64；预填只取片段不负责 -2 唯一化，主进程 createWorkspace 容忍已存在目录）。 */
function sanitizeDirSegment(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 64);
}

interface Props {
  onClose: () => void;
  /** 内嵌形态（P2 Task 3 首启空态）：不渲染 Dialog 遮罩，由父容器定位——避免盖住 TitleBar */
  embedded?: boolean;
}

export function CreateWorkspaceDialog({ onClose, embedded }: Props) {
  const { create } = useWorkspaceStore();
  const [name, setName] = useState('');
  const [manualDir, setManualDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [effectiveRoot, setEffectiveRoot] = useState<string | null>(null);

  // 工作目录预填源（节点互联「工作目录」；读取失败静默缺席——不阻断手选路径）
  useEffect(() => {
    ipc.hub
      .getWorkspaceDirSettings()
      .then((view) => setEffectiveRoot(view.effectiveRootDir))
      .catch(() => setEffectiveRoot(null));
  }, []);

  const segment = sanitizeDirSegment(name.trim());
  const suggestedDir = effectiveRoot !== null && segment !== '' ? `${effectiveRoot}/${segment}` : '';
  const dir = manualDir ?? suggestedDir;

  const handlePickDirectory = async (): Promise<void> => {
    const picked = await ipc.dialog.pickDirectory({
      title: '选择工作空间目录',
    });
    if (picked) setManualDir(picked);
  };

  // D7（验收报告 2026-10-31）：目录不存在时的确认弹层态（null = 无确认直接走创建）
  const [pendingCreate, setPendingCreate] = useState<{ resolvedPath: string } | null>(null);

  /** IPC 错误友好化：剥 Electron 前缀 + errno 映射（D7） */
  const friendlyError = (err: unknown): string => {
    const raw = err instanceof Error ? err.message : String(err);
    const stripped = raw.replace(/^Error invoking remote method '[^']+':\s*/, '');
    if (/EACCES/.test(stripped)) return `无写入权限：${dir.trim()}（EACCES）`;
    if (/EROFS/.test(stripped)) return '目标位于只读文件系统（EROFS）';
    if (/ENOTDIR|ENOTEMPTY/.test(stripped))
      return '路径中某一段不是目录（ENOTDIR）——请检查拼写';
    return stripped;
  };

  const doCreate = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const ws = await create({ name: name.trim(), directoryPath: dir.trim() });
      if (ws.gitInitialized === false) {
        showToast('工作空间已创建，但 git 初始化失败（不影响使用）');
      }
      onClose();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (loading) return; // Oracle P1：probe 往返期间防双击（旧代码同步 setLoading 有此保护）
    if (!name.trim() || !dir.trim()) {
      setError('名称和目录不能为空');
      return;
    }
    setError(null);
    // D7：提交前只读探测——目录不存在先确认（完整绝对路径 + git init 披露），
    // 防笔误路径静默 mkdir+init（验收实测 qa-rpg-game-not-exist/.git）
    setLoading(true);
    let probe: { exists: boolean; resolvedPath: string; hasGit: boolean };
    try {
      probe = await ipc.workspace.probePath(dir.trim());
    } catch {
      setLoading(false);
      await doCreate(); // 探测通道异常不挡创建（退回旧行为）
      return;
    }
    setLoading(false); // 弹确认层期间表单可编辑（确认钮触发 doCreate 自带 loading）
    if (!probe.exists) {
      setPendingCreate({ resolvedPath: probe.resolvedPath });
      return;
    }
    await doCreate();
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
            onChange={(e) => setManualDir(e.target.value)}
            placeholder="选择或输入目录路径"
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

  // D7 确认弹层（目录不存在时）——两种形态共用；确认=建设性动作用主色钮
  // （预览合同 .omo/previews/pkg3-workspace-path-confirm.html）
  const confirmLayer = pendingCreate ? (
    <Dialog
      open
      onClose={() => setPendingCreate(null)}
      title="目录不存在，将创建"
      width={420}
      icon={<TriangleAlert size={16} strokeWidth={1.75} className="text-accent-500" />}
      ariaLabel="确认创建目录"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={() => setPendingCreate(null)}>
            取消
          </Button>
          <Button type="button" onClick={() => void doCreate()}>
            <Plus size={14} strokeWidth={1.75} />
            创建目录并初始化
          </Button>
        </>
      }
    >
      以下目录当前不存在，确认后将创建它（含缺失的父目录）：
      <code className="mt-2 mb-2 block border border-subtle bg-canvas font-mono text-xs px-2 py-1.5 rounded break-all">
        {pendingCreate.resolvedPath}
      </code>
      并在该目录执行 git init 初始化仓库，生成首个提交「init: workspace 初始化」。
      <div className="mt-2 text-xs text-secondary">若路径有笔误，请点取消返回修改。</div>
    </Dialog>
  ) : null;

  // 内嵌形态：首启空态没有可关闭的上级界面，不套 Dialog；
  // 标题由本卡片自带（App.test 依赖 heading「新建工作空间」）
  if (embedded) {
    return (
      <>
        <form
          onSubmit={handleSubmit}
          className="bg-surface-1 rounded-lg border border-subtle p-6 w-full max-w-md"
        >
          <h2 className="text-xl font-bold mb-4">新建工作空间</h2>
          <div className="flex flex-col gap-3">{formFields}</div>
        </form>
        {confirmLayer}
      </>
    );
  }

  return (
    <>
      <Dialog open onClose={onClose} title="新建工作空间" width={448}>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {formFields}
        </form>
      </Dialog>
      {confirmLayer}
    </>
  );
}
