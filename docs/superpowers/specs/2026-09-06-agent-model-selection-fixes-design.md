# Agent 模型选择与成员管理修复设计

- 日期：2026-09-06
- 状态：已获用户批准（brainstorming 逐节确认）
- 范围：renderer 侧修复（主进程零改动）
- 上游依据：v2.0.0 五期重构收官后的用户验收反馈（3 个 agent 功能缺陷）

## 1. 背景与问题

用户报告 v2 当前版本 3 个 agent 功能缺陷。经 codegraph 溯源，三者均为 **renderer UI 缺口**——所需后端能力（IPC / 存储 / 校验链）全部已存在：

| # | 缺陷 | 现状事实（代码证据） |
|---|------|---------------------|
| 1 | 创建 Agent 时模型名需手工填写，未按供应商联动提供选择 | `CreateAgentDialog.tsx` 的「模型名」为手填 `Input`，仅靠已 deprecated 的 `provider.defaultModel` 列快填；`provider_models` 表、`provider.listModels/fetchModels/addModel` IPC 均已存在且 `DefaultModelSettings` 已示范「供应商→模型下拉联动」模式 |
| 2 | agent 无法更换模型供应商和模型；成员编辑弹窗不应再提供 key 变更 | 成员行「编辑」→ `MemberEditDialog` 仅有 API Key override + 能力覆盖；支持改模型的 `DefinitionEditor` 是孤儿组件（生产代码无挂载点，仅测试引用）；后端 `updateAgentDefinition` 支持 `modelProviderId/modelName`，IPC `agent.updateDefinition` 通道已注册（types.d.ts:884） |
| 3 | agent 移出工作空间后无任何途径重新添加，只能新建 | `MembersPanel` 仅有「+ 创建 Agent」入口；`agent.store.addMember` → IPC `agent:addMember` → 后端 `addMember`（含同 ws 同 def 防重复）全链路存在，仅缺选择 UI |

## 2. 需求决策记录（用户澄清结果）

1. **Bug 1 范围**：仅改「创建 Agent」弹窗的模型名字段。设置→模型服务页的「手动添加」保留现状（拉取 + 手填兜底）。
2. **Bug 2 编辑入口**：资源库与成员编辑弹窗**两处都加**换模型入口。
3. **key 字段处置**：仅 UI 移除成员编辑弹窗的 API Key override 区；后端 override 机制（keychain + DB 标志位 + IPC 通道）完整保留，历史数据不受影响。
4. **Bug 3 列表范围**：builtin（系统预置）+ custom（自定义）全量定义合在一个列表中选择。
5. **实现载体**：新共享组件 `ProviderModelPicker`（方案 A）；`DefaultModelSettings` 本次不迁移。

## 3. 设计

### 3.1 共享组件 `ProviderModelPicker`

```
renderer/src/components/agent/ProviderModelPicker.tsx（新增）
```

受控组件、数据自理，三个弹窗（创建 Agent / 成员编辑 / DefinitionEditor）统一接入：

```tsx
interface Props {
  providerId: string;                          // 当前供应商（受控）
  modelId: string;                             // 当前模型（受控）
  onProviderChange: (id: string) => void;
  onModelChange: (id: string) => void;
  disabled?: boolean;
}
```

行为约定：

- **供应商 Select**：复用 `ui/Select` 原子件；保留「请选择...」空选项与 `（默认）` 徽标（与现 `CreateAgentDialog` 一致）。
- **模型 Select**：数据 = `ipc.provider.listModels(providerId)` 过滤 `enabled === true`，按 `addedAt` 升序。
- **联动重置**：供应商切换时组件自动补发 `onModelChange('')` 清空模型（父组件只需正常响应两个回调，无需自行判断联动）；当前 `modelId` 不在模型列表中时下拉显示空选项。
- **空态内嵌拉取**：选中供应商但模型列表为空时，模型下拉区显示「该供应商暂无模型」+ 行内「拉取模型列表」按钮：`provider.fetchModels(providerId)` → 逐个 `provider.addModel(providerId, id)`（幂等）→ 重新 `listModels` 刷新。拉取失败显示行内 error 文案（不 alert、不关闭弹窗）。逻辑模式与 `ProviderModelList.handleFetchAll` 一致。
- 彻底不再读取 deprecated 的 `provider.defaultModel` 列（本组件是三个表单的唯一模型数据入口）。

### 3.2 Bug 1：创建 Agent 弹窗

`CreateAgentDialog`：

- 「模型供应商*」Select 与「模型名」Input 两行 → 替换为一个 `ProviderModelPicker`。
- 删除 `handleProviderChange` 中的 `defaultModel` 快填逻辑。
- 校验：`!providerId || !modelId` → 错误文案「请选择模型供应商与模型」。
- 提交链（`agent.createCustom` 入参结构）不变。

