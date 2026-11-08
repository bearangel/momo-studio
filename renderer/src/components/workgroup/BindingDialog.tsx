// renderer/src/components/workgroup/BindingDialog.tsx
//
// 平行组「绑定承接空间」弹窗（spec 2026-11-05 §6 两步式入组第二步 / 组设置换绑共用）：
// - 空间下拉（useWorkspaceStore 本地清单，必选）+「接受本组镜像同步」单选（默认
//   不接受）+ 护栏文案（接受后组长的统一镜像将覆盖此空间内容）
// - 提交 = hub-group-store bind（groupBind：主进程按名登记 hub + 本地权威落库）
//   + 接受时 setMirrorAccept({accepts:true})
//   - 入组态（joinFlavor）提供「稍后再绑」跳过——成为未绑定成员（无法接收草稿，
//   监控台组设置可补绑）；换绑态缺省开关取自己成员行当前 acceptsMirror
//   - hideAccepts（组长换绑）：隐藏接受勾选与警示——组长是统一镜像的源，
//   「接受自己的镜像」语义不适用（2026-11-08 验收修正）
import { useEffect, useState, type FormEvent } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useHubGroupStore } from '../../stores/hub-group.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { rpcErrorMessage } from '../../lib/rpc-error';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Dialog } from '../ui/Dialog';
import { Select } from '../ui/Select';

interface BindingDialogProps {
  open: boolean;
  onClose: () => void;
  groupId: string;
  /** 弹窗标题组名（呈现用；缺省「该组」） */
  groupName?: string;
  /** 换绑态：开关初值取当前 acceptsMirror；入组态缺省 false（默认不接受） */
  initialAccepts?: boolean;
  /** 入组第二步形态：出「稍后再绑」跳过按钮 */
  joinFlavor?: boolean;
  /** 隐藏「接受本组镜像同步」勾选（组长换绑=换镜像源空间，接受语义不适用） */
  hideAccepts?: boolean;
}

export function BindingDialog({
  open,
  onClose,
  groupId,
  groupName,
  initialAccepts = false,
  joinFlavor = false,
  hideAccepts = false,
}: BindingDialogProps) {
  const bind = useHubGroupStore((s) => s.bind);
  const setMirrorAccept = useHubGroupStore((s) => s.setMirrorAccept);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const loadWorkspaces = useWorkspaceStore((s) => s.load);
  const [workspaceId, setWorkspaceId] = useState('');
  const [accepts, setAccepts] = useState(initialAccepts);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setWorkspaceId('');
    setAccepts(initialAccepts);
    setFormError(null);
    if (useWorkspaceStore.getState().workspaces.length === 0) {
      void loadWorkspaces().catch(() => {});
    }
  }, [open, initialAccepts, loadWorkspaces]);

  if (!open) return null;

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (submitting || workspaceId === '') return;
    setSubmitting(true);
    setFormError(null);
    try {
      await bind(groupId, workspaceId);
      if (accepts && !hideAccepts) await setMirrorAccept(groupId, true);
      onClose();
    } catch (err) {
      // store 动作 rethrow 原始 rejection——展示层剥 `[code]` 前缀
      setFormError(rpcErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`${groupName ?? '该组'} · 绑定承接空间`} width={440}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void onSubmit(e)}>
        <p className="text-xs leading-relaxed text-tertiary">
          平行组的任务草稿将落到你绑定的这个本地工作空间；一个节点在一组内只能绑定一个空间。
        </p>
        <Select
          label="承接空间*"
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
        >
          <option value="">请选择工作空间</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
        {!hideAccepts && (
          <div className="flex flex-col gap-1.5">
            <Checkbox
              label="接受本组镜像同步"
              checked={accepts}
              onChange={(e) => setAccepts(e.target.checked)}
            />
            {accepts && (
              <div className="flex items-start gap-1.5 rounded-md bg-status-warning-tint px-2.5 py-2 text-xs leading-relaxed text-status-warning">
                <TriangleAlert size={14} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0" />
                <span>接受后组长的统一镜像将覆盖此空间内容</span>
              </div>
            )}
          </div>
        )}
        {formError !== null && (
          <p className="text-xs text-status-error" role="alert">
            {formError}
          </p>
        )}
        <div className="flex justify-end gap-2">
          {joinFlavor && (
            <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
              稍后再绑
            </Button>
          )}
          <Button type="submit" disabled={submitting || workspaceId === ''}>
            {submitting ? '绑定中…' : '绑定'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
