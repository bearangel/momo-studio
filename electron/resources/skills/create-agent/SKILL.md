---
name: 创建 Agent
description: 用户要求新建 agent / 新建智能体 / 定制一个助手 / 做个专门干某事的 agent 时使用。产出 YAML manifest 并调 create_agent 落库。
---

## 适用场景

用户说「帮我建一个 XX agent」「我想要一个专门写周报的助手」「做一个爬虫 agent」——任何要新建 agent 的请求。

## 工作流

1. **问清定位**：一句话职能（做什么/不做什么）+ 典型任务示例；用户已说清则不追问
2. **选模型**：先调 `list_models` 查真实清单。三方契约——manifest `model.provider` 只填协议平台 `openai` 或 `anthropic`（= list_models 的 `platform` 字段，**不是**供应商名/providerId）；manifest `model.model` 填建议模型名。**真实绑定**：调 `create_agent` 时传 `modelProviderId`（= list_models 的 `providerId`）与 `modelName`（= 所选 `modelId`）；用户未指定且不传时走全局默认聊天模型兜底，复述时说明绑定来源
3. **复述确认**（创建前必做）：向用户复述——名称、slug、一句话职能、工具面清单、是否立即加入当前工作空间
4. **起草 manifest**（K8s 风格，模板见下），工具只授任务必需的（最小授权——速查表 readResource 读 create-agent/references/tool-catalog.md）
5. 调 `create_agent`（manifestYaml 全文；要立即可用则 addToWorkspace: true）
6. 校验失败会逐字段报错——修正 YAML 后重试，不换 slug 逃避
7. 成功后报告 definitionId 与 slug，指引用户在资源库查看/编辑

## manifest 模板

```yaml
apiVersion: v1
kind: AgentDefinition
metadata:
  name: <中文显示名>
  slug: <英文小写-连字符>
  version: 1.0.0
  description: <useWhen 导向一句话：什么时候找我>
  iconEmoji: "<emoji>"
spec:
  runtime: declarative
  declarative:
    systemPrompt: |
      你是 <角色>——<一句话锚定>。你做 <Y>，你从不 <Z>。
      工作流：
      1. ...
      纪律：
      - NEVER: ...
      - ALWAYS: ...
    model:            # 必填（校验要求）。provider 填平台枚举 openai/anthropic（list_models 的 platform 字段），非供应商名；值均为建议位，真实绑定走 create_agent 的 modelProviderId 入参
      provider: anthropic
      model: claude-sonnet-4-5
  defaultTools:       # 只授必需工具（kind: builtin + 精确工具名）
    - kind: builtin
      ref: read_file
```

## 输出规范

prompt 四段式：角色锚定一句话 → 工作流编号步骤（引用真实工具名）→ 纪律 → 硬规则（NEVER/ALWAYS）。

## 硬规则

- NEVER: 引用不存在的工具名或 skill slug（工具全集见 references/tool-catalog.md）；未经复述直接创建；slug 冲突时静默换名重试
- NEVER: 省略 spec.declarative.model 块（parser 校验必填；provider/model 填建议值即可，真实绑定走全局默认兜底）
- ALWAYS: 创建前复述关键参数；工具面最小授权；建完报告 definitionId + slug
