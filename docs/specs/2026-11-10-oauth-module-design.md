# 公共 OAuth 模块设计（OAuth 2.1 授权码 + PKCE / 多消费者）

- 日期：2026-11-10
- 状态：待评审（brainstorming 已完成五节设计 + 五条修订，逐项确认）
- 类型：宿主基础设施（新主进程服务域 `main/oauth/`，跨模块公共能力）
- 设计依据：`docs/specs/2026-08-23-v2.0.0-platform-refactor-design.md`（服务组织与进程内事件）、`docs/specs/2026-09-23-p2.1-smithery-direct-dxt-mcpb-design.md`（MCP 远程传输与 OAuth 延后记录）、`docs/specs/2026-09-24-p2.4-mcp-quick-create-and-json-import-design.md`（MCP 注册链）、`docs/specs/2026-10-20-node24-electron44-upgrade-design.md`（keytar 保留、safeStorage 明确不做）
- 已与用户确认的决策见 §3

## 1. 背景与目标

MCP 远程服务器中有一大类依赖 OAuth 授权（GitHub、Gmail、Notion、Slack 等官方 MCP，以及企业自建 MCP）。当前平台只能让用户在 `headers_json` 里手工粘贴 Bearer token（明文落 SQLite），既无授权流程，也无刷新、无失效检测、无撤销。Smithery OAuth 服务在 P2.1 被显式列为 P3 候补，邮件插件 spec 也把 OAuth2 标为未来工作——这条能力缺口已影响多个方向。

本设计引入**公共 OAuth 模块**：主进程内的通用 OAuth 2.1 授权码 + PKCE 客户端内核，配适配器层，向内核模块（首先 MCP）与插件提供统一凭据能力。它不绑定任何单一消费者——MCP 只是第一个适配器。

**成功标准**

1. 用户在 MCP 配置里点一次「授权」→ 系统浏览器完成登录 → 回到 App 该服务器已连接、工具可调用；
2. Token 只存 keychain（不落明文 SQLite），过期自动刷新，刷新后相关 MCP 连接自动重建；
3. 401 可判别，未绑定连接时给出「去授权」明确入口（微触发），不自动弹浏览器；
4. 同一 provider 可绑定多账号；同一连接可被多个 MCP 引用；
5. 第三方工具接入只需实现一个适配器（或直接调用 service 的 `resolveAuthMaterial`）；
6. 本地研发可用 `http://127.0.0.1` 端点与固定回调端口跑通完整流程。

## 2. 非目标

- `client_credentials` / `device_code` 授权类型（内核按策略分层，后续新增不重构）；
- 插件**发起**授权（本轮仅给插件只读 token 能力）；
- 存量 `mcp_definitions.headers_json` / `env` 中明文凭据的迁移；
- 泛化为「凭据代理」（API key / client 凭证 / token 统一模型）——等第三个消费者出现再抽象；
- 多账号的完整管理 UI（schema 支持多条，UI 首期只做单账号创建）；
- Token 导出 / 备份 / 跨设备同步；
- 非回环（非 loopback）主机上的 `http://` 端点支持。

## 3. 需求决策记录（用户逐项确认）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 能力边界 | **通用协议内核 + 适配层**。内核只做标准 OAuth2/OIDC；MCP 按其规范提供适配策略（资源元数据 + DCR + resource 参数）；第三方工具走手动 client 配置 |
| D2 | 消费方与信任边界 | **内核模块 + 插件扩展点**。内核模块进程内直接调用；插件走 `ctx.oauth`（只读），token 跨进程传递需明确文档标注信任级别 |
| D3 | 连接归属 | **全局多连接，按 `connectionId` 引用**。同一 provider 可绑多账号；UI 首期只做单账号创建，schema 预留多条 |
| D4 | 授权类型 | **仅授权码 + PKCE（S256）**，含 `refresh_token` |
| D5 | 本轮交付范围 | **内核 + MCP 端到端**（含 UI、401 微触发、刷新后重建连接池） |
| D6 | 架构路线 | **方案 A + B 的微触发**：显式连接 + 适配器注册表；未绑定时给「去授权」入口而非自动弹浏览器；点「授权」一次性完成「建连接 + 授权 + 绑定 + 重连」 |
| D7 | 本地研发的 http | **默认允许 loopback http**（`https` 任意 + `http` 仅 loopback），与既有 `isAllowedRemoteUrl` / `isLoopbackHost` 口径一致，零开关 |

## 4. 现状事实锚（探查结论）

