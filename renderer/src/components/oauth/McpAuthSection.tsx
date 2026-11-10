// renderer/src/components/oauth/McpAuthSection.tsx
//
// MCP 认证区块（spec §13.2，预览 v2 区块 D）：该 MCP 服务器的授权管理点。
// 未绑定 → 授权（stdio 需环境变量名）；已绑定 → 连接信息 + 共享提示 + 解除绑定/撤销授权；
// needs_reauth → 重新授权。授权成功由主进程回写绑定并驱逐池，父层用 mcp:start 重连。
import { useEffect, useState } from 'react';
import { KeyRound, ShieldOff } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { OAuthConnectionView } from '../../ipc/types';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { AuthorizeDialog } from './AuthorizeDialog';

interface Props {
  mcpName: string;
  transport: 'stdio' | 'streamable_http';
  connectionId?: string;
  envVar?: string;
  onChange: (next: { connectionId: string; envVar: string }) => void;
  onAuthorized?: () => void;
}

const STATUS_LABEL: Record<OAuthConnectionView['status'], string> = {
  connected: '已连接',
  needs_reauth: '需重新授权',
  revoked: '已断开',
};

export function McpAuthSection({ mcpName, transport, connectionId, envVar, onChange, onAuthorized }: Props) {
  const [connections, setConnections] = useState<OAuthConnectionView[]>([]);
  const [sharedOthers, setSharedOthers] = useState(0);
  const [authorizing, setAuthorizing] = useState<{ pendingId: string; authorizationUrl: string; redirectUri: string } | null>(null);
  const [envDraft, setEnvDraft] = useState(envVar ?? '');
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string[] | null>(null);
  const [revokingBusy, setRevokingBusy] = useState(false);

  useEffect(() => { void ipc.oauth.listConnections().then(setConnections); }, []);
  useEffect(() => {
    if (!connectionId) { setSharedOthers(0); return; }
    void ipc.oauth.listBoundMcps(connectionId)
      .then((names) => setSharedOthers(Math.max(0, names.filter((n) => n !== mcpName).length)))
      .catch(() => setSharedOthers(0));
  }, [connectionId, mcpName]);

  const missingEnvVar = transport === 'stdio' && envDraft.trim() === '';
  const bound = connectionId ? connections.find((c) => c.id === connectionId) : undefined;

  const authorize = async (): Promise<void> => {
    setError(null);
    try {
      const result = await ipc.oauth.beginAuthorizationForMcp(mcpName, envDraft.trim() || null);
      if (result.existingConnectionId) {
        onChange({ connectionId: result.existingConnectionId, envVar: envDraft });
        onAuthorized?.();
        return;
      }
      if (result.pendingId && result.authorizationUrl && result.redirectUri) {
        setAuthorizing({ pendingId: result.pendingId, authorizationUrl: result.authorizationUrl, redirectUri: result.redirectUri });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const unbind = async (): Promise<void> => {
    setError(null);
    try {
      await ipc.oauth.unbindMcp(mcpName);
      onChange({ connectionId: '', envVar: envDraft });
      onAuthorized?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startRevoke = async (): Promise<void> => {
    setError(null);
    try {
      const { affectedMcpNames } = await ipc.oauth.disconnect(connectionId!);
      setRevoking(affectedMcpNames);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const confirmRevoke = async (): Promise<void> => {
    setRevokingBusy(true);
    try {
      await ipc.oauth.unbindMcp(mcpName);
      setRevoking(null);
      onChange({ connectionId: '', envVar: envDraft });
      onAuthorized?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevokingBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-1 px-3 py-2">
      <div className="flex items-center gap-2 text-sm text-primary">
        <KeyRound size={16} strokeWidth={1.75} aria-hidden />
        认证
      </div>

      {revoking ? (
        <div className="flex flex-col gap-2 text-xs">
          <span className="text-status-error">撤销将断开使用此授权的服务器：{revoking.join('、')}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="danger" disabled={revokingBusy} onClick={() => void confirmRevoke()}>确认撤销</Button>
            <Button size="sm" variant="ghost" onClick={() => setRevoking(null)}>取消</Button>
          </div>
        </div>
      ) : bound ? (
        <>
          <div className="flex items-center gap-2 text-xs text-secondary flex-wrap">
            <span className="truncate">
              {bound.displayName}
              {bound.accountLabel ? ` · ${bound.accountLabel}` : ''}
            </span>
            <span className={`px-2 py-0.5 rounded-full ${
              bound.status === 'connected' ? 'bg-status-success-tint text-status-success'
                : bound.status === 'needs_reauth' ? 'bg-status-warning-tint text-status-warning'
                : 'bg-surface-3 text-tertiary'
            }`}>{STATUS_LABEL[bound.status]}</span>
            {sharedOthers > 0 && <span className="text-tertiary">此授权也被 {sharedOthers} 个其他服务器使用</span>}
          </div>
          <div className="flex items-center justify-end gap-3">
            {bound.status === 'needs_reauth' && (
              <Button size="sm" onClick={() => void authorize()}>重新授权</Button>
            )}
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs text-accent-600 dark:text-accent-300 underline"
              onClick={() => void startRevoke()}
            >
              <ShieldOff size={13} strokeWidth={1.75} aria-hidden />
              撤销授权…
            </button>
            <Button size="sm" variant="ghost" onClick={() => void unbind()}>解除绑定</Button>
          </div>
          <div className="text-xs text-tertiary">
            解除绑定 = 保留授权，仅此服务器不再使用；撤销授权 = 吊销令牌（会影响共享它的服务器）。
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2 text-xs text-tertiary flex-wrap">
          <span>未绑定 OAuth 连接</span>
          <Button size="sm" variant="secondary" disabled={missingEnvVar} onClick={() => void authorize()}>授权</Button>
          {missingEnvVar && <span className="text-status-warning">请先填写注入的环境变量名</span>}
        </div>
      )}

      {transport === 'stdio' && (
        <Input
          label="注入的环境变量名"
          value={envDraft}
          placeholder="GITHUB_TOKEN"
          onChange={(e) => {
            setEnvDraft(e.target.value);
            onChange({ connectionId: connectionId ?? '', envVar: e.target.value });
          }}
        />
      )}

      {error && <div className="text-status-error text-xs">{error}</div>}

      {authorizing && (
        <AuthorizeDialog
          pendingId={authorizing.pendingId}
          authorizationUrl={authorizing.authorizationUrl}
          redirectUri={authorizing.redirectUri}
          onSuccess={() => {
            setAuthorizing(null);
            void ipc.oauth.listConnections().then(setConnections);
            onAuthorized?.();
          }}
          onClose={() => setAuthorizing(null)}
        />
      )}
    </div>
  );
}
