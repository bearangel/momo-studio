// electron/src/main/oauth/lifecycle.ts
//
// 令牌生命周期（spec §11）：
//   - 过期前 5 分钟主动刷新；无 expires_at 视为不过期
//   - 单飞：同一连接并发刷新只发一个请求
//   - 轮换：响应带新 refresh_token 覆盖旧值；未带则保留旧值
//   - 失败分类：invalid_grant → needs_reauth（保留行，用户可重授权）；
//     网络/5xx → 退避重试（1m/5m/15m），3 次后同样落 needs_reauth
//   - 60s 扫描器（startOAuthLifecycle）覆盖「长期不用也会过期」的场景
import { logger } from '../logger';
import { getSecret } from '../storage/keychain';
import { getConnection, listConnections, updateConnection } from './store';
import { clientSecretKey, loadTokenSet, saveTokenSet } from './keys';
import { refreshTokens } from './protocol/token';
import { emitOAuthChange } from './service';
import { OAuthFailure } from './types';

/** 过期前 5 分钟即主动刷新，避免请求途中过期 */
const REFRESH_AHEAD_MS = 5 * 60 * 1000;
/** 后台扫描间隔 */
const SWEEP_INTERVAL_MS = 60 * 1000;
/** 退避阶梯：第 1/2/3 次失败前分别等待（毫秒） */
const BACKOFF_MS = [60_000, 300_000, 900_000];
/** 单次调用内的最大尝试次数（含首次） */
const MAX_ATTEMPTS = 3;

/** 单飞表：connectionId → 进行中的刷新 Promise */
const inflight = new Map<string, Promise<string>>();
/** 当前连接已连续失败的次数（成功后清零；供退避与观测） */
const retryCount = new Map<string, number>();
let sweeper: NodeJS.Timeout | null = null;

export interface OAuthLifecycleTestHooks {
  /** 覆盖退避等待（测试跳过长延时）；attempt 从 0 开始 */
  waitBeforeRetry?: (attempt: number) => Promise<void>;
}

const defaultHooks: Required<OAuthLifecycleTestHooks> = {
  waitBeforeRetry: (attempt) =>
    new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt] ?? BACKOFF_MS[2])),
};

let hooks: Required<OAuthLifecycleTestHooks> = defaultHooks;

/** 测试缝：注入退避等待（生产不调用） */
export function setOAuthLifecycleTestHooks(next: OAuthLifecycleTestHooks): void {
  hooks = { ...defaultHooks, ...next };
}

/** 测试缝：清零单飞表、退避计数与注入的钩子，避免用例间状态泄漏 */
export function __resetOAuthLifecycleForTest(): void {
  inflight.clear();
  retryCount.clear();
  hooks = defaultHooks;
}

/** 过期判定：null = 永不过期；非法时间串按「不刷新」降级，避免无限刷新 */
function needsRefresh(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs)) return false;
  return expiresMs - Date.now() <= REFRESH_AHEAD_MS;
}

/** 置 needs_reauth + 通知消费方，返回可抛的错误（保留调用方 detail） */
function failNeedsReauth(
  connectionId: string,
  message: string,
  detail?: string,
): OAuthFailure {
  retryCount.delete(connectionId);
  updateConnection(connectionId, { status: 'needs_reauth' });
  emitOAuthChange(connectionId, 'needs_reauth');
  return new OAuthFailure('needs_reauth', message, connectionId, detail);
}

