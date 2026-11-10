// electron/src/main/oauth/service.ts
//
// OAuth 编排层（spec §8）。职责边界：
//   - 只做流程编排与状态机，不含 UI、不含消费者知识
//   - 令牌只在主进程内流转；对外只交付 ConnectionView / AuthMaterial
//   - 连接变更经 setOAuthChangeListener 通知（MCP 池驱逐由消费方订阅）
// 依赖方向：oauth/* 可 import mcp/host-manager；反向禁止（mcp 侧用 setter 注入反接，见 Task 12）。
import { randomUUID } from 'node:crypto';
import { logger } from '../logger';
import { getDb } from '../storage/db';
import { getSecret, setSecret } from '../storage/keychain';
import {
  insertConnection, getConnection, listConnections, findReusable,
  updateConnection, deleteConnection,
} from './store';
import { clientSecretKey, clearTokenSet, loadTokenSet, saveTokenSet } from './keys';
import { createPkcePair, createState } from './protocol/pkce';
import { exchangeCode, revokeToken } from './protocol/token';
import { discoverForResource } from './protocol/discovery';
import { registerClient } from './protocol/registration';
import { buildAuthorizationUrl } from './protocol/authorize';
import { startLoopbackServer, parseManualCallback, type LoopbackServer } from './protocol/loopback-server';
import { resolveFetch } from './protocol/http';
import { assertEndpointAllowed } from './protocol/endpoint-guard';
import { getMcpConfig } from '../mcp/host-manager';
import {
  OAuthFailure, type AuthRequirement, type ClientAuthMethod, type ConnectionView,
  type OAuthConnection, type OAuthTokenSet,
} from './types';

export type OnConnectionChanged = (
  connectionId: string,
  kind: 'refreshed' | 'needs_reauth' | 'revoked',
) => void;

let changeListener: OnConnectionChanged | null = null;

export function setOAuthChangeListener(listener: OnConnectionChanged | null): void {
  changeListener = listener;
}

export function emitOAuthChange(
  connectionId: string,
  kind: 'refreshed' | 'needs_reauth' | 'revoked',
): void {
  try {
    changeListener?.(connectionId, kind);
  } catch (err) {
    // 监听方异常不得影响主流程
    logger.warn('OAuth 变更监听异常', { error: (err as Error).message });
  }
}

export type OnAuthorizationComplete = (pendingId: string, view: ConnectionView) => void;

let authorizationCompleteListener: OnAuthorizationComplete | null = null;

/** loopback 异步完成时通知 IPC 层（回写 MCP 绑定 + 推送 renderer） */
export function setAuthorizationCompleteListener(
  listener: OnAuthorizationComplete | null,
): void {
  authorizationCompleteListener = listener;
}

export interface ManualAuthInput {
  displayName: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string | null;
  clientAuthMethod?: ClientAuthMethod;
  scopes?: string;
  resource?: string | null;
  issuer?: string | null;
  revocationEndpoint?: string | null;
  userinfoEndpoint?: string | null;
  redirectHost?: string;
  redirectPort?: number | null;
  allowInsecureTls?: boolean;
  extraAuthorizeParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
}

// 预设仅用于 renderer 预填手动表单（listPresets/loadPreset）——内置预设 clientId 为空且
// 无注册端点，独立授权入口必然 registration_failed，故不入 BeginInput（裁决 R5）。
export type BeginInput = { manual: ManualAuthInput } | { mcpName: string };

export interface BeginResult {
  pendingId: string | null;
  authorizationUrl: string | null;
  redirectUri: string | null;
  existingConnectionId: string | null;
}

interface PendingAuthorization {
  id: string;
  requirement: AuthRequirement;
  verifier: string;
  state: string;
  redirectUri: string;
  server: LoopbackServer;
  createdAt: number;
}

const pending = new Map<string, PendingAuthorization>();
const PENDING_TTL_MS = 10 * 60 * 1000;

