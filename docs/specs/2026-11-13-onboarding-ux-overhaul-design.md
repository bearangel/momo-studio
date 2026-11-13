# 首启引导体验优化（Onboarding UX Overhaul）设计

- 日期：2026-11-13
- 状态：待评审
- 依据：2026-11-13 隔离实例双路线走查（`.omo/qa-reports/2026-11-13-onboarding-walkthrough/walkthrough.html`，16 张实操截图）+ 用户实操反馈
- 关联 spec：`2026-10-10 新装引导向导`（§3/§5/§8/§9 幂等预填、跳过链、markDone 收闩语义均沿用，本 spec 不推翻）

## §1 问题清单与裁定

来源：走查观察 9 条 + 用户实操新增 3 条，共 12 条。逐条裁定如下（「不做」= 明确排除，进 §11 非目标）：

| # | 来源 | 问题 | 裁定 |
|---|---|---|---|
| P1 | 用户 | 自定义供应商需手输模型 ID，无「获取模型列表」 | 做 → §3 T1 |
| P2 | 用户 | 预设供应商模型列表固定，供应商上新后用户拉不到最新 | 做 → §3 T1 |
| P3 | 用户 | 跳过引导后主界面嵌入工作空间表单，突兀；应独立页强制配置 | 做 → §4 T2（只强制工作空间，不强制模型服务） |
| P4 | 走查高① | 引导终点断点：落地空会话列表 + 禁用输入框 | 做 → §5 T3 |
| P5 | 走查高② | 工作空间步「取消」死按钮（onClose 为空函数） | 做 → §6 T4 |
| P6 | 走查中③ | requirement/manualAgents「上一步」回 workspace 被直通弹回 | 做 → §6 T4 |
| P7 | 走查中④ | chips 空态「上一步/重新选择」语义重叠 | 做 → §6 T4 |
| P8 | 走查中④ | 15 chip 无分组 | **不做**（用户裁定 2026-11-13：暂无必要） |
| P9 | 走查中⑤ | AI 生成 10–30s 仅一行文案，无进度感、等待期无出口 | 做 → §7 T5（轻量：阶段文案 + 等待期可转手动；不做主进程取消通道） |
| P10 | 走查中⑥ | 「自动组建团队」首次出现在结果摘要，事前无预告 | 做 → §7 T5 |
| P11 | 走查低⑦ | 向导态 TitleBar 空条带，首屏留白高 | 做 → §8 T6 |
| P12 | 走查低⑨ | 手动路线预制仅 1 个 | **不做**（用户裁定：仅提供 Momo，维持内置极简化） |

## §2 目标 / 非目标

**目标**：模型服务步接入动态模型拉取；跳过引导的落点改为独立必填工作空间页；引导终点直通首个快速会话；清理三处交互 bug；补齐等待反馈与预告文案；TitleBar 产品标识。

**非目标**（§11 汇总）：chips 分组；恢复内置预制；主进程生成取消 IPC；设置页模型管理改造（仅复用既有通道）；「重新运行引导」入口；DB 迁移（无）。

## §3 T1 模型列表动态拉取

### 3.1 现状与缺口

主进程已有两条模型列表通道，均要求供应商已落库：

- `provider:fetchModels`（`fetchRemoteModels(id)`，provider-ipc.ts:113）——按 providerId 实时调供应商远端模型端点
- `provider:listModels`（`listProviderModels(id)`）——读 provider_models 库表快照

缺口：向导在供应商**未落库**（custom/preset 表单态）时没有任何拉取通道；preset 形态的模型下拉只用静态 `preset.models` seed。

### 3.2 新 IPC：`provider:probeModels`

| 项 | 定义 |
|---|---|
| channel | `provider:probeModels` |
| 入参 | `{ baseUrl: string; apiKey: string; platform: 'openai' \| 'anthropic' }` |
| 出参 | `{ models: string[]; truncated: boolean }`（仅模型 id，升序稳定排序；上限 200，超出置 truncated） |
| 错误 | 网络/超时 → `'无法获取模型列表：<原因>，可手输模型名继续'` 风格中文错误（IPC throw）；401/403 → 明示 key 无效 |
| 超时 | 10s（AbortController 真中断，复用 testConnection 同款纪律） |
| 安全 | **零副作用**：不落库、key 不写 keychain（内存态即用即弃）、返回不含 baseUrl/key —— 与 testConnection「先验证后落库」同族 |

