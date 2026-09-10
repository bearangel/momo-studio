# Task 2 报告：纯函数包——token 估算 + 压缩模板 + 序列化

- **状态**：DONE
- **分支**：`feat/compaction-overhaul`（不 push 不 rebase）
- **Base**：`36b8989`（T1 末尾，含 parseConfig fail-safe 专项用例）
- **Commit**：`ded3816` feat: 压缩纯函数包——中文 token 估算/结构化摘要模板/对话序列化（spec §3-4.2）（6 文件 / +697）

## TDD 证据

1. **红**（09:07，三文件首跑）：`Failed Suites 3` ——全部源于目标模块/迁移不存在（`Failed to load url ... Does the file exist?`）。三文件 0 测试启动。
2. **绿**（09:09–09:10）：
   - token-estimate.test.ts 12 用例首跑 11 通过 / 1 失败（自我断言写错数学：把 16 CJK 错算成 26 CJK → 断言 `≥15` 但实现给 11）
   - 修正断言范围（`[10, 12]`）后 12/12 通过
   - 修正点同步加上 CJK 计数的内联注释（数学公式必须明示）
   - prompt.test.ts 15 用例 / serialize.test.ts 10 用例一次绿
3. **最终**：三文件 37/37 全绿。
4. **回归**：`pnpm test` 双 workspace 全量跑通——electron **1718/1718**（+37 本任务新增）、renderer **1012/1012** 零回归。

## 验证结果

| 项 | 结果 |
|---|---|
| `pnpm typecheck`（electron + renderer） | 双 clean |
| electron 新增测试（token-estimate + prompt + serialize） | 37 / 37 passed |
| electron 全量测试 | 206 files / **1718 passed**（含本任务 37 新增） |
| renderer 全量测试 | 107 files / **1012 passed**（零改动） |
| 三个新文件 ESLint | clean |

## 改动清单

**3 个生产模块（纯函数，零 DB/IPC 副作用）**

- `electron/src/main/agent/tools/shared/token-estimate.ts`
  - `estimateTokens(text)`：CJK 字符 ÷1.6 其余 ÷4 向上取整——按 codepoint 单次扫描，范围函数替代 `/g` regex 规避 `lastIndex` 副作用雷
  - `estimateConversation({ system, messages, tools })`：串行累加 system + 每条 message content + assistant 角色 toolCalls.arguments 的 JSON 序列化 + tools 定义的 name/description/inputSchema JSON 序列化
  - 三个 COMPACTION_* 常量：`COMPACTION_BUFFER_TOKENS = 20_000` / `COMPACTION_KEEP_TOKENS = 8_000` / `COMPACTION_MIN_TRIGGER = 4_000`（spec §3 字面值）

- `electron/src/main/compaction/prompt.ts`
  - `buildCompactionPrompt({ conversation, previousSummary })`：五节骨架（目标 / 重要细节 / 工作状态[已完成·进行中·阻塞] / 下一步 / 相关文件）+ 三条规则（terse 要点 / 保留精确标识符 / **勿提及摘要过程本身**）
  - prior 模式额外 `<prior-summary>` 包裹 + 三句合并指令（**冲突以对话为准** / **完成项搬家** / **用户指令与决策必须携带**）——逐字来自 spec §4.1
  - 空节填 `(无)` 避免 LLM 凭空补内容

- `electron/src/main/compaction/serialize.ts`
  - `serializeMessages(messages)`：四条角色映射（`[用户]: / [助手]: / [系统]: / [工具结果]:`），assistant 同时含文本 + toolCalls 时文本在前工具调用在后
  - 工具结果 >2000 字符按**字符数**截断 + `[truncated]` 标记（spec §4.2 + §8 同源）
  - toolCallId 不进入序列化（spec §4.2 未要求）

**3 个测试文件（贴 `electron/tests/` 镜像 `src/` 结构）**

- `tests/agent/tools/token-estimate.test.ts`（12 用例）：四类断言全覆盖 + 空串/空标点边界 + assistant.toolCalls.arguments 计入
- `tests/compaction/prompt.test.ts`（15 用例）：无 prior 5 节 + 子节顺序 + 五节顺序固定 + 规则三条 + 有 prior 5 断言 + 边界（空 conversation / 空 previousSummary / undefined previousSummary）
- `tests/compaction/serialize.test.ts`（10 用例）：四角色映射 + toolCalls 与 tool 结果串联 + 截断边界（>2000 截 / ≤2000 不截）

