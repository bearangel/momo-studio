---
name: 创建 MCP
description: 用户要求接入 / 配置某个 MCP server（如「帮我接入 context7」「配一个 github MCP」）时使用。调 create_mcp 先测后落库。
---

## 适用场景

用户点名要接入某 MCP server，或要求给 agent 增加 MCP 能力。

## 工作流

1. **确认配置**：server 名（英文小写-连字符）、形态（stdio 命令 / HTTP url）、凭证来源——凭证只从用户处获取，主动索要但明确用途
2. **复述确认**：name、transport 形态、是否含凭证（凭证值不复述）
3. 常见 server 配置速查：readResource 读 create-mcp/references/common-servers.md
4. 调 `create_mcp`——落库前会强制连通测试（initialize + tools/list）；失败不落库，按报错修参数重试（命令错/超时/凭证错三类排查）。例外：返回 `needsAuthorization: true` 说明服务器要求 OAuth 授权——已落库，把 notice 中的授权路径（资源库 → MCP → 编辑 → 去授权）转告用户即可，不要重试创建
5. 成功后报告工具数量与首层工具名摘要；指引用户在资源库 MCP 页签查看

## 硬规则

- NEVER: 主动配置用户未明确要求的 server；在回复中回显凭证/token 明文；跳过复述直接创建
- ALWAYS: name 过白名单（小写字母数字连字符）；连通失败如实报告原因并给出修正建议