function sweepPending(): void {
  const now = Date.now();
  for (const [id, item] of pending) {
    if (now - item.createdAt > PENDING_TTL_MS) {
      pending.delete(id);
      void item.server.close();
    }
  }
}

/** 测试专用：清空内存中的待授权项并复位变更监听，避免用例间状态泄漏 */
export function __resetOAuthServiceForTest(): void {
  for (const item of pending.values()) void item.server.close();
  pending.clear();
  changeListener = null;
  authorizationCompleteListener = null;
}

export function toConnectionView(conn: OAuthConnection): ConnectionView {
  return {
    id: conn.id,
    displayName: conn.displayName,
    accountLabel: conn.accountLabel,
    status: conn.status,
    scopes: conn.scopes,
    expiresAt: conn.expiresAt,
    source: conn.source,
  };
}

export function listConnectionViews(): ConnectionView[] {
  return listConnections().map(toConnectionView);
}

export function getConnectionView(id: string): ConnectionView | null {
  const conn = getConnection(id);
  return conn ? toConnectionView(conn) : null;
}

/** provider_key 归一：identity|client_id|resource|scopes；identity = issuer ?? authorization origin */
export function computeProviderKey(req: Pick<AuthRequirement,
  'issuer' | 'authorizationEndpoint' | 'clientId' | 'resource' | 'scopes'>): string {
  let identity = req.issuer;
  if (!identity) {
    try {
      identity = new URL(req.authorizationEndpoint).origin;
    } catch {
      identity = req.authorizationEndpoint;
    }
  }
  return [identity, req.clientId ?? '', req.resource ?? '', req.scopes].join('|');
}

/** manual / mcp 两态 → AuthRequirement（mcp 分支做发现；预设已降级为 renderer 预填） */
async function buildRequirement(input: BeginInput): Promise<AuthRequirement> {
  if ('manual' in input) {
    const m = input.manual;
    const req: AuthRequirement = {
      providerKey: '',
      displayName: m.displayName,
      authorizationEndpoint: m.authorizationEndpoint,
      tokenEndpoint: m.tokenEndpoint,
      issuer: m.issuer ?? null,
      registrationEndpoint: null,
      revocationEndpoint: m.revocationEndpoint ?? null,
      userinfoEndpoint: m.userinfoEndpoint ?? null,
      clientId: m.clientId,
      clientSecret: m.clientSecret ?? null,
      clientAuthMethod: m.clientAuthMethod ?? 'none',
      scopes: m.scopes ?? '',
      resource: m.resource ?? null,
      extraAuthorizeParams: m.extraAuthorizeParams ?? {},
      extraTokenParams: m.extraTokenParams ?? {},
      redirectHost: m.redirectHost ?? '127.0.0.1',
      redirectPort: m.redirectPort ?? null,
      allowInsecureTls: m.allowInsecureTls ?? false,
      source: 'manual',
    };
    req.providerKey = computeProviderKey(req);
    return req;
  }

  const config = getMcpConfig(input.mcpName);
  if (!config) throw new OAuthFailure('no_connection', `MCP ${input.mcpName} 未注册`);
  if ((config.transport ?? 'stdio') !== 'streamable_http' || !config.url) {
    throw new OAuthFailure('no_connection', `MCP ${input.mcpName} 不是远程条目，无法使用 OAuth`);
  }
  const meta = await discoverForResource(config.url, null);
  const req: AuthRequirement = {
    providerKey: '',
    displayName: config.name,
    authorizationEndpoint: meta.authorizationEndpoint,
    tokenEndpoint: meta.tokenEndpoint,
    issuer: meta.issuer,
    registrationEndpoint: meta.registrationEndpoint,
    revocationEndpoint: meta.revocationEndpoint,
    userinfoEndpoint: meta.userinfoEndpoint,
    clientId: null,
    clientAuthMethod: 'none',
    scopes: meta.scopesSupported.join(' '),
    resource: config.url,
    extraAuthorizeParams: {},
    extraTokenParams: {},
    redirectHost: '127.0.0.1',
    redirectPort: null,
    allowInsecureTls: config.url.startsWith('http://'),
    source: 'mcp',
  };
  req.providerKey = computeProviderKey(req);
  return req;
}

