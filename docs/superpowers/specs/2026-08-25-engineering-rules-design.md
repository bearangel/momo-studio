# 研发规则体系设计——主机验收 8 个 P0 教训沉淀

日期：2026-08-25
状态：已批准
来源：2.0.0 发布后 macOS 主机验收陪跑会话（8 个 P0 + 2 个功能优化 + 运维面修复）

## 背景与动机

主机验收暴露的问题复盘后发现，1074+ 单测全绿掩盖了系统性缺陷——问题集中在四个模式：

1. **Mock 保真度缺口**（4/8）：单测 mock 不仿真真实运行时语义（this 绑定、ID 唯一性），测试绿但生产崩。
2. **跨边界契约漂移**（4/8）：生产者/消费者各自演化，无人验证对接面（等从不产生的事件、ID 跨模块无同源保证、路由目标用配置默认值）。
3. **错误路径/空输入是二等公民**（2/8）：happy path 有测试，错误路径硬编码吞掉真实状态。
4. **环境分歧**：stale renderer 产物连续两轮被误判为「修复无效」；代理环境劫持 localhost 探测。

同时沉淀了被验证有效的正向方法论（先复现后修复、真实 LLM harness、SQLite 直查、运行时探针），需要制度化。

## 目标

把上述教训转化为 opencode **动态加载的研发规则**：agent 修 bug/写测试/改跨模块代码时自动获得对应规则，无需人工注入上下文；人可读的完整复盘另存。

## 载体设计（opencode 机制）

| 层 | 位置 | 加载机制 | 内容 |
|---|---|---|---|
| 红线 | `AGENTS.md` | 每会话自动注入 | 8 条一句话规则 + skill 指引 |
| Skill ×3 | `.opencode/skills/<名>/SKILL.md` | description 常驻、任务匹配时正文自动加载 | 场景化规则 + 案例 3-5 行摘要 |
| 详版 | `docs/dev/rules/engineering.md` | 手动阅读 | 8 个 P0 完整复盘 + 方法论 |

Skill 触发关键词设计：
- `momo-debug-rules`：修 bug、排查、为什么不工作、报错、修复无效
- `momo-test-rules`：写测试、mock、vi.mock、回归锁、断言
- `momo-boundary-rules`：IPC、跨模块、协议、事件、streamSessionId、字段

## Skill 内容规则集

### momo-debug-rules（修 bug / 排查）

- 修复前必须先复现（三级手段：容器 harness / 真实 LLM e2e / xvfb+CDP 探针）
- 用户报「修复无效」→ 先验证构建新鲜度（git log ↔ electron/dist ↔ renderer/dist 三查），再怀疑代码
- 数据争议用 SQLite 直查裁决，不信 UI 观感
- 运行时黑盒加诊断探针（__momoDebug 模式：globalThis 钩子 + 一键导出 store 状态）
- 根因跨层时逐层断言（DB 行 / 事件 / 查找键逐项 verify）
- 修复必须带回归锁（先红后绿）；回归锁必须仿真真实运行时语义

### momo-test-rules（写测试 / mock）

- Mock 保真度原则：mock 仿真真实环境语义（this 绑定、id 唯一性、async 时序），「方便测试」的简化 = 埋雷
- 断言覆盖生产消费的字段（id/seq 被消费就断言真实唯一，不接受占位符）
- 错误路径/空输入必须有专项用例
- 契约测试：生产者产出 → 消费者直接消费（跨模块对接面有测试）
- mock 收窄：只 mock 边界（IPC/DB/fetch），内部逻辑不 mock

### momo-boundary-rules（跨模块 / IPC / 协议）

- 跨模块传递的 ID 单点生成、沿线透传，禁止中途回收再生成
- 「等待某事件」的代码必须验证该事件确实有生产者（查 emit 方）
- 语义化字段名一义一名；语义变化时改名或加新字段，禁止字段语义漂移
- 生产者/消费者成对修改：协议字段两端同步 + 契约测试
- 路由/关联目标用「当前上下文」而非「配置默认值」

## 验证方式

1. `ls .opencode/skills/*/SKILL.md` 结构 + frontmatter 合规（name 小写连字符 = 目录名、description 带触发词第三人称）
2. 重启 opencode 后新会话说「帮我修个 bug」——agent 应自动加载 momo-debug-rules
3. 纯文档/配置变更，不动代码与测试

## 范围外（2.1 待办）

- 机械防线 plugin（tool.execute.before 钩子拦截违规编辑）——维护成本 > 收益
- e2e harness 固化为可重复脚本（真实 LLM 凭据管理需先设计）