async function doRefresh(connectionId: string): Promise<string> {
  const conn = getConnection(connectionId);
  if (!conn) throw new OAuthFailure('no_connection', '连接不存在', connectionId);
  // revoked / needs_reauth 已明确不可用：不刷新，直接要求重新授权（不重复置位/通知）
  if (conn.status !== 'connected') {
    throw new OAuthFailure('needs_reauth', '连接已失效，请重新授权', connectionId);
  }

  const tokenSet = await loadTokenSet(connectionId);
  if (!tokenSet) {
    throw failNeedsReauth(connectionId, '连接缺少凭据，请重新授权');
  }
  if (!tokenSet.refreshToken) {
    // 无 refresh_token：只能等用户重新授权（短期 token 场景）
    throw failNeedsReauth(connectionId, '该连接没有 refresh_token，请重新授权');
  }
  const clientSecret = await getSecret(clientSecretKey(connectionId));

  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const next = await refreshTokens({
        tokenEndpoint: conn.tokenEndpoint,
        clientId: conn.clientId,
        clientAuthMethod: conn.clientAuthMethod,
        clientSecret,
        refreshToken: tokenSet.refreshToken,
        extraParams: conn.extraTokenParams,
        allowInsecureTls: conn.allowInsecureTls,
      });
      // 轮换：响应未带 refresh_token 时保留旧值
      const effectiveRefresh = next.refreshToken ?? tokenSet.refreshToken;
      await saveTokenSet(connectionId, { ...next, refreshToken: effectiveRefresh });
      updateConnection(connectionId, {
        status: 'connected',
        expiresAt: next.expiresAt,
        lastRefreshedAt: new Date().toISOString(),
      });
      retryCount.delete(connectionId);
      emitOAuthChange(connectionId, 'refreshed');
      return next.accessToken;
    } catch (err) {
      lastError = err;
      // invalid_grant：授权已死，重试无意义——立即落 needs_reauth 并抛出
      if (err instanceof OAuthFailure && err.code === 'needs_reauth') {
        throw failNeedsReauth(connectionId, err.message, err.detail);
      }
      // 网络 / 5xx 等可重试失败：记录计数，非末次则退避后再试
      retryCount.set(connectionId, attempt + 1);
      if (attempt < MAX_ATTEMPTS - 1) await hooks.waitBeforeRetry(attempt);
    }
  }

  logger.warn('OAuth 令牌刷新重试耗尽', { connectionId, attempts: MAX_ATTEMPTS });
  retryCount.delete(connectionId);
  updateConnection(connectionId, { status: 'needs_reauth' });
  emitOAuthChange(connectionId, 'needs_reauth');
  throw lastError instanceof OAuthFailure
    ? lastError
    : new OAuthFailure('refresh_failed', '令牌刷新失败', connectionId);
}

/** 单飞入口：返回可用 access token（必要时刷新） */
export function ensureFreshAccessToken(connectionId: string): Promise<string> {
  const existing = inflight.get(connectionId);
  if (existing) return existing;

  const task = (async () => {
    const conn = getConnection(connectionId);
    if (!conn) throw new OAuthFailure('no_connection', '连接不存在', connectionId);
    // 失效连接一律拒绝：即便尚未到期也不交付令牌
    if (conn.status !== 'connected') {
      throw new OAuthFailure('needs_reauth', '连接已失效，请重新授权', connectionId);
    }
    if (!needsRefresh(conn.expiresAt)) {
      const set = await loadTokenSet(connectionId);
      if (!set) throw failNeedsReauth(connectionId, '连接缺少凭据，请重新授权');
      return set.accessToken;
    }
    return doRefresh(connectionId);
  })().finally(() => {
    inflight.delete(connectionId);
  });

  inflight.set(connectionId, task);
  return task;
}

/** 单次扫描：只处理 connected 且临近过期的连接；失败由内部落 needs_reauth */
function sweepOnce(): void {
  for (const conn of listConnections()) {
    if (conn.status !== 'connected') continue;
    if (!needsRefresh(conn.expiresAt)) continue;
    void ensureFreshAccessToken(conn.id).catch((err: unknown) => {
      // needs_reauth 已在内部置位并通知，这里只记录非预期异常，避免未处理 rejection
      if (!(err instanceof OAuthFailure && err.code === 'needs_reauth')) {
        logger.warn('OAuth 后台刷新失败', { connectionId: conn.id, err });
      }
    });
  }
}

/** 启动 60s 扫描（main boot 调用一次；重复调用幂等） */
export function startOAuthLifecycle(): void {
  if (sweeper) return;
  sweeper = setInterval(sweepOnce, SWEEP_INTERVAL_MS);
  // 扫描器不得单独保活进程（Electron 生命周期由窗口/app 决定；测试也免于挂住）
  sweeper.unref();
  // 启动即扫一遍，覆盖「刚启动时已有连接临近过期」的场景
  sweepOnce();
}

/** 停止扫描（幂等；测试与 app 退出时调用） */
export function stopOAuthLifecycle(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}