| 事实 | 位置 | 对本设计的影响 |
|---|---|---|
| MCP 为手写 JSON-RPC，无 `@modelcontextprotocol/sdk` | `mcp/client.ts` / `mcp/http-client.ts` | 无法借 SDK 自带 OAuth，协议须自实现 |
| 仅 `stdio` 与 `streamable_http` 两态，SSE 传输明确不支持 | `mcp/types.ts`、`renderer/src/lib/mcp-json.ts` | 适配器只需覆盖两态 |
| `headers` 全链路贯通到 `fetch` 展开点 | `mcp/http-client.ts:206` `...this.config.headers` | HTTP 注入点现成 |
| `env` 经白名单 + 覆盖进入 spawn | `mcp/client.ts` `buildMcpEnv` | stdio 注入点现成 |
| 建连唯一漏斗 | `mcp/host-manager.ts` `getOrStartMcp` | 注入与 401 处理集中在此 |
| 池键为 `${workspaceId}:${mcpName}`，支持 `evictMcpByName` | `mcp/host-manager.ts` | 刷新后需按连接**扇出**驱逐 |
| `headers_json` / `env` 明文落 SQLite | `mcp/host-manager.ts:371,410` | 新模块禁止照抄此反例 |
| 全仓唯一凭据咽喉 | `storage/keychain.ts`（keytar；`setSecret/getSecret/deleteSecret/findSecretKeysByPrefix`） | Token 存储落点已定，无 `has` |
| `safeStorage` 全仓零使用，且被明确列为「不做」 | `2026-10-20-node24-electron44-upgrade-design.md:20` | 不引入第二凭据平面 |
| 生产代码零 HTTP 服务器、零深链接 | `electron/src` grep | 回调须自建回环服务器；深链接不做 |
| `misc:openExternal` 只放行 `https://` | `resource/ipc.handlers.ts:485` | 本地授权页打不开，必须扩口径 |
| `isAllowedRemoteUrl` 已放行 http | `mcp/host-manager.ts:338` | 与 OAuth 口径对齐，消除双标准 |
| `McpConfigDialog` 仍只允许 https | `McpConfigDialog.tsx:90` | 既有不一致 bug，顺带修 |
| `isLoopbackHost` 有两份重复实现 | `provider-crud.ts:395` / `provider-ipc.ts:27` | 抽公共函数，避免第三份 |
| 401 只抛字符串错误 | `http-client.ts:95-98,110-113` | 必须引入结构化错误 |
| 服务组织 = 按域目录 + `ipc.handlers.ts` + 集中注册 + 模块级单例/setter 注入 | `main/` 结构、`ipc/index.ts` | 新模块形态已定 |

## 5. 总体架构

```
                           ┌──────────────── main/oauth/ ────────────────┐
消费方                      │ protocol/        lifecycle/        store/     │
┌───────────────────┐      │  endpoint-guard   refresh 调度      oauth_     │     外部
│ MCP 适配器         │      │  discovery        single-flight    connections│
│ (getOrStartMcp)   │─────▶│  registration     token 轮换        (SQLite)   │────▶ AS / IdP
├───────────────────┤      │  pkce            失败分类                     │     (系统浏览器)
│ 插件 ctx.oauth    │─────▶│  authorize       revoke                       │
│ (只读 token)      │      │  token                                        │
└───────────────────┘      │  loopback-server  ── service.ts (编排)        │
                           │  adapters/        ── ipc.handlers.ts (thin)   │
                           └───────────────────────┬──────────────────────┘
                                                   │ keychain（唯一咽喉）
                                                   ▼
                                            macOS Keychain / libsecret / CredMan
```

**分层原则**

- `protocol/` 只懂标准协议，不懂任何消费者；
- `service.ts` 是唯一编排层，导出模块级函数（对齐 `compaction/service.ts` 风格）；
- `adapters/` 把消费者翻译成 `AuthRequirement` / `AuthMaterial` / 失败分类；
- `ipc.handlers.ts` 是 thin adapter，零业务逻辑；
- Token 永不出主进程（插件只读通道除外）。

## 6. 域模型与数据落点

### 6.1 核心概念

| 概念 | 含义 | 载体 |
|---|---|---|
| `OAuthConnection` | 一条已授权连接（provider × 账号 × scope × audience） | `oauth_connections` 行 + keychain 密钥 |
| `AuthRequirement` | 某目标需要的授权条件（端点、client 注册方式、scope、resource） | 适配器产出，流程中间产物 |
| `AuthMaterial` | 消费方可用的认证材料（headers / env），内核保证不泄露额外信息 | 内核返回 |
| `AuthAdapter` | 把「某类目标」翻译成 requirement / material / 失败分类 | 注册表，MCP 首个 |
| `PendingAuthorization` | 一次进行中的授权流程 | 内存（不持久化，10 分钟 TTL） |

