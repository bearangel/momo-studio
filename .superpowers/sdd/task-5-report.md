# Task 5 报告：子进程接线——compact 工具改造 + auto 阈值 + 双态续行（spec §6）

- **Status**: DONE
- **Commit**: `99a6cb6`（分支 `feat/compaction-overhaul`，未 push）
- **测试**: TDD 先红后绿——新 compact-auto.test.ts 5 用例（红 4/5：mock 零调用 + 断言缺失）+ compact-wrapup 6 用例适配（红 6/6）+ copy-neutral 适配（红 1）→ 实现后全绿；electron 全量 210 文件 / 1758 测试全绿；renderer 107 文件 / 1012 全绿（保险跑）；typecheck 双 clean；ESLint 改动文件零告警；LSP 零诊断

## 改动

| 文件 | 内容 |
|---|---|
| `electron/src/main/agent/compaction-ipc.ts`（新） | requestCompaction / handleCompactionResultIpc / 超时常量自 runtime-entry 迁出（纯移动，零行为变化）——独立模块使其成为可 vi.mock 的 IPC 副作用边界 |
| `electron/src/main/agent/runtime-entry.ts` | ① re-export 维持 ipc-bridge.test.ts 既有导入路径；② `runCompaction(coveredUntil)` 闭包（compact 工具与 auto 阈值共用）：尾部选择（从尾向前按 KEEP 累计，锚点=最后一条真实 user 消息未覆盖前预算不截断）→ head 序列化（跳过合成摘要条）→ IPC → 成功替换 `[system, user(摘要+双态尾部指令), ...尾部 verbatim]` + 置 wrapUpMode + refreshSystem，失败 messages 原样返回 ok:false；③ compact 分支重写：note 可选参数、成功回执「N→1+尾部 M 条」三态文案、失败报错可重试；④ auto 阈值块（每轮 refreshSystem 后）：窗口>0 且非收尾且非 task 域，est(system+messages+tools) > window−max(output,BUFFER) 且 > MIN_TRIGGER → 机械压缩，有挂靠注入 synthetic 续行条、无挂靠 wrapUpMode 收口，失败 warn 不阻塞；⑤ >30 注入块删除 |
| `electron/src/main/agent/builtin-tools.ts` | compact 定义替换：summary 参数删除改可选 note（仅入审计），描述改「专用链路生成结构化摘要，无需你撰写总结」 |
| `electron/src/main/agent/prompt-hints.ts` | buildCompactSuggestHint 删除（auto 阈值取代自觉提示）；formatDispatchHint 内 compact 提示同步去「≥200 字符总结」旧契约（同文件引用清理） |
| `electron/tests/agent/compact-auto.test.ts`（新） | fake-LLM harness + mock requestCompaction（IPC 边界）：(a) 超阈值触发且 head 序列化含大消息/跳过 prior 条/尾部 verbatim 保留 (b) 无挂靠→wrapUpMode（首轮 tools undefined）(c) 有挂靠→synthetic 续行 + 工具可用 (d) contextWindow=0 零调用 (e) auto 失败不阻塞回合（spec §9 错误路径专项） |
| `electron/tests/agent/compact-wrapup.test.ts` | 六用例适配：新 schema（note/空参数）、mock requestCompaction 固定摘要、历史构造 >KEEP 预算大消息使 head 非空；断言意图不弱化——双态/收尾/恰 1 条 role=tool/三态 tool_result 文案/steer 恢复/task 域中性 全保留；(f) 改锁 IPC 失败路径（报错回填 + messages 原样 + 不置收尾） |
| `electron/tests/agent/copy-neutral.test.ts` | >30 建议锁退役，改锁新工具描述「无需你撰写总结」+ schema 无 summary 义务参数 + note 可选 |

## T4 审查交接落实（双跳过点）

`isSyntheticUserMessage`（3 前缀：`[此前对话压缩摘要]` / `[历史压缩摘要]` / `[系统] 上下文已自动压缩`）单点定义、两个消费点共用：
1. **head 序列化跳过**——防 prior 双重计入（主进程已从 DB 读 prior 合并），compact-auto (a) 锁定 prior 文本不入 conversation；
2. **尾部锚定跳过**——防 mandate 锚点误落在合成条上切断当前轮。auto 续行条前缀一并纳入（第二轮 auto 场景同理）。

## 裁定记录