### 3.3 Bug 2：两处编辑入口 + key 区移除

**a) 资源库入口**：`ResourceDetail` 对 `type === 'agent' && source === 'custom'` 的资源增加「编辑」动作；`ResourceLibraryView` 持弹窗状态，挂载 `DefinitionEditor mode='edit' def={...}`（恢复该组件的生产挂载点）。builtin agent 不提供编辑（定义不可改）。

**b) 成员编辑弹窗** `MemberEditDialog`：

- **移除 API Key 区**：key 输入框、`keyDirty` 逻辑、`hasApiKeyOverride` 提示条、`updateMemberApiKey` 调用全部删除；保存链不再触 keychain。
- **新增「模型」区**：`ProviderModelPicker`，初值 = `def.modelProviderId` / `def.modelName`；区头固定提示「定义全局共享，模型修改对所有工作空间的同名 agent 生效」。
- 保存链：模型有变化时先调 `ipc.agent.updateDefinition({ id: def.id, modelProviderId, modelName })`，再走既有 `setMemberDeltas` 链。
- `pendingRestart` 触发条件：模型变更 ∥ 能力 deltas 变更（沿用现有「立即重启 / 稍后」交互，运行中的 agent 重启后新模型生效）。

**c) DefinitionEditor** edit 模式的模型字段同步替换为 `ProviderModelPicker`（修复编辑侧的手填问题，与创建侧同构）。

### 3.4 Bug 3：添加 Agent 弹窗

`MembersPanel` 头部「+ 创建 Agent」旁新增「+ 添加 Agent」→ 新组件 `AddAgentDialog`：

- 数据：`loadDefinitions()`（全量 builtin + custom）− 当前 workspace 已加入的 def（按 `member.agentDefinitionId` 集合过滤后仅显示可添加项）。
- 行结构：`iconEmoji` + 名称 + source 徽标（系统预置 / 自定义）+ 描述截断 + 「加入」按钮。
- 加入动作：`addMember(workspace.id, def.id)` → 成功后该行从列表移除（store 已自动追加 `members`）。
- 错误处理：`agent:addMember` 的 UNIQUE 约束竞态（理论上被前端过滤防住）→ 弹窗内行内错误提示并刷新列表。
- 空态：「所有 agent 均已加入本工作空间」。

## 4. 错误处理汇总

| 场景 | 处理 |
|------|------|
| `listModels` / `fetchModels` / `addModel` IPC 失败 | `ProviderModelPicker` 行内 error 文案 |
| `agent.updateDefinition` 失败 | `MemberEditDialog` 现有 error 区显示，不关闭弹窗 |
| `agent:addMember` UNIQUE 竞态 | `AddAgentDialog` 行内提示 + 刷新列表 |
| `agent.createCustom` 失败 | 沿用 `CreateAgentDialog` 现有 error 展示 |

## 5. 测试策略

主进程零改动（所有 IPC 已存在且有 electron 侧测试）。renderer 侧：

- **新增**：
  - `ProviderModelPicker.test.tsx`：两级联动、供应商切换重置模型、enabled 过滤、空态拉取链（成功/失败）、受控行为。
  - `AddAgentDialog.test.tsx`：列表过滤（已加入不显示）、source 徽标、加入动作调 `addMember`、空态、UNIQUE 错误兜底。
- **更新**：
  - `CreateAgentDialog.test.tsx`：模型名 Input → ProviderModelPicker 交互；校验文案。
  - `MemberEditDialog.test.tsx`：key 区移除断言；模型区保存链（变化才调 `updateDefinition`）；`pendingRestart` 新触发条件。
  - `DefinitionEditor.test.tsx`：模型字段换组件后的行为。
  - `ResourceLibraryView.test.tsx`：custom agent 编辑入口挂载 `DefinitionEditor`。
- **回归门**：`pnpm typecheck` + renderer vitest 全绿。
- mock 遵循 momo-test-rules：IPC mock 返回结构对齐真实契约（`ProviderModel` / `WorkspaceAgentMember` / `AgentDefinition` 字段齐备）。

## 6. UI 规范遵循

v2.1 设计系统（docs/dev/design-system.md）：语义 token、lucide-react 图标（16px / stroke 1.75）、`ui/Select` / `ui/Input` / `ui/Dialog` / `ui/Button` 原子件优先、禁 emoji 图标（`iconEmoji` 为用户数据豁免）。

## 7. 范围外（Out of Scope）

- `DefaultModelSettings` 向 `ProviderModelPicker` 的迁移收敛（后续独立小改动）。
- 成员级 API Key override 后端机制的下线与数据清理（UI 已隐藏，机制保留）。
- 设置→模型服务页「手动添加」模型入口的改造。
- builtin agent 定义的可编辑化。
