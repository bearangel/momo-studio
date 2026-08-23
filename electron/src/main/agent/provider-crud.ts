// electron/src/main/agent/provider-crud.ts
//
// 全局模型供应商注册表的持久化层。
// 元数据存 SQLite（model_providers 表），apiKey 只存 keychain（不落 DB 明文）。
// is_default 全局唯一：setDefaultProvider 把其他行置 0。
// 本模块是 agent 创建表单的"快捷填充器"——保存 agent 时 baseUrl+apiKey 被 COPY
// 进 agent 定义/实例，删供应商不影响已存在的 agent（详见 v1.1 设计 2.4）。

import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { setSecret, getSecret, deleteSecret } from '../storage/keychain';
export interface ModelProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key_ref: string;
  default_model: string | null;
  is_default: number;
  created_at: string;
  platform: string;
}

export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string | null;
  isDefault: boolean;
  createdAt: string;
  /** LLM 协议平台（v24 起显式存储，取代 baseUrl 启发式检测） */
  platform: ProviderPlatform;
}

/** 供应商协议平台：决定请求体/鉴权头/流式解析格式 */
export type ProviderPlatform = 'openai' | 'anthropic';

export interface ProviderModelRow {
  provider_id: string;
  model_id: string;
  enabled: number;
  added_at: number;
}

/** 供应商的模型列表条目（provider_models 表，v24 起） */
export interface ProviderModel {
  providerId: string;
  modelId: string;
  enabled: boolean;
  addedAt: number;
}

/** keychain 引用 key：provider.<id>.api_key */
export function providerApiKeyRef(id: string): string {
  return `provider.${id}.api_key`;
}

function rowToProvider(row: ModelProviderRow): ModelProvider {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    defaultModel: row.default_model,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    platform: row.platform === 'anthropic' ? 'anthropic' : 'openai',
  };
}

function rowToProviderModel(row: ProviderModelRow): ProviderModel {
  return {
    providerId: row.provider_id,
    modelId: row.model_id,
    enabled: row.enabled === 1,
    addedAt: row.added_at,
  };
}

export function listProviders(): ModelProvider[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM model_providers ORDER BY created_at ASC').all() as ModelProviderRow[];
  return rows.map(rowToProvider);
}

export function getProvider(id: string): ModelProvider | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM model_providers WHERE id = ?').get(id) as ModelProviderRow | undefined;
  return row ? rowToProvider(row) : null;
}

/** 从 keychain 读 apiKey（仅供 IPC testConnection / agent 表单填充用，不随 list 返回） */
export async function getProviderApiKey(id: string): Promise<string | null> {
  return getSecret(providerApiKeyRef(id));
}

