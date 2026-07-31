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
}

export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string | null;
  isDefault: boolean;
  createdAt: string;
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
  defaultModel?: string; isDefault?: boolean;
}): Promise<ModelProvider> {
  const id = randomUUID();
  const apiKeyRef = providerApiKeyRef(id);
  const db = getDb();
  db.prepare(
    `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.name, input.baseUrl, apiKeyRef,
    input.defaultModel ?? null, input.isDefault ? 1 : 0,
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
  defaultModel?: string; isDefault?: boolean;
}): Promise<ModelProvider> {
  const existing = getProvider(input.id);
  if (!existing) throw new Error(`供应商不存在: ${input.id}`);
  const db = getDb();
  db.prepare(
    `UPDATE model_providers SET
       name = ?, base_url = ?, default_model = ?, is_default = ?
     WHERE id = ?`,
  ).run(
    input.name ?? existing.name,
    input.baseUrl ?? existing.baseUrl,
    input.defaultModel !== undefined ? (input.defaultModel ?? null) : existing.defaultModel,
    (input.isDefault ?? existing.isDefault) ? 1 : 0,
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