async function ensureClientRegistration(
  req: AuthRequirement,
  redirectUri: string,
): Promise<AuthRequirement> {
  if (req.clientId) return req;
  if (!req.registrationEndpoint) {
    throw new OAuthFailure('registration_failed', '该授权服务器不支持动态注册，请手工填写 client_id');
  }
  const result = await registerClient({
    registrationEndpoint: req.registrationEndpoint,
    redirectUris: [redirectUri],
    clientName: 'Momo Studio',
    scopes: req.scopes,
    allowInsecureTls: req.allowInsecureTls,
  });
  return {
    ...req,
    clientId: result.clientId,
    clientAuthMethod: result.authMethod,
    clientSecret: result.clientSecret,
  };
}

export async function beginAuthorization(input: BeginInput): Promise<BeginResult> {
  sweepPending();
  let requirement = await buildRequirement(input);

  // 复用检查（provider_key 相同且有效 → 不新建、不弹浏览器）
  // 注意：MCP 分支此时 clientId 必为 null（DCR 尚未发生），provider_key 里的
  // client_id 段为空串——同一 MCP 第二次授权时重算仍为空串，因此能正确复用。
  // 若在此处加 `if (requirement.clientId)` 守卫，MCP 分支将永远跳过复用（已修）。
  {
    const reusable = findReusable(computeProviderKey(requirement));
    if (reusable) {
      return {
        pendingId: null,
        authorizationUrl: null,
        redirectUri: null,
        existingConnectionId: reusable.id,
      };
    }
  }

  const { verifier, challenge } = createPkcePair();
  const state = createState();
  // 需要 DCR 时必须先起服务器拿实际端口——注册要带 redirect_uri
  const server = await startLoopbackServer({
    host: requirement.redirectHost,
    port: requirement.redirectPort,
    expectedState: state,
  });

  try {
    requirement = await ensureClientRegistration(requirement, server.redirectUri);

    const authorizationUrl = buildAuthorizationUrl({
      authorizationEndpoint: requirement.authorizationEndpoint,
      clientId: requirement.clientId ?? '',
      redirectUri: server.redirectUri,
      scopes: requirement.scopes,
      state,
      codeChallenge: challenge,
      resource: requirement.resource,
      extraParams: requirement.extraAuthorizeParams,
    });

    const pendingId = randomUUID();
    pending.set(pendingId, {
      id: pendingId,
      requirement,
      verifier,
      state,
      redirectUri: server.redirectUri,
      server,
      createdAt: Date.now(),
    });

    // 浏览器回调路径：成功后走同一条完成链（异步，不阻塞 begin 返回）
    void server
      .waitForCallback()
      .then(({ code }) => finishAuthorization(pendingId, code))
      .catch((err: unknown) => {
        // pending 已被手动回调 / 取消接管：关闭服务器触发的「授权已取消」属预期路径，不告警
        if (!pending.has(pendingId)) return;
        logger.warn('OAuth 回环授权未完成', { pendingId, error: (err as Error).message });
        pending.delete(pendingId);
      });

    return { pendingId, authorizationUrl, redirectUri: server.redirectUri, existingConnectionId: null };
  } catch (err) {
    // 注册/URL 构造失败：回环服务器已监听但从未挂等待者，必须显式关闭避免端口泄漏
    await server.close();
    throw err;
  }
}

export async function completeWithManualCallback(input: {
  pendingId: string;
  input: string;
}): Promise<ConnectionView> {
  const item = pending.get(input.pendingId);
  if (!item) throw new OAuthFailure('authorization_cancelled', '授权流程已失效，请重新发起');
  // state 校验失败时保留 pending（用户可重试）——parseManualCallback 抛错在前
  const code = parseManualCallback(input.input, item.state);
  return finishAuthorization(input.pendingId, code);
}

