// electron/src/main/storage/migrations/079_oauth_module.ts
// 公共 OAuth 模块（spec 2026-11-10）：oauth_connections 元数据表 + mcp_definitions
// 两列绑定。密文不落本表（access/refresh/client_secret 全走 keychain 门面）。
//
// forward-only：本文件一次写定；撤销连接保留行（status='revoked'），物理删除
// 需应用层确认无 MCP 引用后再执行。
//
// 建表/索引全部 IF NOT EXISTS，新库重复执行安全；两列 ALTER 由 schema_migrations
// 版本记账保证每个库只跑一次（SQLite ADD COLUMN 无 IF NOT EXISTS）。
import type { Migration } from './index';

export const migration079: Migration = {
  version: 79,
  sql: `
-- OAuth 连接元数据（撤销保留行；物理删除需无引用）
CREATE TABLE IF NOT EXISTS oauth_connections (
  id                     TEXT PRIMARY KEY NOT NULL,
  provider_key           TEXT NOT NULL,
  display_name           TEXT NOT NULL,
  account_label          TEXT NOT NULL DEFAULT '',
  issuer                 TEXT,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint         TEXT NOT NULL,
  registration_endpoint  TEXT,
  revocation_endpoint    TEXT,
  userinfo_endpoint      TEXT,
  client_id              TEXT NOT NULL,
  client_auth_method     TEXT NOT NULL DEFAULT 'none',
  scopes                 TEXT NOT NULL DEFAULT '',
  resource               TEXT,
  extra_authorize_params TEXT NOT NULL DEFAULT '{}',
  extra_token_params     TEXT NOT NULL DEFAULT '{}',
  redirect_host          TEXT NOT NULL DEFAULT '127.0.0.1',
  redirect_port          INTEGER,
  allow_insecure_tls     INTEGER NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'connected',
  expires_at             TEXT,
  last_refreshed_at      TEXT,
  source                 TEXT NOT NULL DEFAULT 'manual',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_connections_provider ON oauth_connections(provider_key);

-- MCP 绑定（空 = 不走 OAuth，存量行零行为变化）
ALTER TABLE mcp_definitions ADD COLUMN oauth_connection_id TEXT;
ALTER TABLE mcp_definitions ADD COLUMN oauth_env_var TEXT;
`,
};