实现（electron）：`fetchRemoteModels` 抽出共享底层 `fetchModelIdsFromEndpoint(baseUrl, apiKey, platform)`；`probeModels` 为其未落库变体，**端点拼接与请求头（Bearer vs `x-api-key` + `anthropic-version`）与 fetchRemoteModels 现行实现同源共享**——不另立拼接规则，两通道行为永远一致。响应解析只取 id 字段，非字符串项跳过。

IPC 契约同步（momo-boundary-rules）：`renderer/src/ipc/types.d.ts` ProviderApiSurface 加 `probeModels`；`electron/src/preload/index.ts` 透传；两 workspace typecheck。

### 3.3 向导三形态 UI 改造（ProviderStep）

字段级状态机：`idle`（现状手输/静态下拉）→ `fetching`（spinner）→ `fetched`（下拉）| `error`（错误提示 + 保留手输）。

| 形态 | 改造 |
|---|---|
| custom | 模型名 Input 旁加「获取模型列表」按钮（baseUrl+key 非空才启用）；fetched 后 Input 变 Select：options = 拉取列表 + 固定尾项「手动输入…」（选中回退 Input 态）；error 保留 Input + 行内错误 |
| preset | 模型 Select 旁加刷新 icon button（`RefreshCw` 16/1.75，key 非空才启用）；拉取成功后 options = `merge(远端列表, preset.models)` 去重、远端在前——**供应商上新模型即刻可见**；保留预置项兜底（拉取失败不丢） |
| existing | Select 旁同样刷新按钮 → 调既有 `provider:fetchModels(id)` 后重拉 `listModels` 刷新下拉 |

> 勘误（Oracle 终审 2026-11-13）：`fetchModels` 主进程为纯拉取零落库——原文「调 fetchModels 后重拉 listModels」不足以刷新。正确机制：**调用方持返回 ids 逐个 `addModel` 幂等入库**（ProviderModelList/Picker 既定模式）后重读表。实现已按此修正（feat/onboarding-ux-overhaul 分支）。

「验证并继续」逻辑不变（testConnection 仍以表单当前 modelId 验证——拉取只是帮填，不替代验证）。

## §4 T2 跳过引导 → 独立必填工作空间页

### 4.1 挂载分支（App.tsx）

现行：`workspaces 空 && onboarding.status === 'pending'` → OnboardingWizard（App.tsx:155）。

新增分支（向导分支之后判定）：

```
workspaces 空 && status ∈ {completed, skipped}  →  <WorkspaceGate />
```

即：跳过引导（或历史库工作空间被清空）的用户不再落进 MainShell 空态，而是独立全屏页。有工作空间则照常 MainShell——**只在工作空间缺失时介入**。

### 4.2 WorkspaceGate 组件（新）

- 视觉：复用向导壳——`TitleBar wizardMode` + 居中卡片（与 OnboardingWizard 同布局骨架），不渲染 StepAnchorBar（非流程，无步骤概念）
- 内容：标题「设置工作空间」+ 说明「agent 的文件操作都发生在这个目录里，创建后即可开始使用」+ `CreateWorkspaceDialog embedded hideCancel`
- **无跳过出口**：不提供任何绕过（用户裁定：必须配置）。目录不存在确认弹层（D7）原样保留
- 完成判定：`useWorkspaceStore.activeWorkspaceId` 从 null 翻转 → App 重渲染进 MainShell（与 WorkspaceStep 同款捕获模式）

### 4.3 MiddlePanel 首启空态退役

MiddlePanel 中嵌入的 CreateWorkspaceDialog 表单改为轻空态：一句「还没有工作空间」+「新建工作空间」按钮 → 打开 CreateWorkspaceDialog **Dialog 形态**。`embedded` 形态的消费方从此仅剩 OnboardingWizard 与 WorkspaceGate。原「首启空态创建流程 store 断言」（MiddlePanel.test）随形态迁移改写。

### 4.4 CreateWorkspaceDialog 增强

新增 prop `hideCancel?: boolean`：为 true 时表单底部不渲染「取消」（向导/Gate 场景）；对话框场景缺省保留。

## §5 T3 引导终点直通首个会话

DoneStep「开始使用」链路改为：`markDone({skipped:false})` → **自动创建快速会话**（defaultAgent 指向的实例；通道与主界面「快速会话」按钮现行链路完全同源，不另建通道）→ `ctx.finish()` → MainShell 落地即该会话打开、输入框可用。

- 快速会话创建失败（IPC 错误/无默认 agent 实例）：**降级不阻断**——toast 提示「快速会话创建失败，可手动新建」，照常进主界面
- 跳过路线（T2 WorkspaceGate 创建后）：不建会话（跳过者无 agent，落地空主界面为合理终态）
- 走到 DoneStep 的用户必然已有 provider+model+agent（AI/手动路线均必经 provider 步），无缺省分支

