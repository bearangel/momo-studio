// renderer/src/components/oauth/AuthorizeDialog.tsx
//
// 授权等待对话框（spec §13.3，预览 v2 区块 C）：所有授权入口共用。
// 契约：挂载即开系统浏览器（misc:openExternal，https 任意 + 回环 http）；
// 完成事件经 oauth:authorizationChanged 推送驱动 onSuccess；手动粘贴为
// 容器/远程开发/防火墙场景的兜底，走同一条 complete 路径。
import { useEffect, useState } from 'react';
import { Copy, KeyRound } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { AuthorizationChangedPayload } from '../../ipc/types';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { IconButton } from '../ui/IconButton';
import { Input } from '../ui/Input';

interface Props {
  pendingId: string;
  authorizationUrl: string;
  redirectUri: string;
  onSuccess: () => void;
  onClose: () => void;
}

export function AuthorizeDialog({ pendingId, authorizationUrl, redirectUri, onSuccess, onClose }: Props) {
  const [manual, setManual] = useState('');
  const [openManual, setOpenManual] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    // 幂等开浏览器：opened 守卫防 StrictMode 双挂载/重渲染重复拉起
    if (opened) return;
    setOpened(true);
    void ipc.misc.openExternal(authorizationUrl).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [authorizationUrl, opened]);

  useEffect(
    () =>
      ipc.oauth.onAuthorizationChanged((payload: AuthorizationChangedPayload) => {
        if (payload.pendingId !== pendingId) return;
        if (payload.status === 'connected') onSuccess();
        else if (payload.status === 'failed') setError(payload.error?.message ?? '授权失败');
      }),
    [pendingId, onSuccess],
  );

  const copyRedirect = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(redirectUri);
    } catch {
      setError('复制失败，请手动选中复制');
    }
  };

  const submitManual = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      await ipc.oauth.completeWithManualCallback({ pendingId, input: manual });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = (): void => {
    void ipc.oauth.cancelAuthorization(pendingId).catch(() => undefined);
    onClose();
  };

  return (
    <Dialog
      open
      onClose={handleClose}
      title="等待授权"
      icon={<KeyRound size={16} strokeWidth={1.75} aria-hidden />}
      width={480}
      footer={<Button variant="ghost" onClick={handleClose}>取消</Button>}
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-secondary">
          {opened ? '已在浏览器中打开授权页，完成授权后会自动返回。' : '正在打开浏览器…'}
        </p>
        {error && <div className="text-status-error">{error}</div>}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-tertiary">回调地址（请在你使用的授权服务中登记）</span>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded border border-subtle bg-surface-2 px-2 py-1 text-xs text-secondary">
              {redirectUri}
            </code>
            <IconButton size="sm" aria-label="复制回调地址" onClick={() => void copyRedirect()}>
              <Copy size={16} strokeWidth={1.75} aria-hidden />
            </IconButton>
          </div>
        </div>
        {openManual ? (
          <div className="flex flex-col gap-2">
            <Input
              label="粘贴浏览器地址栏的完整回调 URL（或仅 code）"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="http://127.0.0.1:51789/callback?code=…&state=…"
            />
            <div className="text-xs text-tertiary">
              适用：容器 / 远程开发、防火墙拦截、授权服务限制回调地址。
            </div>
            <Button
              size="sm"
              className="self-start"
              disabled={submitting || manual.trim() === ''}
              onClick={() => void submitManual()}
            >
              提交
            </Button>
          </div>
        ) : (
          <button
            type="button"
            className="self-start text-xs text-accent-600 underline dark:text-accent-300"
            onClick={() => setOpenManual(true)}
          >
            无法自动回调？手动粘贴
          </button>
        )}
      </div>
    </Dialog>
  );
}
