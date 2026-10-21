// renderer/src/components/resource-library/RegisterPluginDirDialog.tsx
// 插件 dev 目录注册弹窗（spec 2026-10-15 §7.2）：不拷贝、直读源目录；同名重复注册
// = 刷新版本。成功即自动关闭（反馈走 View 层 installNotice 横幅）；失败错误内联不关弹窗。
import { useState } from 'react';
import { ipc } from '../../ipc/client';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import type { PluginSummary } from '../../ipc/types';

interface Props {
  onClose: () => void;
  onSuccess: (summary: PluginSummary) => void;
}

export function RegisterPluginDirDialog({ onClose, onSuccess }: Props) {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [dir, setDir] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  const trimmed = dir.trim();

  const handleRegister = async (): Promise<void> => {
    if (!trimmed || registering) return;
    setRegistering(true);
    setError(null);
    try {
      const summary = await ipc.plugin.installDevDir(trimmed, activeWorkspaceId ?? undefined);
      onSuccess(summary);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegistering(false);
    }
  };

  return (
    <Dialog open onClose={registering ? () => undefined : onClose} title="注册开发目录" width={448}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Input
            label="插件源码目录"
            aria-label="插件源码目录"
            spellCheck={false}
            placeholder="/path/to/my-plugin（含 momo-plugin.json）"
            value={dir}
            onChange={(e) => {
              setDir(e.target.value);
              setError(null);
            }}
            disabled={registering}
          />
          <p className="text-xs text-tertiary mt-1">
            不拷贝文件，直接读取该目录（改码后的重载动作随 P2 工具激活提供）。同名插件重复注册
            = 刷新版本。
          </p>
        </div>
        {error && (
          <div className="text-status-error text-sm whitespace-pre-wrap break-all">{error}</div>
        )}
        <div className="flex gap-2 justify-end mt-1">
          <Button variant="ghost" type="button" onClick={onClose} disabled={registering}>
            取消
          </Button>
          <Button
            type="button"
            disabled={!trimmed || registering}
            onClick={() => void handleRegister()}
          >
            {registering ? '注册中…' : '注册'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