1. **fresh 子 agent compact 无操作化**：子 agent 会话恒为 fresh（convCtx 空），当前 user 消息即 body[0]，锚点保护使尾部覆盖全部消息 → head 恒空 → compact 报「无可压缩的更早历史」不发 IPC。这是锚点不变式的必然推论，与 opencode「保留 lastUserMsg 起 verbatim」语义一致、与 spec 非目标「dispatch 子 agent fresh 会话短不触发」相符。旧「全量替换+中性指令」行为在子路径不可达，(e) 用例改锁新契约（不进收尾 + 上下文原样 + 回执不静默吞）；中性第三态由 (d) task 域（有历史、可达）继续覆盖。
2. **runCompaction 返回结构化结果**（非 brief 草案的 Promise<boolean>）：成功需携带 beforeCount/tailCount/双态判定供 tool result「N→1+尾部 M 条」三态文案消费，boolean 无法满足同 brief 的回执要求。
3. **coveredUntil = Date.now()**：LLMMessage 无 createdAt，「回合内现查」取压缩时刻；尾部消息本回合内经 chunk 路径落库（created_at ≥ 此刻），下轮拉取不丢。
4. **head 为空返回 ok:false**：auto 路径自然跳过（warn），工具路径向 LLM 报可重试错——「上下文在保留预算内」时压缩无意义，显式反馈优于静默成功。

## Concerns

- **长尾重试噪声**：est 超阈值但 head 为空（当前轮单体超窗口）时每轮 warn 一次——无 IPC、无循环风险（每轮有界），T6 溢出恢复落地后此形态由该路径接管。
- **auto + 非 mandateGated 理论边缘**（parentStreamSessionId 非空且 currentTaskId 空）：生产 dispatch 流恒带 task_id 不可达；若未来出现，行为=中性指令 + 不收尾继续（安全侧），已在代码注释标注。
- **子 agent 长回合失去压缩能力**（旧版可全量压缩）：spec 非目标明确接受；超长子回合的兜底属 T6 溢出恢复范围。
- mock 收窄声明：仅 mock `requestCompaction`（IPC）与 LLM provider；todo store / serialize / token 估算 / 尾部选择全真实（compact-auto 断言直接作用于真实估算与选择结果）。

## 审查修复轮（Critical + Minor-3）

- **Commit**: `a4a033a`（`fix: 尾部选择工具对原子性——防孤儿 tool 消息+合成条锚点专项锁`）
- **测试**: compact-auto +2 用例（7 全绿）+ compact-wrapup 6 全绿；electron 全量 210 文件 / 1760 测试绿；typecheck 双 clean

### Critical——尾部选择切断工具对 → 孤儿 tool 消息 → provider 400

- **机制确认**：预算切点落在 role:'tool' 消息上时，其所属 assistant（协议中 tool 结果紧随其后）必在 head 侧——尾部出现孤儿 tool 消息，OpenAI/Anthropic 请求体均硬性 400。
- **修复采用边界式判定**（严格强于审查建议的 (a) assistant 端判定）：break 决策前检查切点 `body[i+1]`——若为 role:'tool' 则不 break，继续纳入直到切点移出 tool 边界（不计预算，同锚点保护语义）。审查 (a) 的字面形态（在 assistant 索引处判定）会漏掉「预算在 tool 连续段中间耗尽、尚未走到 assistant 就 break」的形态；边界式判定把两种切法一并覆盖，且当被考虑消息恰为 assistant 时行为与 (a) 完全一致（无条件纳入）。
- **回归锁** compact-auto (f)：孤儿形态要求工具对位于锚点之前（锚点后消息受锚点保护必入尾部）——第 1 轮 big_tool（大参数挂 assistant ≈7500 tok + 结果 1000 tok）+ done 后注入 steer（第 2 轮顶部 drain 为末尾真实 user 消息=锚点），预算不等式 `1000+6 ≤ 8000 < 1006+7502` 使切点恰夹在 assistant 与其结果之间；断言=审查要求的扫描式检查（每条 role:'tool' 的 toolCallId 必须能在其前方 assistant.toolCalls 中找到）+ 工具对 verbatim 保留 + head 序列化正确。先红（扫描捕获孤儿）后绿。
- **顺带**：compact-auto harness 补 emitSteer 支持（与 compact-wrapup 同款时机——done 产出后注入、下轮顶部 drain 消费）。

### Minor-3——锚点跳过合成条专项锁

- compact-auto (g)：当前轮 user 消息本身为 `[历史压缩摘要]` 合成条（二次压缩形态）+ history 前置真实 user 消息与 >KEEP 大消息——断言锚点跳过合成条落在真实消息（真实消息与其后大消息 verbatim 保留在尾部；head 序列化不含真实消息）。锁定既有正确行为（绿），防未来锚点扫描改动回归。
