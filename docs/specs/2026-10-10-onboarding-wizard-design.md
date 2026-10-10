# 新装引导系统（Onboarding Wizard）设计

- **日期**：2026-10-10
- **状态**：待评审
- **范围**：renderer 引导向导 + 主进程 OnboardingService（方案生成与应用）
- **上游依据**：`docs/specs/2026-08-23-v2.0.0-platform-refactor-design.md`（kv 一次性提示先例）、`docs/specs/2026-08-31-agent-team-session-redesign.md`（成员制 / 默认 agent）

---

## 1. 背景与目标

新装用户首启时，现有空态只呈现一个孤立的「创建工作空间」表单（`App.tsx` 空态分支）：不知道要先配 LLM 供应商、不知道 agent 从哪来、不知道默认会话 agent 是什么。配置门槛高。

**目标**：新装用户经引导在几分钟内从零到达「有模型供应商 + 有工作空间 + 有已配置 agent + 默认会话 agent 生效」的可用状态，两条路线：

- **AI 路线**：配置 LLM → 创建工作空间 → 自然语言描述需求 → LLM 生成配置方案 → 预览确认 → 应用
- **手动路线**：配置 LLM → 创建工作空间 → 手选预制 agent / 建自定义 agent → 指定默认 agent

**AI 路线核心约束**（需求方拍板）：

1. LLM **优先从预制 agent**（`resources/agents/*.yaml`，现清单：coder / pm-agent / requirement-analyst）中选择启用；预制不满足需求时才降级生成 custom agent
2. LLM 可见**已注册 MCP / 已安装 skill 清单**，把相关资源引用同步挂载到 agent 上；**只能引用已注册/已安装资源**，结构上杜绝悬空引用

## 2. 非目标

- 不做团队（teams）编排——用户熟悉后在 UI 手动建
- 不做工作空间命名 / 会话设置等其他维度的 LLM 定制
- 不做引导的重新触发入口（老用户重配走既有设置页 / Agent 管理）
- 不做生成过程流式展示（单次非流式调用 + loading 态）
- 不做 v1 数据导入（升级用户走 P5 既有导出提示）

## 3. 总体流程与状态机

```
首启（bootstrapped 且 workspaces.length === 0 且 status === 'pending'）
  └→ OnboardingWizard（取代现空态分支）
       ① 欢迎页 —— 选路线：AI 引导 / 手动引导（「跳过引导」常驻各步）
       ② 配置 LLM ─┐ 两路线共用
       ③ 创建工作空间 ─┘
       ④ 分叉：
          AI：描述需求 → 生成中（loading）→ 方案预览（可勾改）→ 应用 → 完成页
          手动：选预制 agent / 建自定义 → 指定默认 agent → 完成页
       完成页「开始使用」→ markDone → MainShell
```

### 3.1 触发与退出语义

| 场景 | 行为 |
|---|---|
| 新装首启 | `workspaces.length === 0` 且 `status === 'pending'` → 向导 |
| 点「跳过引导」 | `markDone({ skipped: true })` → 现有空态（CreateWorkspaceDialog），之后不再自动弹出 |
| 完成任一路线 | `markDone({ skipped: false })` → MainShell（workspace 创建时已激活） |
| 中途退出 App | 向导步骤状态不持久化，下次重来；已完成的真实配置（provider / workspace）保留 |
| 向导内已有 provider（半程重来） | ② 步提供「使用已有供应商」快捷路径，不强制新建 |
| **边沿：③ 步建完 ws 后退出 App** | 下次启动 `workspaces.length > 0` → 直接 MainShell，**不补弹向导**（status 永留 pending 无害——仅空工作空间时读取）；用户手动补配。此边沿不追状态 |
| v1 升级用户（旧库重置） | 同样进向导（v2 新库全空）；完成后 MainShell 与 UpgradeNotice 共存，互不阻塞 |

### 3.2 幂等预填

每步挂载时检查真实系统状态：已有可用 provider → ② 提供快捷路径；已有 workspace（防御性）→ 跳过 ③ 直达 ④。真实配置是唯一状态源，向导内不另存进度。

## 4. 状态持久化

复用 UpgradeNotice 的 kv 一次性模式（同一 kv 机制、同一读写先例）：

- key：`onboarding.status`
- 值：`'pending'`（缺省）/ `'completed'` / `'skipped'`
- 读取时机：仅 boot 且 `workspaces.length === 0` 时（`onboarding:getStatus`）
- 写入时机：完成或跳过时（`onboarding:markDone`）

## 5. IPC 契约

数据获取**复用既有通道**：`provider.list` / `provider.create` / `provider.fetchModels`（key 验证）、`resource.listBuiltinPresets` / `resource.previewBuiltinPreset`、MCP 注册表列表、skill 安装列表、`workspace.create`、预设启用链。新增 4 个通道（types.d.ts 双端镜像，preload 三层引用注意项照旧）：

