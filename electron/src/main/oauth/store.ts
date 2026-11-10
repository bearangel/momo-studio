// electron/src/main/oauth/store.ts
//
// oauth_connections CRUD（spec §6.2）。元数据进 SQLite，密文走 keychain（keys.ts）。
// 时间戳统一 ISO 字符串；过期判定用 Date.parse（null expires_at = 不过期）。
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { clearTokenSet } from './keys';
import type {
  OAuthConnection,
  OAuthConnectionInsert,
  OAuthConnectionStatus,
  ClientAuthMethod,
  OAuthConnectionSource,
} from './types';

/** 行形状与迁移 079 的列一一对应（snake_case） */
interface Row {
  id: string;
  provider_key: string;
  display_name: string;
  account_label: string;
  issuer: string | null;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string | null;
  revocation_endpoint: string | null;
  userinfo_endpoint: string | null;
  client_id: string;
  client_auth_method: string;
  scopes: string;
  resource: string | null;
  extra_authorize_params: string;
  extra_token_params: string;
  redirect_host: string;
  redirect_port: number | null;
  allow_insecure_tls: number;
  status: string;
  expires_at: string | null;
  last_refreshed_at: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  'id, provider_key, display_name, account_label, issuer, authorization_endpoint, token_endpoint, ' +
  'registration_endpoint, revocation_endpoint, userinfo_endpoint, client_id, client_auth_method, ' +
  'scopes, resource, extra_authorize_params, extra_token_params, redirect_host, redirect_port, ' +
  'allow_insecure_tls, status, expires_at, last_refreshed_at, source, created_at, updated_at';

const PLACEHOLDERS = COLUMNS.split(',').map(() => '?').join(', ');

/** JSON 列解析：非对象/非法 JSON 一律退化为空记录（错误路径不吞状态，仅降级） */
function parseRecord(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function rowToConnection(row: Row): OAuthConnection {
  return {
    id: row.id,
    providerKey: row.provider_key,
    displayName: row.display_name,
    accountLabel: row.account_label,
    issuer: row.issuer,
    authorizationEndpoint: row.authorization_endpoint,
    tokenEndpoint: row.token_endpoint,
    registrationEndpoint: row.registration_endpoint,
    revocationEndpoint: row.revocation_endpoint,
    userinfoEndpoint: row.userinfo_endpoint,
    clientId: row.client_id,
    clientAuthMethod: row.client_auth_method as ClientAuthMethod,
    scopes: row.scopes,
    resource: row.resource,
    extraAuthorizeParams: parseRecord(row.extra_authorize_params),
    extraTokenParams: parseRecord(row.extra_token_params),
    redirectHost: row.redirect_host,
    redirectPort: row.redirect_port,
    allowInsecureTls: row.allow_insecure_tls !== 0,
    status: row.status as OAuthConnectionStatus,
    expiresAt: row.expires_at,
    lastRefreshedAt: row.last_refreshed_at,
    source: row.source as OAuthConnectionSource,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertConnection(input: OAuthConnectionInsert): OAuthConnection {
  const now = new Date().toISOString();
  const row: Row = {
    id: randomUUID(),
    provider_key: input.providerKey,
    display_name: input.displayName,
    account_label: input.accountLabel ?? '',
    issuer: input.issuer ?? null,
    authorization_endpoint: input.authorizationEndpoint,
    token_endpoint: input.tokenEndpoint,
    registration_endpoint: input.registrationEndpoint ?? null,
    revocation_endpoint: input.revocationEndpoint ?? null,
    userinfo_endpoint: input.userinfoEndpoint ?? null,
    client_id: input.clientId,
    client_auth_method: input.clientAuthMethod ?? 'none',
    scopes: input.scopes ?? '',
    resource: input.resource ?? null,
    extra_authorize_params: JSON.stringify(input.extraAuthorizeParams ?? {}),
    extra_token_params: JSON.stringify(input.extraTokenParams ?? {}),
    redirect_host: input.redirectHost ?? '127.0.0.1',
    redirect_port: input.redirectPort ?? null,
    allow_insecure_tls: input.allowInsecureTls ? 1 : 0,
    status: input.status ?? 'connected',
    expires_at: input.expiresAt ?? null,
    last_refreshed_at: null,
    source: input.source ?? 'manual',
    created_at: now,
    updated_at: now,
  };
  getDb()
    .prepare(`INSERT INTO oauth_connections (${COLUMNS}) VALUES (${PLACEHOLDERS})`)
    .run(
      row.id,
      row.provider_key,
      row.display_name,
      row.account_label,
      row.issuer,
      row.authorization_endpoint,
      row.token_endpoint,
      row.registration_endpoint,
      row.revocation_endpoint,
      row.userinfo_endpoint,
      row.client_id,
      row.client_auth_method,
      row.scopes,
      row.resource,
      row.extra_authorize_params,
      row.extra_token_params,
      row.redirect_host,
      row.redirect_port,
      row.allow_insecure_tls,
      row.status,
      row.expires_at,
      row.last_refreshed_at,
      row.source,
      row.created_at,
      row.updated_at
    );
  return rowToConnection(row);
}

export function getConnection(id: string): OAuthConnection | null {
  const row = getDb()
    .prepare(`SELECT ${COLUMNS} FROM oauth_connections WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? rowToConnection(row) : null;
}

// 排序用 rowid 而非 id：created_at 同毫秒并列时 UUIDv4 的 id 序是随机的，
// rowid 单调递增才给出真实插入序（本表是普通 rowid 表，id 为 TEXT 主键）。
export function listConnections(): OAuthConnection[] {
  const rows = getDb()
    .prepare(`SELECT ${COLUMNS} FROM oauth_connections ORDER BY created_at DESC, rowid DESC`)
    .all() as Row[];
  return rows.map(rowToConnection);
}

/** 复用检查：同 provider_key、connected、未过期（null expires_at 视为不过期） */
export function findReusable(providerKey: string): OAuthConnection | null {
  const row = getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM oauth_connections
       WHERE provider_key = ? AND status = 'connected'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(providerKey) as Row | undefined;
  if (!row) return null;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;
  return rowToConnection(row);
}

/** 可更新列白名单（属性名 → 列名）；未知键一律忽略 */
const PATCHABLE = {
  status: 'status',
  expiresAt: 'expires_at',
  lastRefreshedAt: 'last_refreshed_at',
  accountLabel: 'account_label',
  clientId: 'client_id',
  registrationEndpoint: 'registration_endpoint',
  revocationEndpoint: 'revocation_endpoint',
  userinfoEndpoint: 'userinfo_endpoint',
  clientAuthMethod: 'client_auth_method',
} as const;

type Patch = Partial<
  Pick<
    OAuthConnection,
    | 'status'
    | 'expiresAt'
    | 'lastRefreshedAt'
    | 'accountLabel'
    | 'clientId'
    | 'registrationEndpoint'
    | 'revocationEndpoint'
    | 'userinfoEndpoint'
    | 'clientAuthMethod'
  >
>;

export function updateConnection(id: string, patch: Patch): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(PATCHABLE)) {
    const value = patch[key as keyof Patch];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(value);
  }
  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  getDb()
    .prepare(`UPDATE oauth_connections SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);
}

/** 物理删除（调用前必须已确认无引用——service.removeConnection 负责阻断） */
export function deleteConnection(id: string): void {
  getDb().prepare('DELETE FROM oauth_connections WHERE id = ?').run(id);
  // 跨存储无法原子：先删行再清密钥，失败只留孤儿密钥（无害）——但不静默吞掉
  void clearTokenSet(id).catch((err: unknown) => {
    logger.warn('清理 OAuth 连接密钥失败，可能残留孤儿密钥', { connectionId: id, err });
  });
}