### 6.2 表 `oauth_connections`（migration 079）

```sql
CREATE TABLE IF NOT EXISTS oauth_connections (
  id                     TEXT PRIMARY KEY NOT NULL,       -- randomUUID
  provider_key           TEXT NOT NULL,                    -- 去重键：identity|client_id|resource|scopes（identity 见 §6.5）
  display_name           TEXT NOT NULL,                    -- GitHub / 内部 IdP
  account_label          TEXT NOT NULL DEFAULT '',         -- 账号标识（userinfo 推导或用户填）
  issuer                 TEXT,                             -- 可空（纯手工端点）
  authorization_endpoint TEXT NOT NULL,
  token_endpoint         TEXT NOT NULL,
  registration_endpoint  TEXT,
  revocation_endpoint    TEXT,
  userinfo_endpoint      TEXT,
  client_id              TEXT NOT NULL,
  client_auth_method     TEXT NOT NULL DEFAULT 'none',     -- none | client_secret_post | client_secret_basic
  scopes                 TEXT NOT NULL DEFAULT '',         -- 空格分隔
  resource               TEXT,                             -- RFC 8707 audience；空=provider 不要求
  extra_authorize_params TEXT NOT NULL DEFAULT '{}',
  extra_token_params     TEXT NOT NULL DEFAULT '{}',
  redirect_host          TEXT NOT NULL DEFAULT '127.0.0.1', -- 127.0.0.1 | localhost
  redirect_port          INTEGER,                          -- 空=随机端口
  allow_insecure_tls     INTEGER NOT NULL DEFAULT 0,       -- 仅 loopback 可置 1
  status                 TEXT NOT NULL DEFAULT 'connected',-- connected | needs_reauth | revoked
  expires_at             TEXT,                             -- ISO；空=不过期
  last_refreshed_at      TEXT,
  source                 TEXT NOT NULL DEFAULT 'manual',   -- manual | mcp | preset
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_connections_provider ON oauth_connections(provider_key);
```

### 6.3 同迁移给 `mcp_definitions` 增列

```sql
ALTER TABLE mcp_definitions ADD COLUMN oauth_connection_id TEXT; -- 空=不走 OAuth
ALTER TABLE mcp_definitions ADD COLUMN oauth_env_var TEXT;       -- stdio 时注入的环境变量名
```

两列均无默认值、可空——存量行行为与今天完全一致（零回归面）。引用关系为逻辑外键（本项目 migrations 不用外键约束）。

### 6.4 密钥（keychain，绝不入 SQLite）

```
oauth.<connectionId>.access_token
oauth.<connectionId>.refresh_token
oauth.<connectionId>.client_secret    // 仅 client_auth_method != 'none'
```

沿用既有命名惯例（`provider.<id>.api_key` / `plugin.<id>.config.<KEY>`），前缀 `oauth.` 便于 `findSecretKeysByPrefix('oauth.')` 做级联清理。

### 6.5 复用规则

`beginAuthorization` 前按 `provider_key` 查已有且 `status='connected'` 且未过期的连接 → 直接复用，不新建。

`provider_key` = `identity|client_id|resource|scopes` 归一化串，其中 `identity = issuer ?? authorization_endpoint 的 origin`（手工端点场景无 issuer，必须退到 origin，否则所有手工连接会撞成同一个 key）：

- **DCR 分支的定型时机**：MCP 走动态客户端注册时，key 在**注册之前**计算（此时 `client_id` 段为空串）。否则每次 DCR 都会产生新的 client_id，同一 MCP 第二次授权永远无法复用。后果是 DCR 连接行的 `client_id` 列有值而 key 中该段为空——刻意如此，非缺陷。

- 多数 provider 不实现 RFC 8707 → `resource` 为空 → 一个 GitHub 登录服务多个 GitHub MCP；
- audience 受限的 AS（如 Google 某些 API）→ `resource` 不同即视为不同连接，各自授权。

## 7. 协议内核

### 7.1 模块清单

