# 供应商预设与模型思维模式配置设计

- 日期：2026-09-09
- 状态：已评审（brainstorming 三节逐节确认）
- 上游：压缩重构 spec 2026-09-09 §2.2/§2.3（model-catalog 与 resolve 链）
- 范围代号：provider-presets

## 0. 背景与目标

现状（v2.2）：

1. 供应商全手动创建——`model_providers` 空表起步，用户凭记忆填名称/BaseURL/平台/API Key；
2. 模型列表靠「获取模型列表」（远端 `/v1/models`，不带元数据）或手动输入 model ID；
3. 内置窗口目录（`electron/src/main/llm/model-catalog.ts`）只有正则兜底，用户不可见不可选，且旗舰缺位（无 GLM-5.x / DeepSeek V4 / Kimi K3）；
4. 思维模式（thinking / reasoning）**请求侧完全缺失**——`LLMProvider` 接口无 options 位，从未发送任何 thinking 参数；解析侧已有 `reasoning_content` → `thinking` delta（`llm-provider.ts:480`），UI 气泡可展示思维链，只欠「请求时开启」。

目标：

1. 供应商预制：新建时可一键选择预设（Cherry Studio 式全家桶 ~15 家：国内直连 + 国际直连 + 聚合/本地），预填连接信息 + 种子模型；
2. 模型上下文窗口：预设模型自带查证数字；用户覆盖列已存在，保留；
3. 常见模型预设：直连厂商带精选模型清单（含能力元数据）；
4. 思维模式：两级配置——模型级默认（供应商设置）+ agent 级覆盖（agent 定义）；档位词汇表随模型走，不硬归一化。

### 调研结论摘要（2026-09-09 查证，决策依据）

- **opencode**（sst/opencode）：目录运行时拉 models.dev（违反本项目本地零外部依赖）；`WIDELY_SUPPORTED_EFFORTS = ["low","medium","high"]` 三档仅为 OpenAI 兼容底座，按模型家族扩展（GPT-5.1 加 `none`、5.2+ 加 `xhigh`）；用户配置 per-field `??` + deep-merge 覆盖目录。
- **Cherry Studio**（CherryHQ/cherry-studio）：手写 TS registry 三层（providers 连接层 / creators 模型层 / per-model override 层）；`ReasoningControl` 联合类型（`effort / budget / toggle`）与 models.dev `reasoning_options` 同构；6 种 wire 格式；9 值 effort 词典 + 就近匹配阶梯。
- **厂商参数实测**（官方文档查证，附录 A）：
  - GLM-5.2/5.3：`thinking: {type: enabled|disabled}` + `reasoning_effort: low|high|max`（默认 max），上下文 1M；
  - GLM-4.5~4.7：仅 `thinking.type` 开关，无 effort 参数；
  - DeepSeek V4（v4-pro / v4-flash）：`thinking.type` + `reasoning_effort: low|high|max`，上下文 1M / 输出 384K；
  - Kimi K3：顶层 `reasoning_effort: low|high|max`，上下文 1M；K2.7 Code 恒开（`thinking.type`）；K2.6 开关+effort；
  - OpenAI gpt-5.x：`reasoning_effort` 按模型收窄（minimal/low/medium/high 底座，5.1+ 加 none，5.2+ 加 xhigh）。
- **关键洞察**：国内三家旗舰原生档位是 `low/high/max`，没有 `medium`——硬归一化成固定三档会丢信息。档位词汇表必须随模型走。
- **采纳决策**：方案 A——手写预设目录（Cherry Studio 式）+ 其 `ReasoningControl` 精髓子集 + 4 种 wire 方言映射层。不采纳：全量分层 registry（为不存在的场景买单，工程量 2~3×）、vendor models.dev 快照（6MB、质量参差、与「精选」诉求相悖）。

## 1. 范围

**做**：预设目录与种子、三列 DB 迁移、resolve 链扩展、AGENT_CONFIG → 请求体的 thinking 注入（四方言）、三处 UI、配套测试、`model-catalog.ts` 旗舰缺位补齐。

**不做（明确出界）**：

- 运行时目录刷新 / models.dev 拉取（目录随版本发布，用户覆盖列兜底）；
- 按端点（endpoint）差异化 reasoning 契约（Cherry 的 `reasoningContracts[EndpointType]`，我们单端点用不上）；
- effort 词典就近匹配阶梯（切模型时直接回退默认档）；
- budget 滑杆 UI（Anthropic 暴露为三档下拉，wire 层映射 budget_tokens）；
- 温度 / top_p 等其他采样参数配置（后续另立项）。

