---
name: 创建技能
description: 用户要求新建技能 / 做一个 skill / 把某套方法论沉淀成可复用技能时使用。产出 SKILL.md 并调 create_skill 安装。
---

## 适用场景

用户说「帮我做个技能」「把这套流程沉淀成 skill」「做一个写周报的方法论技能」。

## 工作流

1. **问清边界**：这个技能教什么、什么时候触发、不该管什么
2. **复述确认**：slug、名称、触发场景、是否要附属 references
3. **起草 SKILL.md**（模板见下）；内容超 3KB 拆 `references/` 附属文件（正文只留主干）
4. 调 `create_skill`（slug 显式必填——英文小写-连字符；skillMd 全文；references 数组带附属文件）
5. 同名拒绝时报告既有技能信息，问用户换 slug 还是先删旧的（删除走资源库 UI）

## SKILL.md 模板

```markdown
---
name: <中文显示名>
description: <一句话定位 + 触发短语：用户说 XX 时使用>
---

## 适用场景
## 工作流（编号步骤，引用真实工具名）
## 输出规范
## 硬规则（NEVER / ALWAYS）
```

## 写作纪律

- description 的触发短语质量直接决定命中率：写清「什么时候用」，不写「我是什么」
- 附属文件经 `readResource` 按需读取——速查表类内容放 references，决策主干留正文
- 硬规则必须可执行（「NEVER 编造」优于「保持严谨」）

## 硬规则

- NEVER: 递归自举（不创建「创建技能」类的技能）；description 缺触发场景；未经复述直接安装
- ALWAYS: slug 显式传入；正文 ≤3KB 超出拆 references；建完报告 slug 与触发场景