| 文件 | 职责 |
|---|---|
| `protocol/endpoint-guard.ts` | `assertEndpointAllowed(url)`：`https` 任意；`http` 仅 `isLoopbackHost`；其余 → `insecure_endpoint` |
| `protocol/discovery.ts` | RFC 9728 资源元数据、RFC 8414 / OIDC 授权服务器发现、401 `WWW-Authenticate` 解析、issuer 一致性校验、内存 TTL 缓存（1h） |
| `protocol/pkce.ts` | `verifier = base64url(randomBytes(32))`；`challenge = base64url(sha256(verifier))`；`state = base64url(randomBytes(16))` |
| `protocol/registration.ts` | RFC 7591 动态客户端注册；`token_endpoint_auth_method` 协商；复用同 `provider_key` 的既有 `client_id` |
| `protocol/authorize.ts` | 拼授权 URL（`response_type=code`、`code_challenge`、`state`、`scope`、`resource`、`extra_authorize_params`） |
| `protocol/token.ts` | `exchangeCode` / `refresh` / `revoke`；`application/x-www-form-urlencoded`；三种 client 认证方式；响应归一（`access_token` / `expires_in` / `refresh_token` / `token_type` / `scope`） |
| `protocol/loopback-server.ts` | `http.createServer`；`listen(port, host)`；路径 `/callback`；一次性；成功/失败 HTML；10 分钟超时；`EADDRINUSE` → `redirect_port_in_use` |
| `lifecycle.ts` | 主动刷新、单飞、轮换持久化、失败分类与退避 |
| `service.ts` | 编排：`beginAuthorization` / `beginAuthorizationForMcp` / `completeAuthorization` / `completeWithManualCallback` / `resolveAuthMaterial` / `listConnections` / `getConnection` / `disconnect` / `removeConnection` |
| `store.ts` | `oauth_connections` CRUD（`storage/*` 同款 repo 风格） |
| `adapters/mcp.ts` | MCP 适配器（见 §9） |
| `ipc.handlers.ts` | `registerOAuthHandlers()`，thin adapter |
| `types.ts` | 全部对外类型与错误码 |

### 7.2 端点与传输细节

- **发现顺序**（MCP）：401 `WWW-Authenticate` 取 `resource_metadata` → 资源元数据 JSON 的 `authorization_servers[]` → 对每个 issuer 依次尝试 `/.well-known/oauth-authorization-server`、`/.well-known/openid-configuration` → 校验 `issuer` 字段与来源 URL 一致；
- **手工端点**：跳过发现，用户直接填 authorization / token 端点；
- **所有端点**（含发现结果）必须过 `assertEndpointAllowed`；
- **请求头**：`Accept: application/json`；token 请求另加 `Content-Type: application/x-www-form-urlencoded`；
- **client 认证**：`none` → body 带 `client_id`；`client_secret_post` → body 带 `client_id` + `client_secret`；`client_secret_basic` → `Authorization: Basic base64(urlencode(id):urlencode(secret))`；
- **TLS 放宽**：`allow_insecure_tls=1` 时该连接的 OAuth 请求走独立 fetch 包装（undici Agent `connect.rejectUnauthorized=false`），**不影响全局、不影响 MCP 自身 fetch**；
- **超时**：单请求 30s；整流程 10 分钟。

## 8. 授权流程

```
renderer: 点「授权」
  → oauth:beginAuthorization({ mcpName } | { presetKey } | { manual })
      1. 适配器产出 AuthRequirement
      2. provider_key 复用检查 → 命中即返回 existing
      3. 起回环服务器（host/port 取连接配置，缺省 127.0.0.1:0）
      4. 需要时 DCR（redirect_uri 用实际端口）
      5. 生成 state + verifier，拼授权 URL
      ← { pendingId, authorizationUrl, redirectUri }
  → renderer 调既有 ipc.misc.openExternal(authorizationUrl)
  → 用户在系统浏览器同意
  → 回环服务器收到 GET /callback?code&state：
       校验 path → 校验 state（不匹配即拒绝并保持服务器）→ 回成功 HTML → 关服务器
       token 交换（code + verifier）→ 写 keychain
       → 尽力拉 userinfo 补 account_label（失败不影响）
       → 落库 status=connected / expires_at
  → push oauth:authorizationChanged { pendingId, status:'connected', connectionId }
  → renderer 关闭等待弹窗，刷新连接列表
```

**失败与超时**：`oauth:authorizationChanged { pendingId, status:'failed', error }`；服务器必关，pending 必清。

**手动回调（同一条 complete 路径）**：`oauth:completeWithManualCallback({ pendingId, input })`，`input` 可为完整回调 URL 或裸 `code`；解析后校验 `state` 再走 token 交换。用于容器/远程开发、防火墙拦截、AS 限制 redirect_uri 等拓扑问题。

**并发**：每个 pending 独立回环服务器与独立 `pendingId`；`pendingId` 一次性消费。

## 9. 适配器契约与 MCP 接入

### 9.1 `AuthAdapter`