export async function createProvider(input: {
  name: string; baseUrl: string; apiKey: string;
  defaultModel?: string; isDefault?: boolean; platform?: ProviderPlatform;
}): Promise<ModelProvider> {
  const id = randomUUID();
  const apiKeyRef = providerApiKeyRef(id);
  const db = getDb();
  db.prepare(
    `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default, platform)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.name, input.baseUrl, apiKeyRef,
    input.defaultModel ?? null, input.isDefault ? 1 : 0,
    input.platform ?? 'openai',
  );
  // keychain 写入与 DB 无法跨存储原子化：失败时回滚 DB 行，避免留下无密钥的孤儿供应商
  try {
    await setSecret(apiKeyRef, input.apiKey);
  } catch (err) {
    db.prepare('DELETE FROM model_providers WHERE id = ?').run(id);
    throw err;
  }
  if (input.isDefault) setDefaultProvider(id);
  logger.info('供应商已创建', { id, name: input.name });
  return getProvider(id)!;
}

export async function updateProvider(input: {
  id: string; name?: string; baseUrl?: string; apiKey?: string;
  defaultModel?: string; isDefault?: boolean; platform?: ProviderPlatform;
}): Promise<ModelProvider> {
  const existing = getProvider(input.id);
  if (!existing) throw new Error(`供应商不存在: ${input.id}`);
  const db = getDb();
  db.prepare(
    `UPDATE model_providers SET
       name = ?, base_url = ?, default_model = ?, is_default = ?, platform = ?
     WHERE id = ?`,
  ).run(
    input.name ?? existing.name,
    input.baseUrl ?? existing.baseUrl,
    input.defaultModel !== undefined ? (input.defaultModel ?? null) : existing.defaultModel,
    (input.isDefault ?? existing.isDefault) ? 1 : 0,
    input.platform ?? existing.platform,
    input.id,
  );
  // apiKey 非空才更新 keychain（允许只改名字不改密钥）
  if (input.apiKey) {
    await setSecret(providerApiKeyRef(input.id), input.apiKey);
  }
  if (input.isDefault) setDefaultProvider(input.id);
  return getProvider(input.id)!;
}

export async function deleteProvider(id: string): Promise<void> {
  const db = getDb();
  db.prepare('DELETE FROM model_providers WHERE id = ?').run(id);
  await deleteSecret(providerApiKeyRef(id));
  logger.info('供应商已删除', { id });
}

/** 排他置默认：目标行 = 1，其余 = 0 */
export function setDefaultProvider(id: string): void {
  const db = getDb();
  db.prepare('UPDATE model_providers SET is_default = (id = ?)').run(id);
}

// ─── provider_models CRUD（v24 起）──────────────────────────────────────────

/** 列出某供应商的模型列表（按加入时间升序） */
export function listProviderModels(providerId: string): ProviderModel[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM provider_models WHERE provider_id = ? ORDER BY added_at ASC')
    .all(providerId) as ProviderModelRow[];
  return rows.map(rowToProviderModel);
}

/**
 * 添加模型到供应商列表（幂等）。INSERT OR IGNORE：已存在时不动既有行
 * （enabled 等字段保持原值），enabled 仅对新插入生效（默认 true）。
 */
export function upsertProviderModel(providerId: string, modelId: string, enabled?: boolean): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO provider_models (provider_id, model_id, enabled, added_at)
     VALUES (?, ?, ?, ?)`,
  ).run(providerId, modelId, enabled === false ? 0 : 1, Date.now());
}

export function setProviderModelEnabled(providerId: string, modelId: string, enabled: boolean): void {
  const db = getDb();
  db.prepare(
    'UPDATE provider_models SET enabled = ? WHERE provider_id = ? AND model_id = ?',
  ).run(enabled ? 1 : 0, providerId, modelId);
}

export function removeProviderModel(providerId: string, modelId: string): void {
  const db = getDb();
  db.prepare(
    'DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?',
  ).run(providerId, modelId);
}

// ─── 远端模型列表拉取（Task 6）───────────────────────────────────────────────

/** 本机回环域名（允许 http，如本地 Ollama）。与 provider-ipc.ts testConnection 的校验互为镜像 */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}

/**
 * 从供应商 API 拉取可用模型列表：GET {baseUrl}/models（OpenAI 兼容格式），
 * Bearer key 取自 keychain。返回 data[].id 字符串数组。
 * 失败（网络 / 非 2xx / 非 JSON / 形状不符 / ghost provider）一律抛错，
 * 由 IPC 层转成 renderer 可见的 error。
 */
export async function fetchRemoteModels(providerId: string): Promise<string[]> {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`供应商不存在: ${providerId}`);
  const apiKey = await getProviderApiKey(providerId);

  // SSRF/传输安全校验：镜像 testConnection——http 仅允许本机回环，非本机必须 https
  let parsed: URL;
  try {
    parsed = new URL(provider.baseUrl);
  } catch {
    throw new Error('baseUrl 格式无效');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('仅支持 http/https 协议');
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    throw new Error('非本机地址必须使用 https（防止凭据被截获）');
  }

  const base = provider.baseUrl.replace(/\/$/, '');
  const resp = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${apiKey ?? ''}` },
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    throw new Error(`响应不是有效 JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error('响应格式不符合 /models 约定（缺少 data 数组）');
  }
  const ids: string[] = [];
  for (const item of data) {
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('响应格式不符合 /models 约定（data 条目缺少字符串 id）');
    }
    ids.push(id);
  }
  return ids;
}