```ts
// —— renderer/src/ipc/types.d.ts（electron 端同形镜像）——

type OnboardingStatus = 'pending' | 'completed' | 'skipped';

/** onboarding:getStatus */
interface GetOnboardingStatusResult {
  status: OnboardingStatus;
}

/** onboarding:generatePlan 入参 */
interface GenerateOnboardingPlanInput {
  /** 用户需求描述（非空，长度上限 4000 字符，超出截断并提示） */
  requirement: string;
  /** 第②步配好的供应商 + 模型（生成调用与 custom agent 落库共用） */
  providerId: string;
  modelId: string;
}

/** 方案中的单个 agent 项（preset / custom 二态） */
interface OnboardingPlanPresetAgent {
  kind: 'preset';
  /** 预制 agent slug（resources/agents/<slug>.yaml） */
  slug: string;
  /** 给用户看的选择理由（中文一句话） */
  reason: string;
  /** LLM 追加挂载的 MCP 引用（已注册名校单内的子集，应用前仍会过滤） */
  mcps: string[];
  skills: string[];
}

interface OnboardingPlanCustomAgent {
  kind: 'custom';
  name: string;
  iconEmoji: string;
  systemPrompt: string;
  /** 工具档：standard=安全最小集 / all=全部内置工具（同 CreateAgentDialog 三档中的两档，
   *  引导期不暴露 custom 勾选档） */
  toolPreset: 'standard' | 'all';
  reason: string;
  mcps: string[];
  skills: string[];
}

type OnboardingPlanAgent = OnboardingPlanPresetAgent | OnboardingPlanCustomAgent;

/** LLM 生成 / 用户勾改后的配置方案 */
interface OnboardingPlan {
  agents: OnboardingPlanAgent[];
  /** 默认会话 agent 指向 agents[i]；应用前校验越界钳制 */
  defaultAgentIndex: number;
}

/** onboarding:applyPlan 入参 */
interface ApplyOnboardingPlanInput {
  plan: OnboardingPlan;
  workspaceId: string;
  /** custom agent 落库所用供应商 + 模型（同 generatePlan 入参来源） */
  providerId: string;
  modelId: string;
}

/** onboarding:applyPlan 返回 */
interface OnboardingApplyResult {
  applied: Array<{
    name: string;
    kind: 'preset' | 'custom';
    instanceId: string;
  }>;
  /** 非致命警告（如剔除的未注册 MCP/skill 引用），预览页与应用结果页展示 */
  warnings: string[];
  defaultAgentName: string;
}

/** onboarding:markDone 入参 */
interface MarkOnboardingDoneInput {
  skipped: boolean;
}
```

通道清单：

| 通道 | 方向 | 说明 |
|---|---|---|
| `onboarding:getStatus` | renderer → main | boot 判定 |
| `onboarding:generatePlan` | renderer → main | 主进程直调 LLM，60s 超时；失败抛中文错误 |
| `onboarding:applyPlan` | renderer → main | 主进程重校验后应用；幂等 |
| `onboarding:markDone` | renderer → main | 写 kv（completed / skipped） |

## 6. 主进程 OnboardingService

新模块 `electron/src/main/onboarding/`，三个职责件：

### 6.1 plan-generator（方案生成）

- **prompt 组装**：
  - 系统指令：角色设定 + 输出 JSON schema 描述（`OnboardingPlan` 形状）+ 硬性规则（优先 preset；MCP/skill 只能从给定名单选；`agents` 1~5 个；`defaultAgentIndex` 必填；全中文 reason）
  - 上下文：预制 agent 清单（`previewBuiltinPresetAgent(slug)` 的 name/description/已有 tools/mcps/skills）+ 已注册 MCP 名单（`listRegistered()`）+ 已安装 skill 名单（registry `list()` 的 slug+name+description）
  - 用户输入：需求文本
- **LLM 调用**：`createLLMProvider`（provider 行 + `getProviderApiKey(providerId)` 解 key）单次非流式 `chat`；独立超时常量 `ONBOARDING_LLM_TIMEOUT_MS = 60_000`（不复用 300s 全局值——引导场景等不了 5 分钟）
- **解析防御**：响应 → 剥离可能的 markdown 代码围栏 → `JSON.parse` → shape guard（`isOnboardingPlan`：agents 非空数组、kind 判别、字段类型逐一校验）。失败则把错误信息 + 原响应拼回对话**静默重试一轮**；再失败 throw 中文错误（「AI 生成的方案格式无效，请重试或转手动配置」）
- **生成侧初步过滤**：slug 不在预制清单 → 剔除该项并记 warning；MCP/skill 引用不在注册/安装集 → 剔除该引用并记 warning（应用侧仍会再过滤一遍，双保险）