## 2. 预设目录

新增 `electron/src/main/llm/provider-presets.ts`（手写静态目录，随版本发布）：

```typescript
/** 思维模式 wire 方言：决定请求体注入格式（§5.2 映射表） */
export type ThinkingWire = 'toggle' | 'toggle-effort' | 'effort' | 'anthropic-budget';

export interface ProviderPreset {
  key: string;              // 'zhipu' | 'deepseek' | ...（全小写，唯一）
  name: string;             // 展示名（如「智谱 GLM」）
  baseUrl: string;
  platform: ProviderPlatform;
  /** 供应商级默认方言；模型可用 thinkingWire 覆写（K3 类混供场景） */
  thinkingWire: ThinkingWire;
  docsUrl?: string;         // 控制台/API Key 入口（UI 引导链接）
  /** 聚合/本地商：无预设模型，创建后引导「获取模型列表」 */
  fetchListHint?: boolean;
  models: PresetModel[];
}

export interface PresetModel {
  id: string;               // 'glm-5.3'
  contextWindow: number;    // token
  outputTokens: number;     // token
  /** 能力词汇表（Cherry Studio ReasoningControl 精髓子集） */
  reasoning:
    | { kind: 'none' }
    | { kind: 'toggle' }
    | { kind: 'effort'; values: readonly string[]; default: string };
  /** 覆写供应商级方言（缺省继承）——同一供应商混供 toggle-only 与 effort 模型时使用 */
  thinkingWire?: ThinkingWire;
}
```

### 2.1 收录清单（15 家）

| 类别 | key | baseUrl | 方言 | 预设模型 |
|---|---|---|---|---|
| 国内直连 | `zhipu` | `https://open.bigmodel.cn/api/paas/v4` | `toggle-effort` | glm-5.3 / glm-5.2 / glm-4.7 / glm-4.6 / glm-4.5 / glm-4.5-air |
| | `deepseek` | `https://api.deepseek.com` | `toggle-effort` | deepseek-v4-pro / deepseek-v4-flash / deepseek-chat / deepseek-reasoner |
| | `moonshot` | `https://api.moonshot.ai/v1` | `toggle-effort` | kimi-k3（effort 覆写）/ kimi-k2.7-code / kimi-k2.6 / kimi-k2 |
| | `dashscope` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 实现期核对 | qwen 旗舰系（实现期按百炼清单核对） |
| | `volcano-ark` | `https://ark.cn-beijing.volces.com/api/v3` | 实现期核对 | doubao 旗舰系（实现期核对） |
| 国际直连 | `openai` | `https://api.openai.com/v1` | `effort` | gpt-5.2 / gpt-5.1 / gpt-5-mini / gpt-4.1 / gpt-4o |
| | `anthropic` | `https://api.anthropic.com` | `anthropic-budget` | claude-opus-4.x / sonnet-4.x / haiku-4.x |
| | `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | 实现期核对 | gemini 当前旗舰（实现期核对） |
| | `xai` | `https://api.x.ai/v1` | `effort` | grok 系（实现期核对） |
| | `mistral` | `https://api.mistral.ai/v1` | `effort` | mistral / magistral 系（实现期核对） |
| | `groq` | `https://api.groq.com/openai/v1` | `effort` | 推理型开源模型（实现期核对） |
| 聚合/本地 | `openrouter` | `https://openrouter.ai/api/v1` | `effort` | 无，`fetchListHint` |
| | `siliconflow` | `https://api.siliconflow.cn/v1` | `effort` | 无，`fetchListHint` |
| | `ollama` | `http://localhost:11434/v1` | `toggle` | 无，`fetchListHint` |
| | `lmstudio` | `http://localhost:1234/v1` | `effort` | 无，`fetchListHint` |

「实现期核对」指：schema 已定，模型清单/方言取值在实施时按当期官方文档逐条查证后填入（测试强制非空合法，见 §9），不属于未决设计。

### 2.2 种子语义

从预设创建供应商时（`provider.create({..., presetKey})`）：

1. `model_providers` 写入预填值 + `preset_key`；
2. 预设 `models` 逐条种子写入 `provider_models`（**全部 enabled**），复用现有 `addModel` 的 `INSERT OR IGNORE` 幂等语义——不覆盖用户已有行；
3. 上下文窗口：种子行 `context_window` 列**留 NULL**（走预设表 resolve，保持「用户覆盖才落列」语义）。