## 裁定记录

1. **CJK 字符集范围**：采用 `[\u3000-303F \u3040-309F \u30A0-30FF \u3400-4DBF \u4E00-9FFF \uAC00-D7AF \uF900-FAFF \uFF00-FFEF]`——主块 + 扩展 A + 全/半角符号 + 日韩假名。不区分汉字与日韩字符（spec §3 统称「CJK」），按字符总数加权即可。
2. **估计算法用 codepoint 单次扫描，不用 `/g` regex**：`regex.test()` 在循环里会推进 `lastIndex`——曾因未重置导致后续字符漏判。改 codepoint 范围检查后零副作用。
3. **estimateConversation 串行加法**：不引入「消息结构开销」修正项——spec §3 未规定，引入额外项反而偏离审计性。
4. **prior 模式 strict 空字符串判定**：`typeof previousSummary === 'string' && previousSummary.length > 0`——空串与 undefined 一律走无 prior 模式（防御上游误传）。
5. **空节填 `(无)`**：避免 LLM 在空 section 自由发挥；spec §4.1 未明确，但 opencode 原模板同样做法。
6. **prior 模式下 `<conversation>` 也写入**：prior 模式必须把对话一并放入（合并指令「冲突以对话为准」），所以双包裹而非二选一。
7. **toolCallId 不进序列化**：spec §4.2 字面只要求 `[工具结果]:`，调用-结果关联由调用方维护。测试断言 `expect(out).not.toContain('call_abc')` 锁死此约定。
8. **token-estimate 不去 import cycle**：从 `shared/token-estimate.ts` 到 `../../llm-provider.ts` 是单向依赖（import cycle 风险为零）。T3 CompactionService 反向消费这三个纯函数亦无环。

## 契约自查（momo-boundary-rules）

- **T3 / T5 消费面（签名稳定）**：`estimateTokens: (text: string) => number`、`estimateConversation: (input) => number`、`buildCompactionPrompt: (input) => string`、`serializeMessages: (messages: LLMMessage[]) => string`——四个签名无 any/unknown 暴露在公共 API。LLMMessage / LLMToolDef 类型从 `../llm-provider` 单点导入，T3/T5 改 LLMMessage 字段时本任务会编译报错（防止契约漂移）。
- **CONST 透出**：`COMPACTION_*` 三个常量走 named export——T3 / T5 子进程侧可直引同一份常量（避免双份硬编码）。

## Concerns（移交 T3/T4/T5）

- **T3 调用方**：estimateTokens 返回类型为 `number`（运行时为整数，Math.ceil 保证）；如需 TS 类型层面 `integer` 表达，可加 `as number` 断言在调用处收紧——但当前未做以保留纯函数无副作用语义。
- **T3 调用方**：serializeMessages 不输出 system 角色（spec §4.3 走顶层单独提取）；若 T3 想在 prompt 中纳入 system，请单独传入 `buildCompactionPrompt` 的 `conversation`（拼接在前面）或扩展签名。
- **T3 调用方**：buildCompactionPrompt 含五节骨架 `(无)` 占位——LLM 可能不替换占位直接产出含 `(无)` 的「摘要」。如需结构性解析（按节切分），建议 T3 单独加 `parseSummarySections()`（不在本任务范围）。
- **T5 调用方**：prior 模式 strict——空字符串 `previousSummary: ''` 与 `undefined` 等价（都不输出 `<prior-summary>` 块）。子进程路径必须主动传入非空字符串才走 prior 合并。
- **T6 调用方**：estimateConversation 当前串行累加；千级 messages 数组理论有性能压力，但 spec §3 未提性能，纯函数 OK。若实测瓶颈出现可改为单次扫描。
- **macOS 主机验证**：建议抽查 estimator 对真实中文长对话的偏差（spec 给的 ÷1.6 系数源自 opencode 调研；本机差异若 >30% 可微调）。

## 后续任务依赖就绪

- ✅ T3 主进程 CompactionService 可直接消费三个纯函数（签名稳定）
- ✅ T4 getConversationContext 收缩 + 摘要注入 + prune 可消费 `serializeMessages` 拉取映射层
- ✅ T5 子进程 compact 工具 + auto 阈值可直接消费 `estimateConversation` + `COMPACTION_*` 常量