### 6.2 plan-validator（应用前重校验）

`applyPlan` 入参的 plan 来自 renderer（用户可能勾改过），**不可盲信**：

- agents 非空（用户至少勾选 1 个，renderer 侧已守卫，主进程再守一道）
- preset slug ∈ 预制清单；custom 字段非空（name/systemPrompt）
- MCP/skill 引用 ∩ 注册/安装集，未注册引用剔除 + warning
- `defaultAgentIndex` 越界 → 钳制到 0 + warning
- providerId / modelId / workspaceId 存在性校验

### 6.3 plan-applier（应用，幂等）

顺序执行，任一步失败即中断并抛错（已应用项保留，是真实可用配置非垃圾；用户可整包重试）：

1. **preset 项**：走既有启用链落库 def（`readBuiltinManifestBySlug` → save；启用链幂等，重复启用不产生新 def）→ 计算 finalMcps =（YAML 声明 ∪ plan.mcps）∩ 已注册集，finalSkills 同理 → 更新 def 的 `defaultMcps`/`defaultSkills` → `addMember(wsId, defId)`（**先查成员已存在则跳过**——同 ws 同 def 唯一约束，幂等关键点）
2. **custom 项**：`createCustomDef`（modelProviderId/modelName = 入参 provider/model；工具档映射：standard→`SAFE_MINIMUM_TOOLS`，all→`ALL_BUILTIN_TOOLS`；mcps/skills 过滤后写入）→ `addMember`（同样先查后加）
3. `setDefaultAgent(wsId, 默认项的 instanceId)`
4. 返回 `OnboardingApplyResult`（applied / warnings / defaultAgentName）

## 7. MCP / Skill 同步规则（对应需求约束 2）

最终挂载集 =（预制 agent 的 YAML 声明 ∪ LLM 方案追加）∩（MCP 已注册集 / skill 已安装集）。

- LLM 的追加只能从 prompt 里给定的**白名单**选；白名单外的引用在生成侧与应用侧**双重过滤**
- 被剔除的引用进 `warnings`，预览页与应用结果页可见——不静默
- 落库后资源库悬空扫描（`listDanglingMcpRefs`）结果不受影响（验收标准之一）

## 8. Renderer 组件

```
routes/OnboardingWizard.tsx            — 步骤状态机（本地 state，不进 zustand；真实配置为唯一状态源）
components/onboarding/WelcomeStep.tsx  — 路线选择（AI / 手动）+ 跳过引导
components/onboarding/ProviderStep.tsx — 紧凑供应商表单：预设下拉（PROVIDER_PRESETS）+ baseUrl/platform
                                          预填 + api key + 默认模型；fetchModels 验证 key；已有供应商快捷路径
components/onboarding/WorkspaceStep.tsx — 名称 + 目录（复用 CreateWorkspaceDialog 字段与校验逻辑）
components/onboarding/RequirementStep.tsx — AI 路线：需求 textarea（示例 placeholder + 4000 字符上限）
components/onboarding/PlanPreviewStep.tsx — 生成 loading → 方案卡片列表（每卡：名称/来源徽标（预制/自定义）/
                                          reason/挂载 MCP·skill/含复选框）+ 默认 agent 单选（限已勾选项）
                                          + 警告区 + [应用配置]
components/onboarding/ManualAgentStep.tsx — 预制清单（可展开 previewBuiltinPreset 详情，systemPrompt 展示层截断）
                                          + 「创建自定义」精简表单（name/icon/systemPrompt/工具两档；
                                          模型固定用第②步默认值，不设选择器——可后续在 Agent 管理改）
                                          + 默认 agent 单选
components/onboarding/DoneStep.tsx     — 配置摘要 + [开始使用]
```

交互要点：

- **「转手动」出口**：RequirementStep / PlanPreviewStep 的任何失败卡片上提供 [重试] [转手动]；转手动保留已完成的 provider/workspace 成果，直达 ManualAgentStep
- **PlanPreviewStep 勾改**：全部取消勾选 → [应用配置] 禁用（至少 1 个）；默认 agent 单选随勾选集收缩，被取消则回退第一勾选项
- **UI 设计系统**：语义 token / lucide 16px stroke 1.75 / 原子组件（Button/Input/Dialog/Checkbox）优先；**新页面属 P1 变更——实现前按 momo-ui-preview-rules 出静态预览图，需求方确认后方可动代码**
- App.tsx 空态分支改造：`workspaces.length === 0 && status === 'pending'` → OnboardingWizard；`skipped` → 现有空态

## 9. 错误处理总表