## §6 T4 交互 bug 清理

| 项 | 修法 |
|---|---|
| 死按钮（P5） | `hideCancel` 见 §4.4；向导 WorkspaceStep 与 WorkspaceGate 均传 true |
| 上一步弹回（P6） | RequirementStep 与 ManualAgentStep 的「上一步」目标从 `ctx.go('workspace')` 改为 `ctx.go('provider')`——workspace 已建成不可重选（spec §3.2 防御性跳过语义不变），绕开直通弹回；WorkspaceStep 内部直通 effect 原样保留（幂等预填） |
| chips 语义（P7） | ProviderStep「重新选择」渲染条件收窄：仅在 `mode === 'preset' \|\| mode === 'custom'` 时渲染（chips 态只留「上一步」；existing 态已有「返回新建」） |

## §7 T5 等待反馈与文案

1. **生成等待**（RequirementStep）：busy 期间文案 8s 阶段轮换「正在分析你的需求…」→「正在挑选合适的 agent…」；**「转手动配置」按钮 busy 时保持可点**——点击即放弃等待（ref 标记 abandoned，迟到的 generatePlan 结果静默丢弃），立即转 manualAgents（前序成果保留语义不变）
2. **组队预告 ×2**：PlanPreviewStep 底部（默认 agent 提示行旁）加「启用 ≥2 个 agent 时将自动组建团队，默认会话智能体担任队长」；DoneStep 摘要「已组建团队」行下加小字说明「多 agent 协作时可在会话中 @ 成员派发任务」
3. **custom 表单细节**：API Key Input 补 `placeholder="sk-..."`；`submitNew` 校验改逐字段判断，错误文案列出实际缺失字段名（如「请填写 API Key」）

## §8 T6 TitleBar 产品标识

TitleBar `wizardMode`（及 WorkspaceGate 同款态）渲染产品标识：logo 资产 + 「Momo Studio」字标，居左（macOS 红绿灯右侧）；正常主界面态不变。logo 资产优先复用 renderer 现有图标资源，无则用 lucide 图标 + 字标（实现时确认，避免新引静态资产）。

## §9 测试策略（momo-test-rules 纪律）

| 层 | 用例 |
|---|---|
| electron 单测（tests/ 镜像结构） | probeModels：成功解析 / 401 明示 key 无效 / 超时真中断 / 200+ 截断标志 / 非法响应容错；共享底层 fetchModelIdsFromEndpoint 的平台头差异 |
| renderer 单测（贴源） | ProviderStep：三形态拉取按钮启用条件、fetched→Select→「手动输入…」回退、error 保留手输、preset merge 去重远端优先；RequirementStep：上一步目标 provider、busy 期转手动可点且迟到结果丢弃；ManualAgentStep：上一步目标 provider；WorkspaceGate：挂载条件矩阵、创建后退出、无跳过出口；DoneStep：自动建会话成功 / 失败降级 toast；ProviderStep「重新选择」渲染条件 |
| App 分支回归锁 | 状态矩阵：pending+空ws→向导；completed/skipped+空ws→Gate；有 ws→MainShell（三态互斥不串） |
| 既有测试改写 | MiddlePanel.test 首启空态断言迁移；OnboardingWizard/WorkspaceStep 相关断言随 hideCancel 调整 |

mock 保真：fetch 层 mock（真实响应形状），不 mock 到 IPC 边界两跳。

## §10 实施顺序与门禁

1. **顺序**：T1 → T2 → T3 → T4 → T5 → T6（体验主线优先；T4 的 hideCancel 依赖 T2 的 prop 设计，随 T2 先行落地也可）
2. **UI 预览门禁（momo-ui-preview-rules）**：T1 模型字段三态与 T2 WorkspaceGate 属 P1 级（新交互形态/新页面）——实现前先出静态预览稿（`.omo/previews/*.html`）交用户确认；T5/T6 为 P2 小改，事后截图验收
3. 每主题完成后跑双 workspace typecheck + 相关单测；全部完成后按 momo-acceptance 隔离实例回归走查（复用本次走查的 mock LLM 方法）

## §11 兼容性与非目标

- IPC 只增不改：probeModels 新增，既有通道签名不动
- 无 DB 迁移；onboarding kv_store 语义不变（pending/completed/skipped）
- 明确排除：chips 分组（P8）、恢复内置预制（P12）、主进程生成取消通道、设置页模型管理改造、重新运行引导入口
