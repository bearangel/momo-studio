# Task 1 报告：窗口元数据全链（compaction-overhaul）

- **状态**：DONE
- **分支**：`feat/compaction-overhaul`（不 push 不 rebase）
- **Base**：`e1e602d`（spec/plan doc commit）
- **Commits**：
  - `453d227` feat: 模型窗口元数据全链——provider_models.context_window + 内置目录 + spawn 透传（spec §2）（23 文件，+1008/−48）
  - `36b8989` test: parseConfig 窗口字段缺失/非法回退 0 专项用例（旧载荷兼容 + fail-safe 锁）

## TDD 证据

1. **红**（08:49，实现前）：`model-catalog.test.ts` + `migration-v30.test.ts` + `resolve-model-limits.test.ts` 三文件首跑 **12 failed | 1 passed**——失败全部源于模块/迁移/导出不存在（model-catalog 模块缺失、context_window 列 SQLITE_ERROR、resolveModelLimits 未导出）。
2. **绿**（08:51–08:53）：migration v30 + model-catalog.ts + resolve 链 + spawn 透传落地后 24/24；随后 provider-models.test.ts 扩展（5 新用例红→绿）与 ProviderModelList.test.tsx 扩展（4 新用例红→绿）。
3. **回归**：`buildSpawnOpts` async 化后 3 个既有 spawn 测试文件（16 用例）先红（Promise 未 await）→ 机械适配（`await` + `async it`）→ 绿，**断言零弱化**。
4. **补充专项**（self-review 发现）：parseConfig 旧载荷缺字段/非法值回退 0 的错误路径无专项用例（违反 momo-test-rules 第 3 条）→ 补 1 用例（`36b8989`）。

## 验证结果

| 项 | 结果 |
|---|---|
| `pnpm typecheck`（electron + renderer） | 双 clean |
| electron 全量测试 | 203 files / **1680 passed**（含 v30 迁移后全库重建） |
| renderer 全量测试 | 107 files / **1012 passed** |
| renderer ESLint | clean |
| electron ESLint | 1 error（`ipc.handlers.ts:58` 未使用 import `AgentDefinition`）——**预存债务**（stash 验证：剔除本任务改动后依旧报），不属本任务范围，未混入修复 |

## 改动清单

**electron 主进程**
- `storage/migrations/index.ts`：v30（当前最大 29 +1）——`provider_models.context_window INTEGER`（NULL=未知）+ `session_compactions`（session_id PK / FK ON DELETE CASCADE），SQL 逐字取自 spec §2.1
- `llm/model-catalog.ts`（新建）：`ModelLimits` 接口 + `lookupModelLimits(platform, modelName)` 首序匹配；**22 条目**（openai 协议 19：gpt-4o/4.1/5、o1/o3/o4、glm-4.x、deepseek、qwen、kimi-k2、gemini-2.x；anthropic 协议 7：claude-3.5/3.7/4 系含 1M 变体；总条目 22 ≥ 15）；每分组注明来源与查证日期；返回副本防污染
- `agent/spawn-helpers.ts`：`resolveModelLimits(providerId, modelId): Promise<ModelLimits | null>`（ghost provider→null；用户列非 NULL 且 >0 覆盖窗口、outputTokens 沿用目录、目录无条目则 0）；`buildSpawnOpts` 改 **async** 并注入 `contextWindow/outputTokens`（null→0）
- `agent/runtime-config.ts`：`AgentRuntimeOpts.contextWindow?/outputTokens?`、`RuntimeConfig.contextWindow/outputTokens`（必填，0=未知）、`parseConfig` 缺省/非法回退 0（旧 AGENT_CONFIG 兼容）
- 5 个生产调用点加 `await`：`start-chain.ts`、`init-runtime.ts`、`agent/ipc.handlers.ts` ×2、`workspace/ipc.handlers.ts`（全部已在 async 上下文）
- `agent/provider-crud.ts`：`ProviderModel(Row)` 加 context_window/contextWindow 映射 + `setProviderModelWindow`（null=清除；非正整数源头 throw；行不存在 no-op，对齐 setProviderModelEnabled）
- `agent/provider-ipc.ts` + `preload/index.ts`：`provider:setModelWindow` 通道（preload 以 ApiSurface 类型强制对齐）

