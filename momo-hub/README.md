# momo-hub

Momo Studio 互联网模式的中转服务器。

## 职责

- 节点连接认证（authToken）
- 维护在线节点列表（presence）
- 按 nodeId 路由消息（routing）
- 离线消息临时缓存（TTL 7 天）

**不持久化用户数据；hub 看到的所有 payload 都是 E2E 加密密文。**

## 协议

| 类型 | 方向 | 用途 |
|---|---|---|
| `hello` | 客户端 → hub | 注册节点（带 `authToken` + `nodeId` + `boxPublicKey` + `displayName`） |
| `presence` | hub → 客户端 | 推送当前在线节点列表 |
| `send` | 客户端 → hub | 发送消息给 `to`（带 `messageId` + `ciphertext` + `nonce`） |
| `deliver` | hub → 客户端 | 投递来自 `from` 的密文消息 |
| `ack` | hub → 客户端 | 消息投递确认（`messageId` + `delivered: boolean`） |
| `error` | hub → 客户端 | 错误通知（如 auth 失败 / 速率限制） |

## 部署

### 公共服务

官方公共服务：`wss://hub.momostudio.io`（即将上线）

### 自建

```bash
git clone https://github.com/yourname/momo-studio
cd momo-studio/momo-hub
npm install
npm run build
HUB_PORT=8080 HUB_TOKENS=token1,token2 node dist/server.js
```

或用 Docker：

```bash
docker build -t momo-hub .
docker run -p 8080:8080 -e HUB_TOKENS=token1 momo-hub
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HUB_PORT` | `8080` | WebSocket 监听端口 |
| `HUB_TOKENS` | （空） | 逗号分隔的有效 token 列表；空 = 开发模式（允许所有） |

## 速率限制

每个 IP 60 秒内最多 100 条消息。超出后返回 `error: rate limited`。

## 隐私

- hub 不持久化用户数据
- 所有 payload 是 E2E 加密密文
- 离线消息临时缓存 7 天后自动删除
- hub 仅看到 nodeId（公钥指纹）+ ciphertext

## 协议扩展（v2 计划）

- 用户注册 + JWT 替代静态 token
- 离线消息持久化层（Redis 或 SQLite）
- 房间广播（多节点订阅同一频道）
- TLS 终结（建议前置 nginx / caddy）