## 3. 数据模型与迁移

三个新列，均可空，老数据零破坏（migration v31）：

```
model_providers   + preset_key    TEXT NULL
provider_models   + thinking_json TEXT NULL
agent_definitions + thinking_json TEXT NULL
```

`thinking_json` 统一形状（两处同构）：

```typescript
interface ThinkingConfig {
  mode: 'auto' | 'off' | 'on';
  /** mode='on' 且模型 kind='effort' 时必填，取值 ∈ 模型 values；其余为 null */
  effort: string | null;
}
```

- `auto`：不发任何 thinking 参数（= 厂商默认行为）；
- `off`：显式关闭（toggle / toggle-effort 方言发 `thinking: {type:'disabled'}`；effort / anthropic-budget 方言不发参数）；
- `on`：开启；effort 模型必须带档位，toggle 模型 `effort: null`。

`model_providers.preset_key`：来源预设标识。用途：预设选择器「已添加」徽标（按 key 判重）。用户改过 name/baseUrl 不影响（key 不变）。

## 4. resolve 链（单点定型，沿用 §2.3 现有模式）

```
上下文窗口：provider_models.context_window（用户覆盖）
          → 预设模型表（presetKey + modelId 命中）
          → 正则目录 model-catalog（platform + 正则）
          → null（未知，RuntimeConfig 0=未知 fail-safe）

思维配置：agent_definitions.thinking_json（agent 覆盖）
        → provider_models.thinking_json（模型级默认）
        → { mode: 'auto' }（缺省）

能力词汇表：预设模型表 → 正则目录 → { kind: 'none' }
```

- 同一模型数字在预设表与正则目录两处出现时，**预设表优先**；正则目录只服务自定义供应商与拉取的未知模型；
- `model-catalog.ts` 同步升级：条目结构扩为 `{ platform, pattern, limits, reasoning }`（`reasoning` 同 `PresetModel['reasoning']` 形状），并补旗舰缺位（glm-5.x 1M / deepseek-v4 1M+384K / kimi-k3 1M 等）；现有 `resolve-model-limits.test.ts` 扩展；
- `buildSpawnOpts`（`spawn-helpers.ts`）在 `resolveModelLimits` 旁新增 `resolveThinkingConfig(def, provider)`：解析方言（预设 `thinkingWire`，按模型覆写；自定义供应商按 platform 兜底 `effort` / `anthropic-budget`）+ 生效配置 + 能力词汇表，产出随 `AGENT_CONFIG` 定型：

```typescript
/** AGENT_CONFIG 新增字段（AgentRuntimeOpts 同步） */
thinking?: {
  wire: ThinkingWire;
  kind: 'none' | 'toggle' | 'effort';
  mode: 'auto' | 'off' | 'on';
  effort: string | null;            // 已钳制：越界回退模型 default
  values: readonly string[];        // 空 = 非 effort
}
```

spawn 时点快照，与现有 contextWindow 语义一致；之后改模型级配置不影响已 spawn 的 agent（下次 spawn 生效）。

## 5. 请求注入与 wire 方言

### 5.1 传递路径

```
buildSpawnOpts → resolveThinkingConfig
  ↓ AGENT_CONFIG.thinking 定型
runtime-entry runChatLoop
  ↓ createLLMProvider({ baseUrl, apiKey, model, platform, thinking })
OpenAIProvider / AnthropicProvider 实例持有
  ↓ 构建请求体时按方言注入（流式/非流式一致）
```

**注入点选实例级而非每调用级**：thinking 随 AGENT_CONFIG 在 spawn 时定型（与 contextWindow 同语义），放 `createLLMProvider` 配置即可；`generateLlmTitle` / 记忆提取等辅助调用点不传 thinking（= auto），零波及。

### 5.2 方言 × mode 映射表（请求体注入的唯一真相源）

| 方言 | `off` | `on`（toggle） | `on` + effort |
|---|---|---|---|
| `toggle` | `thinking: {type:'disabled'}` | `thinking: {type:'enabled'}` | — |
| `toggle-effort` | `thinking: {type:'disabled'}` | `thinking: {type:'enabled'}` | `thinking: {type:'enabled'}` + `reasoning_effort: '<档>'` |
| `effort` | 不发参数 | — | `reasoning_effort: '<档>'` |
| `anthropic-budget` | 不发 thinking | `thinking: {type:'enabled', budget_tokens}` | 同左（档位→budget 阶梯） |
| 任何方言 × `auto` | 不发任何参数（厂商默认） | | |