**renderer**
- `ipc/types.d.ts`：`ProviderModel.contextWindow: number | null` + provider 面 `setModelWindow`（双端类型同步）
- `components/settings/ProviderModelList.tsx`：行内 `ModelWindowInput` 子组件（text+inputMode=numeric；空→null 回退目录、非法→回退显示不提交、Enter/blur 提交、错误内联展示；key 含 contextWindow 实现服务端值变化时自愈重建）；语义 token 合规

**测试**（4 新文件/区块 + 5 文件适配）
- `tests/llm/model-catalog.test.ts`（11 用例：精确/日期变体/1M 顺序敏感/glm 模糊/平台隔离/副本防污染/覆盖面抽查 24 模型）
- `tests/storage/migration-v30.test.ts`（4 用例：列可写读+缺省 NULL/建表+upsert/CASCADE/空库升级）
- `tests/agent/resolve-model-limits.test.ts`（10 用例：优先级链 6 + spawn 透传线协议往返 3 + 旧载荷 fail-safe 1）
- `tests/agent/provider-models.test.ts` +5（写读往返/null 清除/非法拒绝且不污染/ghost no-op/缺省 null）
- `ProviderModelList.test.tsx` +4（写入/清空 null/非法不提交回显/失败内联错误）
- 适配：`spawn-helpers-platform/-tools`、`dispatch-snapshot`（async 化）、`DefaultModelSettings.test`、`ProviderModelPicker.test`（fixture 加 contextWindow）

## 裁定记录

1. **`buildSpawnOpts` 改 async**：契约要求 `resolveModelLimits` 返回 `Promise`（下游任务消费的签名），brief 又要求 buildSpawnOpts 调用它 → 全链 async 是唯一不产生「同步内核 + async 包装」双 API 的做法。5 个生产调用点全部已在 async 上下文，改造是机械加 await。
2. **migration 版本 = 30**：migrations/index.ts 当前最大 29（v29 任务执行运行时）。
3. **写通道新增而非复用**：既有 provider_models 写通道（addModel/setModelEnabled/removeModel）无 per-column 更新面 → 新增 `provider:setModelWindow`（brief 预案路径）。
4. **目录窗口值**：以各厂商公开文档为准 + 来源注释（查证日期 2026-09-09）。训练截止后的新模型（如 glm-4.7）落到 glm-4 通配条目 128k——低估窗口只会让 auto 压缩更早触发（安全方向），且用户列是精修通道。qwen-max 取历史档 32k（新档请用户列覆盖），注释已注明。
5. **窗口输入用 `type="text" inputMode="numeric"`**：number input 对非法输入的浏览器级 value sanitization（'abc'→''）会使「清空=回退目录」与「输入垃圾」不可区分，text 输入 + 手动解析可区分两者。
6. **预存 lint 债务不动**：`ipc.handlers.ts` 未使用 import 非本任务引入（stash 验证），避免混入无关修复。

## 契约自查（momo-boundary-rules）

- 新 IPC 通道 `provider:setModelWindow`：types.d.ts 声明 → preload 绑定 → provider-ipc handler → provider-crud 实现，四点同 commit 成对；契约测试双端锁形状（electron 5 用例 + renderer 4 用例）。
- AGENT_CONFIG 新字段 `contextWindow/outputTokens`：生产者 buildSpawnOpts → JSON 线协议 → 消费者 parseConfig，resolve-model-limits.test.ts 的 hopWire 往返用例锁死；旧载荷（无字段）回退 0 有专项用例。
- 跨 workspace 改动双 typecheck clean。

## Concerns（移交后续任务）

- **T5 消费提示**：`config.contextWindow === 0` 即 fail-safe 跳过 auto 压缩（spec §2.4）；输出未知（outputTokens=0）时阈值公式用 `Math.max(0, COMPACTION_BUFFER_TOKENS)` 兜底。
- **T4 消费提示**：`session_compactions` 表已就绪（covered_until 语义：已被摘要覆盖的最后一条消息 createdAt 毫秒）。
- 目录条目值建议 macOS 主机验收时抽查（尤其 glm-4.7 通配与 deepseek-reasoner 输出上限），有出入直接改用户列即可，无需改码。