```ts
export interface AuthAdapter {
  readonly id: string; // 'mcp' | 'generic-http' | ...
  /** 产出授权条件（可含发现结果） */
  describe(target: unknown): Promise<AuthRequirement>;
  /** 把材料施加到消费方配置上（返回新对象，不改入参） */
  apply(target: unknown, material: AuthMaterial): unknown;
  /** 失败分类：决定是重授权还是普通错误 */
  classifyFailure(target: unknown, failure: unknown): 'needs_reauth' | 'other';
}
```

`AuthMaterial`:

```ts
export interface AuthMaterial {
  /** HTTP 注入：{ Authorization: 'Bearer …' } */
  headers?: Record<string, string>;
  /** stdio 注入：{ GITHUB_TOKEN: '…' }（键名来自 target 配置） */
  env?: Record<string, string>;
  /** 供上层展示/驱逐使用，不含 token */
  expiresAt?: string;
  connectionId: string;
}
```

### 9.2 注入点（`getOrStartMcp`，唯一漏斗）

```ts
let effective = config;
// 既有插件模板展开…
if (effective.oauthConnectionId) {
  const material = await resolveAuthMaterial(effective.oauthConnectionId, {
    adapter: 'mcp',
    target: { url: effective.url, transport: effective.transport, envVar: effective.oauthEnvVar },
  });
  effective = applyAuthMaterial(effective, material);
}
```

合并方向固定 **OAuth 覆盖手填**（`Authorization` / 指定 env 键），避免两套凭据打架。OAuth 绑定后 UI 隐藏手填 `Authorization` 并提示「由连接管理」。

stdio 且 `oauthEnvVar` 为空时**明确报错**（`oauth_env_var_required`），不静默跳过。

### 9.3 401 可判别（现有硬缺口）

```ts
export class McpHttpError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly wwwAuthenticate: string | null,
  ) { super(`远程 MCP ${method} 失败：HTTP ${status}`); }
}
```

`HttpMcpClient.rpc()` / `notify()` 的 `!response.ok` 分支改抛它（消息文案不变，兼容既有断言与 UI 展示）。

### 9.4 微触发三条路径

| 触发点 | 行为 |
|---|---|
| MCP 未绑定 + 401/403 | 解析 `WWW-Authenticate` → 探测资源元数据 → 抛 `{ code:'needs_reauth', oauthAvailable:true, discovered }`；UI 出横幅「此服务器需要授权」+「去授权」 |
| 用户点「去授权」/ 弹窗「授权」 | `oauth:beginAuthorizationForMcp(mcpName)`：发现 → 复用检查 → 回环授权 → 成功后**回写 `oauth_connection_id`** → 驱逐池 → renderer 收到 `connected` 后调用既有 `mcp:start`（当前 workspace）完成重连 |
| 已绑定但 token 失效 | 内核置 `status=needs_reauth` → 抛同一错误码；UI 显示「连接已失效，重新授权」 |

重连不在主进程自动发起：`getOrStartMcp` 需要 `workspaceId`，主进程无从得知用户当前在看哪个 workspace；因此内核只负责「回写绑定 + 驱逐池」，由 renderer 复用既有 `mcp:start` 通道完成重连，避免路由目标用猜测值（违反 `momo-boundary-rules`「路由目标用当前上下文」）。

### 9.5 连接池扇出驱逐

- `lifecycle` 在刷新成功 / 标记失效 / 撤销后调用 `onConnectionChanged(connectionId, kind)`；
- `host-manager` 新增 `evictMcpsByConnection(connectionId)`：查 `mcp_definitions WHERE oauth_connection_id = ?`，对每个 name 在所有已存在的 workspace 池键上驱逐；
- 必须覆盖「同一连接绑定多个 MCP」的扇出——**这是最易漏的回归点**，须有专项测试。

## 10. 本地研发支持

| 能力 | 设计 |
|---|---|
| Scheme 口径 | OAuth 端点与 `misc:openExternal` 统一为「`https` 任意 + `http` 仅 loopback」；非回环 http 一律 `insecure_endpoint` |
| 固定回调端口 | 连接级 `redirect_port`；固定端口 `EADDRINUSE` → `redirect_port_in_use`，**不静默回落随机** |
| 回调主机 | 连接级 `redirect_host`（`127.0.0.1` / `localhost`）——两者对 AS 是不同字符串，精确匹配差异真实存在 |
| 监听约束 | 回环服务器**只 bind `127.0.0.1` 或 `localhost`，绝不 bind `0.0.0.0`** |
| 手动回调 | 授权对话框常驻「无法自动回调？」→ 粘贴完整回调 URL 或 `code` |
| 自签 TLS | 连接级 `allow_insecure_tls`，仅端点 host 为 loopback 时可勾；UI 打「仅本地开发」徽标 |
| 调试面板 | 展示 pending 流程、实际 `redirect_uri`（可复制）、发现到的端点、最近一次脱敏错误（P4，可提前） |
| 一键复制 | 授权对话框展示 `redirect_uri` 并支持复制，便于在本地 AS 注册 |

