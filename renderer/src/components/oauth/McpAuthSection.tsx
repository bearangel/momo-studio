// renderer/src/components/oauth/McpAuthSection.tsx
//
// MCP 认证区块（spec §13.2，预览 v2 区块 D）：该 MCP 服务器的授权管理点。
// 未绑定 → 授权（stdio 需环境变量名）；已绑定 → 连接信息 + 共享提示 + 撤销授权
// （R13：唯一离场动作，吊销令牌 + 清绑定；「解除绑定」已移除）；needs_reauth →
// 重新授权。授权成功由主进程回写绑定并驱逐池，父层用 mcp:start 重连。
//
// 绑定态自愈（review 修复）：boundId 以内部态持有（prop 播种），订阅
// oauth:authorizationChanged 的 connected 推送即收即用——就地授权完成后无需
// 父层重传 prop 即可见「已绑定」。撤销授权为两步确认：第一步只读 listBoundMcps
// 取影响面，用户「确认撤销」后才 disconnect（吊销令牌）+ unbindMcp（清绑定）。
import { useEffect, useRef, useState } from 'react';
import { KeyRound, ShieldOff } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { AuthorizationChangedPayload, OAuthConnectionView } from '../../ipc/types';
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
  // 授权进行中：state 驱动按钮禁用，ref 挡同 tick 双击（state 闭包滞后防不住）
  const [authorizeBusy, setAuthorizeBusy] = useState(false);
  const authorizeBusyRef = useRef(false);
  // 绑定连接 id：内部态为显示真相源（prop 播种 + 完成推送自愈）；onChange 仅通知父层
  const [boundId, setBoundId] = useState(connectionId);

  useEffect(() => { setBoundId(connectionId); }, [connectionId]);

  const refreshConnections = (): void => {
    void ipc.oauth.listConnections().then(setConnections).catch(() => setConnections([]));
  };

  useEffect(refreshConnections, []);

  // 就地授权完成推送：主进程已回写绑定，此处收 connectionId 自愈 boundId
  useEffect(
    () =>
      ipc.oauth.onAuthorizationChanged((payload: AuthorizationChangedPayload) => {
        if (payload.status === 'connected' && payload.connectionId) {
          setBoundId(payload.connectionId);
          refreshConnections();
        }
      }),
    [],
  );

  useEffect(() => {
    if (!boundId) { setSharedOthers(0); return; }
    void ipc.oauth.listBoundMcps(boundId)
      .then((names) => setSharedOthers(Math.max(0, names.filter((n) => n !== mcpName).length)))
      .catch(() => setSharedOthers(0));
  }, [boundId, mcpName]);

  const missingEnvVar = transport === 'stdio' && envDraft.trim() === '';
  const bound = boundId ? connections.find((c) => c.id === boundId) : undefined;

  const authorize = async (): Promise<void> => {
    if (authorizeBusyRef.current) return;
    authorizeBusyRef.current = true;
    setAuthorizeBusy(true);
    setError(null);
    try {
      const result = await ipc.oauth.beginAuthorizationForMcp(mcpName, envDraft.trim() || null);
      if (result.existingConnectionId) {
        setBoundId(result.existingConnectionId);
        onChange({ connectionId: result.existingConnectionId, envVar: envDraft });
        onAuthorized?.();
        return;
      }
      if (result.pendingId && result.authorizationUrl && result.redirectUri) {
        setAuthorizing({ pendingId: result.pendingId, authorizationUrl: result.authorizationUrl, redirectUri: result.redirectUri });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      authorizeBusyRef.current = false;
      setAuthorizeBusy(false);
    }
  };

  const startRevoke = async (): Promise<void> => {
    if (!boundId) return;
    setError(null);
    try {
      const names = await ipc.oauth.listBoundMcps(boundId);
      setRevoking(names);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const confirmRevoke = async (): Promise<void> => {
    if (!boundId) return;
    setRevokingBusy(true);
    setError(null);
    try {
      await ipc.oauth.disconnect(boundId);
      await ipc.oauth.unbindMcp(mcpName);
      setRevoking(null);
      setBoundId(undefined);
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
          <div className="flex items-center justify-end gap-2">
            {bound.status === 'needs_reauth' && (
              <Button size="sm" disabled={authorizeBusy} onClick={() => void authorize()}>重新授权</Button>
            )}
            {/* R13：唯一离场动作 = 撤销授权（吊销令牌 + 清绑定）。
                「解除绑定」已移除——独立连接管理页取消后（R6），
                「保留授权但不绑定」只产生 UI 不可见的孤儿连接，无消费面 */}
            <Button size="sm" variant="danger-outline" onClick={() => void startRevoke()}>
              <ShieldOff size={14} strokeWidth={1.75} aria-hidden />
              撤销授权…
            </Button>
          </div>
          <div className="text-xs text-tertiary">
            撤销授权 = 吊销令牌并解除绑定（会影响共享此授权的服务器）。
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2 text-xs text-tertiary flex-wrap">
          <span>未绑定 OAuth 连接</span>
          <Button size="sm" variant="secondary" disabled={missingEnvVar || authorizeBusy} onClick={() => void authorize()}>授权</Button>
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
            onChange({ connectionId: boundId ?? '', envVar: e.target.value });
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
            refreshConnections();
            onAuthorized?.();
          }}
          onClose={() => setAuthorizing(null)}
        />
      )}
    </div>
  );
}