Anthropic 档位映射：Claude 模型在目录暴露 `effort: ['low','medium','high']`（默认 `medium`），wire 层映射 `budget_tokens` 阶梯——实现期按各模型 `maxOutput` 定阶梯值（如 8192 / 16384 / 32768，上限受模型输出封顶），写入目录条目注释。

### 5.3 解析侧（展示思维链）

OpenAI 方言 `reasoning_content` → `thinking` delta 已存在（`llm-provider.ts:480`），GLM / DeepSeek / Kimi / 聚合商全走这条路，零改动。实现期核对两点（测试覆盖）：

1. AnthropicProvider 是否解析 `thinking_delta`（缺则补）；
2. Kimi K3 流式思维链字段名是否为 `reasoning_content`（如不同，解析器加别名）。

## 6. IPC 契约（双端对齐，momo-boundary-rules 管辖）

| 通道 | 变更 |
|---|---|
| `provider:listPresets` | **新增**，返回只读预设目录（无密钥），对话框渲染用 |
| `provider:create` | 入参加 `presetKey?: string`（写 `preset_key` + 种子模型） |
| `provider:setModelThinking` | **新增**，`(providerId, modelId, config | null)` |
| `provider:listModels` | 返回条目扩展**只读 `reasoning` 能力字段**（服务端 resolve：预设表 → 正则目录；客户端不重复实现 resolve 链——单一真相源） |
| agent 定义 CRUD | 读写透传 `thinkingJson` |

`renderer/src/ipc/types.d.ts` 与 electron 端结构对齐（`ProviderModel` / `ModelProvider` / agent 定义类型同步扩展），两个 workspace 都过 typecheck；`electron/src/preload/index.ts` 桥接新通道。

## 7. UI

### 7.1 ProviderDialog：预设优先两段式

打开 → 第一步**预设选择**：卡片网格（品牌名 + 一句话描述 + 「已添加」徽标按 `preset_key` 判重；聚合/本地商带「创建后拉取模型列表」提示）→ 点选 → 第二步**表单**：名称/BaseURL/平台预填（可改——智谱 coding 套餐端点等变体靠此兼容），填 API Key + 设默认 → 提交 `provider.create({..., presetKey})`。底部「自定义供应商」入口 → 现有手填表单原样保留。

### 7.2 ProviderModelList 行内 thinking 控件

现有布局（开关 + modelId + 窗口输入 + 删除）不动，新增一列 thinking 控件，仅当 `reasoning.kind ≠ 'none'` 时渲染：

- toggle 模型：三态「默认 / 关 / 开」；
- effort 模型：三态 + 档位下拉（选项即该模型 `values`，「开」时才显示）；
- 写入 `provider.setModelThinking`。

上下文窗口输入 placeholder 从「自动」升级为显示 resolve 后有效值（如 `200K`，来源可辨）——polish 项，最后做。

### 7.3 agent 编辑器覆盖控件

`ProviderModelPicker`（`CreateAgentDialog` / `DefinitionEditor` / `MemberEditDialog` 三处共用）选中模型后紧邻渲染「思维模式：跟随模型设置 / 关闭 / 开启(+档位)」；选中模型能力为 `none` 时整块隐藏。存 `agent_definitions.thinking_json`，NULL=跟随。

设计系统约束：语义 token、`components/ui/` 原子件、lucide-react 16px / stroke 1.75、状态色走 `lib/task-status.ts`，禁 emoji 图标。

## 8. 错误处理

- **effort 越界钳制**：resolve 时 `effort ∉ values` → 回退模型 `default` + `logger.warn`（单点钳制，请求层不再校验——定型即正确，符合「跨模块 ID 单点生成沿线透传」红线）；
- **thinking 参数被网关拒绝**（4xx）：不自动降级重试——错误沿现有错误路径透传到会话气泡（硬编码吞状态是 P0 教训）；
- **预设种子冲突**：`addModel` 现有 `INSERT OR IGNORE` 幂等语义复用，不覆盖用户已有配置；
- **migration 兼容**：三列全部可空，老行读取时 `thinking_json` NULL → `auto`、`preset_key` NULL → 自定义供应商，行为与现状完全一致。

## 9. 测试