**安全论证**

1. http 只在 loopback 生效 → token 永不出本机网卡；
2. PKCE 必选 → 授权码被本机进程截获也换不到 token；
3. DCR 每次新建凭据 → 不存在把 `client_secret` 发给陌生 AS 的路径；
4. 非回环 http 一律拒绝（含发现结果）→ 不给「配错了也能跑」的空间；
5. `allow_insecure_tls` 有 host 强约束 + UI 明示，不会被无感知开启。

## 11. 生命周期

| 机制 | 规则 |
|---|---|
| 主动刷新 | 60s 扫一次，`expires_at - now < 5min` 即刷新；启动后先扫一遍 |
| 单飞 | `Map<connectionId, Promise>`——并发消费方只触发一次刷新 |
| 轮换 | 响应带新 `refresh_token` 必须覆盖旧值（RFC 6749 §10.4）；keychain 写失败即整次刷新失败，不留半新半旧 |
| 失败分类 | `invalid_grant` / 400 → `needs_reauth` + 事件，保留行（用户可一键重授权）；网络/5xx → 1m/5m/15m 退避，3 次后同样落 `needs_reauth` |
| 撤销 | 尽力调 `revocation_endpoint`（失败不阻塞）→ 删三个密钥 → 行置 `revoked` → `onConnectionChanged('revoked')`；**绑定关系保留**（MCP 行仍引用该连接，下次启动报 `needs_reauth`，用户可一键重授权） |
| 物理删除 | `removeConnection`：仅当没有任何 `mcp_definitions.oauth_connection_id` 引用时允许；有引用则拒绝并返回 `affectedMcpNames`（对齐既有 `deleteProvider` 的引用阻断语义）。连接默认走「撤销保留」，不做静默删除 |
| 时钟 | 用 `expires_in` 相对时间转本地时间，不用服务端绝对时间 |

## 12. IPC / preload / 插件扩展点

### 12.1 IPC（`oauth:` 命名空间）

```
oauth:listConnections           → ConnectionView[]
oauth:getConnection             (id) → ConnectionView | null
oauth:listPresets               → ProviderPreset[]
oauth:beginAuthorization        ({ mcpName } | { presetKey } | { manual }) → BeginResult
oauth:beginAuthorizationForMcp  (mcpName) → BeginResult
oauth:completeWithManualCallback({ pendingId, input }) → ConnectionView
oauth:cancelAuthorization       (pendingId) → void
oauth:disconnect                (id) → { affectedMcpNames: string[] }
oauth:removeConnection          (id) → { affectedMcpNames: string[] }   // 有引用则拒绝
push  oauth:authorizationChanged  { pendingId, status, connectionId?, error? }
push  oauth:connectionsChanged    { at }
```

- 授权页打开仍走**既有 `misc:openExternal`**，主进程不越权开浏览器；
- `ConnectionView` 只含元数据（id / displayName / accountLabel / status / expiresAt / scopes / source），**永不含 token**；
- 注册位置：`electron/src/main/ipc/index.ts` 的 `registerIpcHandlers()` 中 `registerOAuthHandlers()`，紧邻 `registerProviderHandlers()`。

### 12.2 preload / 类型

- `electron/src/preload/index.ts` 加 `oauth` 命名空间（`invoke` + 两个 `onXxx` 返回退订函数）；
- `renderer/src/ipc/types.d.ts` 加 `OAuthApiSurface` 与 `ApiSurface.oauth`；
- `renderer/src/ipc/client.ts` 的 Proxy 自动覆盖，无需改动；
- 双 workspace typecheck 为硬门禁。

### 12.3 插件扩展点（本轮只读）

```ts
// PluginServiceCtx 新增，注入方式对齐既有 ctx.secrets
oauth: {
  listConnections(): Promise<Array<{
    id: string; displayName: string; accountLabel: string;
    status: 'connected' | 'needs_reauth' | 'revoked'; expiresAt: string | null;
  }>>;
  /** 文档必须标注：token 跨进程暴露，信任级别等价 ctx.secrets */
  getAccessToken(connectionId: string): Promise<string | null>;
}
```

插件**发起**授权需要主进程 UI 协作与新的信任评审，本轮不做。