export async function cancelAuthorization(pendingId: string): Promise<void> {
  const item = pending.get(pendingId);
  if (!item) return;
  pending.delete(pendingId);
  await item.server.close();
}

async function fetchAccountLabel(
  req: AuthRequirement,
  accessToken: string,
  allowInsecureTls: boolean,
): Promise<string> {
  if (!req.userinfoEndpoint) return '';
  try {
    // 账号名是尽力而为的附加信息；端点必须先过准入，绝不明文携带 Bearer 发往非回环
    assertEndpointAllowed(req.userinfoEndpoint);
    const fetchFn = resolveFetch(allowInsecureTls);
    const response = await fetchFn(req.userinfoEndpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return '';
    const body = (await response.json()) as Record<string, unknown>;
    for (const key of ['login', 'preferred_username', 'email', 'name', 'sub']) {
      const value = body[key];
      if (typeof value === 'string' && value !== '') return value;
    }
    return '';
  } catch {
    return '';
  }
}

async function finishAuthorization(pendingId: string, code: string): Promise<ConnectionView> {
  const item = pending.get(pendingId);
  if (!item) throw new OAuthFailure('authorization_cancelled', '授权流程已失效，请重新发起');
  pending.delete(pendingId);
  // 手动回调路径下回环服务器仍在监听：先关掉，避免遗留端口与 10 分钟超时定时器。
  // 浏览器回调路径此时 close() 已在进行/完成（幂等，重复调用无副作用）。
  await item.server.close();
  const req = item.requirement;

  const tokens = await exchangeCode({
    tokenEndpoint: req.tokenEndpoint,
    clientId: req.clientId ?? '',
    clientAuthMethod: req.clientAuthMethod,
    clientSecret: req.clientSecret,
    code,
    codeVerifier: item.verifier,
    redirectUri: item.redirectUri,
    extraParams: req.extraTokenParams,
    allowInsecureTls: req.allowInsecureTls,
  });

  const accountLabel = await fetchAccountLabel(req, tokens.accessToken, req.allowInsecureTls);

  const stored = insertConnection({
    providerKey: req.providerKey,
    displayName: req.displayName,
    authorizationEndpoint: req.authorizationEndpoint,
    tokenEndpoint: req.tokenEndpoint,
    clientId: req.clientId ?? '',
    accountLabel,
    issuer: req.issuer,
    registrationEndpoint: req.registrationEndpoint,
    revocationEndpoint: req.revocationEndpoint,
    userinfoEndpoint: req.userinfoEndpoint,
    clientAuthMethod: req.clientAuthMethod,
    scopes: req.scopes,
    resource: req.resource,
    extraAuthorizeParams: req.extraAuthorizeParams,
    extraTokenParams: req.extraTokenParams,
    redirectHost: req.redirectHost,
    redirectPort: req.redirectPort,
    allowInsecureTls: req.allowInsecureTls,
    status: 'connected',
    expiresAt: tokens.expiresAt,
    source: req.source,
  });

  try {
    await saveTokenSet(stored.id, tokens);
    if (req.clientSecret) {
      await setSecret(clientSecretKey(stored.id), req.clientSecret);
    }
  } catch (err) {
    // 密钥环不可用（Linux 无 Secret Service 等）——回滚已写入的部分密文并删行，
    // 避免留下无凭据的孤儿连接。
    await clearTokenSet(stored.id).catch(() => undefined);
    deleteConnection(stored.id);
    throw new OAuthFailure(
      'keychain_unavailable',
      '系统密钥环不可用，无法保存授权凭据',
      stored.id,
      (err as Error).message,
    );
  }

  const view = toConnectionView(stored);
  try {
    authorizationCompleteListener?.(pendingId, view);
  } catch (err) {
    // 与 emitOAuthChange 同语义：监听方异常不得影响主流程——此处连接已落库，
    // 抛穿会让浏览器回调路径误记「授权未完成」、手动回调路径向 renderer 误报失败
    logger.warn('OAuth 授权完成监听异常', { error: (err as Error).message });
  }
  return view;
}

/**
 * 消费方取连接元数据 + 密文（MCP 适配器 / 生命周期共用）。
 * 连接不存在、已撤销或密文缺失一律返回 null——调用方据此走「需重新授权」。
 * 只导出给主进程内部消费者；令牌不得跨进程/跨模块外漏。
 */
export interface ConsumerConnection {
  connection: OAuthConnection;
  tokenSet: OAuthTokenSet;
}

export async function loadConnectionForConsumer(
  connectionId: string,
): Promise<ConsumerConnection | null> {
  const connection = getConnection(connectionId);
  if (!connection) return null;
  const tokenSet = await loadTokenSet(connectionId);
  if (!tokenSet) return null;
  return { connection, tokenSet };
}

/** 查询引用某连接的 MCP 名（断开/删除前展示影响面） */
export function listMcpNamesByConnection(connectionId: string): string[] {
  const rows = getDb()
    .prepare('SELECT name FROM mcp_definitions WHERE oauth_connection_id = ? ORDER BY name')
    .all(connectionId) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

async function revokeBestEffort(conn: OAuthConnection): Promise<void> {
  if (!conn.revocationEndpoint) return;
  // 撤销是尽力而为：密钥环不可用等异常不得阻断断开主流程，也绝不记录 token 值
  try {
    const tokenSet = await loadTokenSet(conn.id);
    if (!tokenSet) return;
    const clientSecret = await getSecret(clientSecretKey(conn.id));
    await revokeToken({
      revocationEndpoint: conn.revocationEndpoint,
      token: tokenSet.accessToken,
      tokenTypeHint: 'access_token',
      clientId: conn.clientId,
      clientAuthMethod: conn.clientAuthMethod,
      clientSecret,
      allowInsecureTls: conn.allowInsecureTls,
    });
  } catch (err) {
    logger.warn('OAuth 撤销授权失败或密钥环不可用，继续断开流程', {
      connectionId: conn.id,
      error: (err as Error).message,
    });
  }
}

/** 断开：撤销 + 清密钥 + 置 revoked；绑定保留（用户可一键重授权） */
export async function disconnect(id: string): Promise<{ affectedMcpNames: string[] }> {
  const conn = getConnection(id);
  if (!conn) throw new OAuthFailure('no_connection', '连接不存在');
  const affectedMcpNames = listMcpNamesByConnection(id);
  await revokeBestEffort(conn);
  // 先落 revoked 状态并通知消费方，再清密钥——清密钥失败时状态仍是一致的
  updateConnection(id, { status: 'revoked', expiresAt: null, lastRefreshedAt: null });
  emitOAuthChange(id, 'revoked');
  try {
    await clearTokenSet(id);
  } catch (err) {
    throw new OAuthFailure(
      'keychain_unavailable',
      '系统密钥环不可用，无法清理授权凭据',
      id,
      (err as Error).message,
    );
  }
  return { affectedMcpNames };
}

/** 物理删除：有引用则拒绝（对齐 deleteProvider 的引用阻断语义） */
export async function removeConnection(id: string): Promise<{ affectedMcpNames: string[] }> {
  const conn = getConnection(id);
  if (!conn) throw new OAuthFailure('no_connection', '连接不存在');
  const affectedMcpNames = listMcpNamesByConnection(id);
  if (affectedMcpNames.length > 0) {
    throw new OAuthFailure(
      'no_connection',
      `该连接仍被 ${affectedMcpNames.length} 个 MCP 服务器使用，请先解除绑定`,
      id,
      affectedMcpNames.join(', '),
    );
  }
  // 显式等待清密钥（store.deleteConnection 的清理由是 fire-and-forget，不保证此处已完成）
  await clearTokenSet(id);
  deleteConnection(id);
  emitOAuthChange(id, 'revoked');
  return { affectedMcpNames: [] };
}
