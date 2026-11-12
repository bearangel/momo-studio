---
name: 管理智能体
description: 用户要求修改既有 agent / 成员 / 智能体时使用——给某个 agent 加技能、加工具、接 MCP、去掉某能力、改 prompt、换模型，或要求更新技能内容、更新 MCP 配置；以及删除类请求（删 skill / 删 MCP / 删 agent 定义 / 停用预设 / 移除工作空间成员）的拒答引导。
---

## 适用场景

用户对「已经存在的」agent 提出改动：「给 XX 加个 YY 技能」「把搜索工具去掉」「给它接个 MCP」「它的 prompt 太啰嗦了改一下」「换个便宜点的模型」「把那个技能的内容更新一下」「MCP 的地址换了」。以及任何删除类请求：「把 XX 技能删了」「删掉这个 MCP」「删了这个 agent」「停用这个模型预设」「把它从工作空间移除」。

## 工作流

1. **盘点**：先调 `resource_list` 拿当前工作空间成员清单，确认目标 agent 在场（拿到 instanceId 或 slug）
2. **看清现状**：调 `describe_agent` 看定义、生效能力与三层归因（来自定义 / 来自工作空间 / 来自成员增量），以及跨工作空间成员数——改前必做，避免重复添加或误判能力来源
3. **复述变更**（改前必做）：向用户复述——加什么 / 去什么、作用域是 member（只改本工作空间这个成员）还是 definition（改定义本身、全局生效）、影响几个工作空间；改 prompt / 模型 / 技能内容 / MCP 配置时同样复述关键值
4. **调 update 工具**：
   - 加减能力面 → `update_agent_capabilities`（scope 缺省 member，仅用户明确要求改定义本身 / 全局生效才传 definition；restart 缺省 auto）；扩权类变更会弹用户确认卡
   - 改名称 / 描述 / prompt / 图标 / 模型 / 工具禁用清单 → `update_agent_profile`（恒确认）
   - 更新技能内容 → `update_skill`（全量替换，仅自定义源可改；builtin / marketplace 拒绝并引导 UI）
   - 更新 MCP 配置 → `update_mcp`（先测连通再落库；返回 needsAuthorization 时引导用户完成 OAuth 授权后再试）
5. **确认结果**：确认卡被拒或超时即改道——问清顾虑、换更小的变更方案，不复读重试；工具报错会逐条列出非法引用（拼错的工具名 / skill slug / MCP 名），修正后重试
6. **如实转告生效时机**：member 级自动重启 → 下一轮生效；definition 级只停运行实例 → 用户重新拉起后生效；更新技能 → 已挂成员不重载，下个会话生效；更新 MCP → 基本即时生效。返回含 otherWorkspaceMembers 提示时转告：「另有 N 个工作空间也有这个 agent，需要一并加吗？」

## 输出规范

- 改动前：一句话复述变更清单 + 作用域（member / definition）+ 影响面；意图明确的直接执行，模糊的先问清
- 改动后：报「改了什么 + 生效时机 + 跨工作空间提示」三件事，不臆造「立即全部生效」
- 拒绝删除时：一句话 + 具体操作路径，不展开长篇解释

## 硬规则

- **删除拒答清单**（收到即一句话引导，不做任何近似操作）：删除 skill、删除 MCP、删除 agent 定义、停用模型预设、从工作空间移除成员——这五类一律没有对应工具，桥面架构上不存在删除入口。话术模板：「这个操作需要你亲自完成——我没有删除权限。请在 **资源库 → {页签} → {名称}** 操作。」具体指引：删 skill / 删 MCP / 删 agent 定义 → 资源库对应页签（Skill / MCP / 智能体）；停用预设 → 设置页模型供应商；移除工作空间成员 → 工作空间成员管理
- NEVER: 用 bash / sqlite3 / 文件系统直写绕过任何资源限制（agent 定义、技能与 MCP 的写入只走资源工具）
- NEVER: 把删除请求改写成「删了重建同名」（slug 冲突会直接失败，且重建会丢掉原资源的归属与配置）
- NEVER: 确认卡被拒后，未经用户明确改变主意就重试同一变更
- NEVER: 未经用户明确要求就使用 scope=definition（默认只动 member；definition 是全局改动）
- NEVER: 引用不存在的工具名、skill slug 或 MCP 名（拼错会被逐条报出——先 describe 盘点再引用）
- ALWAYS: 改前 `resource_list` + `describe_agent` 盘点现状
- ALWAYS: 改前向用户复述变更清单与作用域
- ALWAYS: builtin 预设定义收到改定义级请求 → 引导用户去资源库 UI（自定义 agent）；成员级调整照常执行
- ALWAYS: 成功后报告生效时机；返回 otherWorkspaceMembers > 0 时询问是否一并处理其他工作空间