## 13. UI（融合式，2026-11-10 R6 改版，预览 `.omo/previews/oauth-module-ui-v2.html` 已确认）

> **R6 设计变更（用户裁定）**：取消独立「连接」管理页、三模式「新增连接」对话框与设置导航项。认证全部融合到使用点（对齐 Claude Desktop / opencode 的就地授权体验）。通用性由服务层承载（连接存储/复用/扇出驱逐/预设 API 不变，预设暂无 UI 消费者）；未来第三方工具消费者在**它自己的界面**挂授权入口。

1. **添加 MCP 弹窗内联认证**（`RegisterMcpDialog`，R8 修订）：新建态**不渲染**认证区块——此时 MCP 尚未注册，区块内「授权」必然失败，展示即误导；「注册并启动」遇 401 → 错误区出「该服务器需要 OAuth 授权」横幅 +「去授权」（此时条目已注册，一步完成授权、绑定与重连），全程不离开弹窗；
2. **MCP 认证区块 = 该服务器的授权管理点**（`McpAuthSection`，`McpConfigDialog` / `RegisterMcpDialog` 共用）：未绑定（授权 + stdio 环境变量名）/ 已绑定（连接名·账号·状态徽标 + 共享提示「此授权也被 N 个服务器使用」+ 撤销授权…）/ 需重新授权三态；「撤销授权」（danger-outline 红描边 + ShieldOff）= 吊销令牌并解除绑定，展示受影响服务器清单后两步确认——**唯一离场动作**（R13：「解除绑定」已移除——独立连接管理页取消后，「保留授权不绑定」只产生 UI 不可见的孤儿连接，无消费面；后端 `unbindMcp` 通道保留，供撤销流程内部使用）。编辑态展示纪律（R11/R12）：**binding 即标记**——`oauth_connection_id` 列本身就是「该 MCP 需要 OAuth」的唯一真相（授权成功自动回写、撤销自动清除，不新增独立布尔列避免双真相漂移）；**已绑定**的编辑态直接展示认证区块，**未绑定**的 http 编辑态零 OAuth 痕迹（主动绑定主路径 = 提交后 401 横幅），stdio 的入口保留在「高级：环境变量与工作目录」内（无 401 触发器，不可堵死）；编辑态传输类型**隐藏切换器**、以只读形态说明展示（切换会以另一形态做全字段 UPDATE，属数据破坏面）；
3. **授权等待对话框**（`AuthorizeDialog`，所有入口共用）：显示 `redirect_uri` + 复制、「无法自动回调？」手动粘贴入口、取消；
4. **需授权横幅**：注册/启动失败返回 `needs_reauth` 时的统一提示 +「去授权」；文案「该服务器需要 OAuth 授权」（不带状态码噪音），横幅**替代**原始错误红字（同屏重复即误导，R9）；
5. **MCP 详情入口矩阵（R9）**：custom 源 MCP 只显示「编辑」（含全部配置内容 + 认证区块）；非 custom 源（smithery/hub）远程 MCP 只显示「配置」（其唯一配置途径）——不再双入口并存。

状态色一律走 `lib/task-status.ts`；图标用 lucide（16px / stroke 1.75）；只用语义 token，禁标准 Tailwind 色阶与 inline 硬编码颜色。

## 14. 安全设计

**不变量**

1. Token 永不写入 SQLite / JSON / 日志 / 错误详情；
2. Token 永不出主进程（插件只读通道为唯一例外，且有明确文档与信任级别说明）；
3. OAuth 端点校验统一过 `assertEndpointAllowed`，**含发现结果**；
4. 回环服务器只绑 loopback 地址；
5. PKCE + `state` 必选，缺一即拒绝；
6. `Authorization` 与 token 形态统一过 `util/redact.ts` 脱敏。

**既有安全缺口的处置**

- `mcp_definitions.headers_json` / `env` 明文：本轮**不迁移**（见 §17），但新写入路径禁止再放 OAuth token；
- `provider:getApiKey` 把明文 key 送 renderer：与本设计无关，登记为已知缺口，不在本轮修。

## 15. 错误码

```ts
export type OAuthErrorCode =
  | 'needs_reauth'             // token 失效，需重新授权
  | 'authorization_pending'    // 流程进行中
  | 'authorization_cancelled'  // 用户取消
  | 'authorization_timeout'    // 10 分钟超时
  | 'discovery_failed'         // 元数据/AS 发现失败
  | 'registration_failed'      // DCR 失败（需手工 client_id）
  | 'token_exchange_failed'
  | 'refresh_failed'
  | 'no_connection'            // 引用不存在的连接
  | 'insecure_endpoint'        // 非 loopback http / 非法 scheme
  | 'redirect_port_in_use'     // 固定回调端口被占用
  | 'keychain_unavailable'     // 系统密钥环不可用（Linux 无 Secret Service）
  | 'oauth_env_var_required';  // stdio 绑定 OAuth 但未指定注入变量名
```

