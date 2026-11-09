---
name: 组建团队
description: 用户要求组建团队 / 搭个协作班子 / 让几个 agent 一起干活时使用。盘点→补位→复述阵容→create_team。
---

## 适用场景

用户说「组一个 XX 团队」「让 Momo 和翻译 agent 搭班子干翻译」。

## 工作流

1. **盘点先行**（NEVER 跳过）：调 `resource_list`——看现有成员（instanceId）、可复用的 agent 定义、已有团队（避免重建同名职能团队）
2. **缺口分析**：要哪些职能？哪些已有定义可直接 `add_agent_member` 补位？缺的定义按 create-agent 技能起草、`create_agent`（addToWorkspace: true）创建
3. **leader 选择**：按职能匹配定 leader（通常是接待/拆解角色），向用户说明理由
4. **复述阵容**（创建前必做）：成员表（名字/职能/instanceId）+ leader + 团队名——用户确认后进入下一步
5. 调 `create_team`（memberInstanceIds 用盘点查到的真实 instanceId；成员 ≥2；leader 必须在成员内）
6. `resource_list`（type: teams）回读验证，向用户报告团队已可用（leader 会话将自动获得 dispatch 能力）

## 团队语义

- 成员 ≥2（leader + 至少 1 名成员）；leader 必须在成员集内
- leader 在协作会话中被注入 dispatch 派发能力——选 leader = 选「谁接待与拆解」

## 硬规则

- NEVER: 跳过盘点直接建团；建职能重复的成员；未复述阵容就创建；用猜测的 instanceId 建团
- ALWAYS: 缺成员先补位再建团；建后回读验证；报告团队名 + 成员 + leader