| 故障点 | 表现 | 恢复路径 |
|---|---|---|
| ProviderStep key 无效（fetchModels 失败） | 行内错误，停留本步 | 改 key / 换供应商 |
| generatePlan 网络 / 超时 / key 失效 | PlanPreviewStep 错误卡片（中文原因） | [重试] [转手动] |
| generatePlan 两轮解析失败 | 同上（明确提示格式无效） | 同上 |
| 方案含未注册 MCP/skill | 预览页 warning 区列出 | 无需动作，应用时自动剔除 |
| applyPlan 部分失败 | 结果页错误 + 已应用清单 | [重试]（幂等）/ [转手动]（已应用项保留） |
| markDone 失败 | toast 错误，向导不关 | 重试完成动作 |

错误一律显式呈现，禁止静默吞（研发红线）。

## 10. 测试策略

### 主进程（`electron/tests/onboarding/`，目录镜像 src）

- plan-generator：prompt 组装含全部上下文（预制清单 / MCP / skill 白名单）；shape guard 正反例；静默修复一轮后成功 / 两轮失败 throw；生成侧过滤（非法 slug、白名单外引用剔除）
- plan-validator：勾改后 plan 的重校验逐条（越界钳制、空 agents 拒绝、引用过滤）
- plan-applier：preset 启用 + def 能力更新 + addMember；重复 apply 幂等（无重复成员、无重复 def）；custom 创建字段映射（工具档→SAFE_MINIMUM/ALL）；部分失败中断语义
- kv 状态迁移：pending → completed / skipped
- LLM 全程 mock `createLLMProvider`——mock 边界与真实一致（入参形状 / 超时常量引用），遵守 momo-test-rules

### Renderer（贴源 colocated，`*.test.tsx` 同目录）

- 向导分叉渲染（AI / 手动 / 跳过）；ProviderStep 已有供应商快捷路径；PlanPreviewStep 勾改与默认 agent 联动；错误路径逐条断言（LLM 失败卡 / apply 部分失败 / 全取消勾选禁用）

### e2e（`tests/e2e/`）

- 现有空态相关 spec 适配：seed kv `onboarding.status = 'skipped'` 走旧路径，或改走向导
- 新增主链路：全新 profile → AI 路线走完 → MainShell + agent 已启用 + 默认 agent 生效

无 DB migration（纯 kv + 复用既有表）。

## 11. 验收标准

1. 全新 profile 首启 → 向导出现；AI 路线走完 → MainShell，方案中 agent 全部启用为成员，默认会话 agent 生效（快速会话直达该 agent）
2. 手动路线走完 → 同等产出
3. 跳过 → 现有空态表单；重启不再出现向导
4. 断网 / 坏 key 生成失败 → 错误卡 + [重试] 可用 + [转手动] 保留前序成果
5. 方案含未注册 MCP 引用 → 预览警告可见；落库后 `listDanglingMcpRefs` 无新增悬空
6. applyPlan 整包重试 → 无重复成员 / 重复 def
7. v1 升级 profile → 向导 + UpgradeNotice 共存不互相阻塞
8. `npx pnpm@9.0.0 typecheck` + 两 workspace 测试全绿；e2e 主链路通过

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| LLM 输出不稳定（JSON 格式漂移） | shape guard + 一轮静默修复 + 显式重试出口；预制优先策略天然缩小生成面 |
| 60s 超时对慢模型偏紧 | 常量可调；超时报错文案建议换更快模型（如 flash 档） |
| 预制 agent 启用链幂等性假设不成立 | 实施第一步先写幂等回归测试验证启用链，不成立则在 applier 内先查后启 |
| e2e 既有空态 spec 破坏 | seed kv 方案保持旧路径可测，适配工作量受控 |
| 向导中途退出后 ws 已建（3.1 边沿） | 明确不追状态，用户手动补配；文档化 |

## 13. 实施注意事项

- **版本号纪律**：特性合入只把三处 `package.json` alpha 号 +1，不动 CHANGELOG 产品版本（`docs/dev/release.md`）
- **UI 预览门禁**：OnboardingWizard 为新页面（P1），实现前静态预览图须需求方确认（momo-ui-preview-rules）
- **IPC 契约**：4 个新通道的 types.d.ts 双端镜像 + 两 workspace typecheck（momo-boundary-rules）
- 复用清单速查：`PROVIDER_PRESETS` / `provider.create` / `provider.fetchModels`、`previewBuiltinPresetAgent` / `listBuiltinPresetAgents`、`readBuiltinManifestBySlug` 启用链、`listRegistered()` / SkillRegistry `list()`、`SAFE_MINIMUM_TOOLS` / `ALL_BUILTIN_TOOLS`、`workspace.create` / `setDefaultAgent`、kv 机制（UpgradeNotice 先例）、`createLLMProvider` 直调先例（session-naming / memory extraction）
