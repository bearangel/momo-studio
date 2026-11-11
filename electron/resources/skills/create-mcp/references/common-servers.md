# 常见 MCP server 配置速查 + 排查表

接入流程见 SKILL.md——本页只放配置示例与失败排查。凭证一律从用户处获取，不在回复中回显明文。

## stdio 命令型（npx 风格）

以 context7 为例，完整 `create_mcp` 入参：

```json
{
  "name": "context7",
  "transport": {
    "kind": "stdio",
    "command": "npx",
    "args": ["-y", "@upstash/context7-mcp"],
    "env": {}
  }
}
```

要点：`command` 是本机可执行文件（node/npx/uvx 等），包名与 scope 必须与官方文档一致；需要环境变量时填 `env`（如 `{"API_KEY": "..."}`），凭证值只进配置。

## HTTP 远程型

以 context7 远程端点为例，完整 `create_mcp` 入参：

```json
{
  "name": "context7-remote",
  "transport": {
    "kind": "http",
    "url": "https://mcp.context7.com/mcp",
    "headers": { "CONTEXT7_API_KEY": "<向用户索要>" }
  }
}
```

要点：`url` 必须是 MCP 端点（通常以 `/mcp` 结尾）；需要鉴权时把凭证放 `headers`，key 名以该 server 官方文档为准。

## 三类失败排查表

连通测试（initialize + tools/list）失败时不落库，按报错归类修参数后重试：

| 失败类别 | 典型报错特征 | 常见原因 | 修正建议 |
|---|---|---|---|
| 命令不存在 | spawn ENOENT / command not found | 命令未安装或不在 PATH；包名拼错 | 先确认本机有该命令（如 `npx -v`）；核对包名与 scope 大小写；必要时换绝对路径 |
| 握手超时 | initialize 超时 / no response | 首次运行在下载包；网络或代理不通；url 非端点 | 手动跑一遍命令预热缓存再重试；检查网络与代理设置；核对 url 是否 MCP 端点 |
| 需要 OAuth 授权 | 返回 `needsAuthorization: true` + notice | 远程服务器要求 OAuth（HTTP 401/403 挑战） | 已自动落库；把 notice 原样转告用户（资源库 → MCP → 编辑 → 去授权），不重试创建 |
| 凭证错（401/403） | HTTP 401/403 / unauthorized | token 缺失、过期或权限不足 | 向用户索要新凭证并说明用途；放入 env/headers 对应字段后重试；不回显明文 |