| 层 | 文件（按仓库存放规范） | 用例 |
|---|---|---|
| electron 单测 | `electron/tests/llm/provider-presets.test.ts` | 数据完整性：key 唯一、URL 合法、模型 id 供应商内唯一、`contextWindow > 0`、`default ∈ values`、`fetchListHint` 商 `models` 为空、方言枚举合法 |
| | `electron/tests/agent/resolve-thinking.test.ts` | 四级 fallback（agent → 模型级 → auto）、effort 越界钳制、三种 kind、模型级方言覆写、自定义供应商 platform 兜底 |
| | `electron/tests/agent/llm-provider.test.ts`（扩展） | **wire 映射快照测试**：mock fetch 断言四种方言 × 三种 mode 的请求体（含 K3 覆写场景）；Anthropic budget 阶梯；`reasoning_content` 解析回归 |
| | `electron/tests/agent/resolve-model-limits.test.ts`（扩展） | 预设表优先于正则目录；旗舰新条目命中 |
| | migration 测试 | 三列可空、老行零破坏、种子幂等 |
| renderer 单测 | `renderer/src/components/settings/ProviderDialog.test.tsx`（扩展） | 预设流（选卡 → 预填 → 提交带 presetKey）；自定义路径回归；已添加徽标 |
| | `ProviderModelList.test.tsx`（扩展） | thinking 控件三态交互、none 时隐藏、档位下拉随 values |
| | `ProviderModelPicker.test.tsx`（扩展） | agent 覆盖控件显隐 + 提交形状 |
| e2e（可选） | `tests/e2e/*.spec.ts` | 设置页从预设创建供应商 → 种子模型出现 |

Mock 保真按 `momo-test-rules`：IPC mock 形状与 `types.d.ts` 对齐、请求体断言用真实序列化产物、错误路径专项用例（越界 effort / 网关 4xx 透传）。

## 10. 实施切片建议（writing-plans 输入）

1. **P1 数据层**：`provider-presets.ts` + `model-catalog.ts` 升级 + migration v31 + resolve 链两函数 + electron 单测；
2. **P2 注入层**：`AgentRuntimeOpts` / `AGENT_CONFIG` 透传 + `createLLMProvider` 扩展 + 两 Provider 请求体注入 + 解析侧核对 + wire 快照测试；
3. **P3 UI**：IPC 通道 + `ProviderDialog` 预设两段式 + 模型行 thinking 控件 + agent 覆盖控件 + renderer 单测；
4. **P4 打磨**：窗口 placeholder 有效值显示、e2e（可选）。

每片独立可验收；P1/P2 顺序依赖，P3 依赖 P1（IPC 返回能力字段），P4 收尾。

## 附录 A：厂商参数查证记录（2026-09-09）

| 模型 | 请求参数 | 上下文 / 输出 | 来源 |
|---|---|---|---|
| GLM-5.2 / 5.3 | `thinking: {type: enabled\|disabled}` + `reasoning_effort: low\|high\|max`（默认 max） | 1M / 128K | docs.bigmodel.cn/cn/guide/models/text/glm-5.2 |
| GLM-4.5 ~ 4.7 | 仅 `thinking.type`（无 effort） | 128K~200K / 96K | 同上 + Cherry Studio zhipu creator |
| DeepSeek V4 | `thinking: {type}` + `reasoning_effort: low\|high\|max` | 1M / 384K | api-docs.deepseek.com |
| Kimi K3 | 顶层 `reasoning_effort: low\|high\|max`（默认 max） | 1M | platform.moonshot.ai/docs/quickstart |
| Kimi K2.7 Code | `thinking.type` 恒开 | 256K / 32K | 同上 |
| Kimi K2.6 | `thinking.type` + `reasoning_effort` | 256K | 同上 |
| OpenAI gpt-5.2+ | `reasoning_effort: none\|low\|medium\|high\|xhigh`（按模型收窄） | 400K | platform.openai.com + opencode transform.ts |
| Anthropic claude-4.x | `thinking: {type: enabled, budget_tokens}` | 200K~1M | docs.anthropic.com |

外部实现参考：

- opencode：github.com/sst/opencode `packages/opencode/src/provider/{provider,transform}.ts`
- Cherry Studio：github.com/CherryHQ/cherry-studio `packages/provider-registry/src/{schemas,reasoningProfiles,creators,providers}`
- models.dev：github.com/sst/models.dev（TOML 源）+ models.dev/api.json