所有跨 IPC 错误携带 `{ code, message, connectionId?, detail? }`，`detail` 只放脱敏后的服务端错误码。

## 16. 测试策略（按 `momo-test-rules`）

| 层 | 用例 |
|---|---|
| 协议单测 | PKCE 向量、发现解析（含 issuer 不一致拒绝）、DCR 请求体、token 响应归一、三种 client 认证方式、端点守卫（https / loopback http / 非回环 http） |
| 回环服务器 | **真实 `http.createServer` + 真实 socket 回调**（不 mock 服务器）；state 不匹配拒绝；路径不符拒绝；超时关闭；固定端口冲突报 `redirect_port_in_use`；手动回调路径等价 |
| 生命周期 | 单飞（并发 3 次只发 1 个刷新请求）、轮换落库、`invalid_grant` → `needs_reauth`、退避重试上限 |
| 存储 | migration 079 建表与增列；keychain 键名与作用域服务名断言（`setKeychainImpl` 注入内存实现）；`removeConnection` 有引用时拒绝并返回 `affectedMcpNames` |
| 适配器 | `apply` 不改入参；http → headers；stdio → env（缺失变量名报错）；401 分类 |
| MCP 集成 | 401 未绑定 → `needs_reauth` + `oauthAvailable`；已绑定失效 → 同错误码；刷新 → **扇出驱逐多个同名池实例** |
| 契约 | `oauth:*` 通道在 main / preload / `types.d.ts` 三处一致（照 `tests/ipc/preload-*-channel-contract.test.ts` 机械比对） |
| App 级验收 | 真实连一个 OAuth 保护的远程 MCP：授权 → 工具可调用 → 重启免登录 → 断开失效；本地研发场景：`http://127.0.0.1` MCP + 本地 AS + 固定端口 + 手动回调 |

DB 重度目录跑测试须显式 `--pool=forks`（AGENTS.md 既定）。

## 17. 分期

| 期 | 交付 |
|---|---|
| **P1 内核** | migration 079 + `store` + keychain 键族 + protocol 六模块 + `loopback-server`（含固定 host/port 与手动回调）+ `service` + 单测 |
| **P2 生命周期与 IPC/UI** | `lifecycle`（主动刷新/单飞/轮换/失败分类/事件）+ IPC + preload + 类型 + 设置页连接管理 + 授权等待对话框（复制 `redirect_uri`、手动粘贴） |
| **P3 MCP 接入** | 列映射 + `getOrStartMcp` 注入 + `McpHttpError` + 微触发 + 扇出驱逐 + MCP 弹窗认证区块 + 授权横幅 + `McpConfigDialog` 口径修正 |
| **P4 收尾** | 插件 `ctx.oauth` + OAuth 调试面板 + 文档 + App 级验收 |

**版本号纪律**：本特性 commit 一律不动 `package.json` 版本号（AGENTS.md）。

## 18. 风险

| 风险 | 应对 |
|---|---|
| Linux 无 Secret Service 时 keytar 抛错 | 归一到 `keychain_unavailable`，UI 明确提示；不做「内存凭据假安全」降级 |
| 大量 AS 不支持 DCR | 手工 `client_id` 是一等路径，预设只含端点与默认 scope，不含密钥 |
| 发现结果被恶意 MCP 引向明文 AS | `assertEndpointAllowed` 作用于发现结果；非回环 http 直接拒绝 |
| 多授权流程并发 | 每流程独立回环服务器 + 独立 `pendingId`，一次性消费 |
| 时钟偏差 | `expires_in` → 本地时间，提前 5 分钟刷新 |
| token 泄漏进日志 | 全量 `redact`；`detail` 只放脱敏错误码；补断言测试 |
| 固定回调端口冲突 | 明确报错不回落，避免 redirect_uri 与注册值不一致的诡异失败 |

## 19. 未来工作

- `client_credentials` / `device_code` 策略；
- 插件发起授权（写路径）；
- 存量明文 `headers_json` / `env` 凭据迁移（含重连与回滚）；
- 泛化为「凭据代理」（API key / client 凭证 / token 统一模型）；
- 内置 mock 授权服务器（OAuth 内核自测台）；
- 多账号完整管理 UI；
- 设备码 / 无浏览器环境支持。
