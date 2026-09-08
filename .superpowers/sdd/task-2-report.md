# Task 2 报告 — markdown-exporter 富信息段渲染

**状态：DONE** | 日期：2026-09-08
**Base：`08f5213`**（T1：`exportAggregateEvents` 富信息聚合器 + `ExportSegment`/`ExportDispatchStatus` 类型）

## 做了什么

按 brief 5 步 TDD 完成 v2.3.2「会话导出富信息」3 任务计划的第二块——`markdown-exporter.ts` 接入 `ExportSegment` 段序列渲染，让导出 Markdown 不再仅含 body，而是按段类型（text/tool/dispatch/todo）交错呈现，外加状态标注与 2000 字符工具结果截断：

| 文件 | 改动 |
|---|---|
| `electron/src/main/im/markdown-exporter.ts` | (a) 文件头补 `import type { ExportDispatchStatus, ExportSegment } from './export-aggregator'`；(b) 新增 `export const TOOL_RESULT_MAX_CHARS = 2000`；(c) `ExportMessage` 增可选 `rich?: { segments; status; error? }`；(d) 新增辅助：`truncateResult`（2000 字符上限 + 截断标注）、`DISPATCH_STATUS_ICON`（6 状态 emoji/文字映射）、`quoteBlock`（逐行加 `> ` 前缀）、`renderSegments`（4 kind switch）、`statusSuffix`（failed/aborted 消息头标注）；(e) `renderMessage` 改造：`rich.segments` 非空走段渲染，否则保留 `body` 兼容路径；头部追加 `statusSuffix(msg.rich)`；(f) 文件末尾新增 `export function renderSubMessage`（无 `##` 头，角色行 + 段内容，供 dispatch 段以引块包裹）；(g) 文件头注释「导出器简化为仅输出 body」段落同步标注 v2.3.2 已升级 |
| `electron/tests/im/markdown-exporter.test.ts` | 既有 import 合并 `renderSubMessage, TOOL_RESULT_MAX_CHARS`；追加 `describe('富信息渲染（v2.3.2）')` 6 用例：段序列交错渲染（含顺序断言 + 引块嵌套 + todo 三状态 ✓/◐/○）/ 工具结果截断（2500 → 2000 + 原长标注）/ 无 rich 回退纯 body（legacy 兼容）/ failed 消息头带状态标注 / renderSubMessage 无 `##` 头 / dispatch subOmitted 省略标记 |

## TDD 证据

- **红**：`vitest run tests/im/markdown-exporter.test.ts` → `5 failed | 8 passed (13)`——既有 7 + 「无 rich 回退纯 body」vacuous 1 = 8 pass；新增 5 失败（rich 段序列 / 截断常量 / 状态标注 / renderSubMessage / subOmitted）
- **绿**：`vitest run tests/im/markdown-exporter.test.ts` → `Test Files 1 passed (1) / Tests 13 passed (13)`——13/13 全绿，零回归
- **typecheck**：`pnpm typecheck`（electron + renderer 双 workspace）→ `electron typecheck: Done / renderer typecheck: Done`

## 一行测试摘要

13/13 markdown-exporter 用例通过（7 既有 + 6 新），typecheck 双 clean。

## 关键设计点（与 brief 严丝合缝）

- **rich 可选**：`ExportMessage.rich` 是 `rich?: { ... }`——legacy-export / 无事件消息两条路径不传 rich 走原纯 body 渲染（既有 7 测试零修改即过）；新聚合链路传 rich 走段渲染
- **statusSuffix 时机**：在 `renderMessage` 头部拼装时调用（仅消息头附加），不会污染段序列内容；`status === 'streaming' | 'done'` 不附加（默认行为不变）
- **tool 截断 `> ` 引用**：结果进 `quoteBlock` 引块呈现——既保留 markdown 视觉，又让截断标注 `（已截断，原文 2500 字符）` 自身不会污染段渲染（引块结尾后跟空行）
- **dispatch 三分支**：`subMarkdown` 非空走引块嵌套（tester 子回复嵌入 PM 气泡）；`subOmitted` 真走省略标记；二者皆无仅显示状态行——对应 spec §5 深度上限 + spec §3 嵌套收敛两条边界
- **renderSubMessage 无 `##`**：避免子 agent 嵌套污染主文档大纲；输出格式 `**coder** — 2023-11-15 06:13:20\n\n` + 段内容；handler 递归填 dispatch.subMarkdown 时会经 quoteBlock 引块包裹（双重引块渲染）
- **不动 export-aggregator / legacy-export**（T1 已交付 `ExportSegment`/`ExportDispatchStatus` 类型 + 聚合函数，本任务只负责消费 + 渲染）：import `from './export-aggregator'` 是直接 type-only 引用，不参与类型循环

## 留位与边界（spec §5）

| 场景 | 当前行为 | 验证用例 |
|---|---|---|
| 无 rich（legacy / 无事件） | 走原 body 渲染，零回归 | 「无 rich 字段回退纯 body」 |
| rich 但 segments 为空数组 | 走原 body 渲染（`msg.rich.segments.length > 0` 守卫） | impl 内 if-else 分支 |
| rich.status === 'streaming' | 不附加状态标注（流中无错误即默认） | 既有 / 实现内 statusSuffix 判断 |
| rich.status === 'failed' / 'aborted' + error | 头部追加 `（失败：429）` / `（已中断：xxx）` | 「failed/aborted 消息头带状态标注」 |
| rich.status === 'failed' + 无 error | 头部追加 `（失败）` | statusSuffix 默认分支 |
| 工具结果 ≤ 2000 字符 | 不截断，原文进引块 | 「段序列交错渲染」 |
| 工具结果 > 2000 字符 | 截断到 2000 + 标注「已截断，原文 N 字符」 | 「工具结果截断 2000 字符并标注原长」 |
| dispatch subMarkdown 非空 | 引块嵌套子回复 | 「段序列交错渲染」中 `**tester** — 2026` |
| dispatch subOmitted true | `> （深层委派已省略）` 引块 | 「dispatch subOmitted 渲染省略标记」 |
| dispatch 无子内容 | 仅显示状态行（如 `✅ completed`） | 同上 |
| 子 agent 嵌套（renderSubMessage） | 无 `##` 头 + 角色行 + 段内容 | 「renderSubMessage：无 ## 头」 |

## Concerns / 留待 T3

- **T3 门禁**：`pnpm test` 全量测试（本任务范围只跑了 markdown-exporter.test.ts——其他 1074+ electron + 548+ renderer 应在 T3 整体跑一次确认零跨文件回归），typecheck 双 clean，macOS 主机冒烟清单：实际跑一次「聚合 → 导出 → 渲染」端到端（粗略验证段序列交错 + 引块嵌套视觉效果）
- **TodoItem 类型来源**：`renderSegments` 中 todo 项字段 `subject` 与 stream-aggregator 侧的 todo 类型对齐依赖 `electron/src/main/agent/tools/todo-types.ts` —— T1 已落地，本任务通过 ExportSegment 间接消费，零修改
- **JSON.stringify(seg.args)**：当前是无格式 JSON 输出（紧凑）。若用户在工具 args 中传大对象，输出会比较紧凑不美观，但与 brief 描述 `JSON.stringify(args)` 字面一致（无 `null, 2` 缩进）；如未来要加缩进 / 转 markdown 表格，应独立任务处理（不在本 brief 范围）
- **dispatch `task` / `subAgentName` 空值兜底**：实现里 `seg.subAgentName || '子 agent'` + `seg.task || '（无任务描述）'`——生产链路聚合已保证非空（export-aggregator.ts:82 `typeof args.task === 'string' ? args.task : ''`），此处仅防御

## 文件清单（与 base 08f5213 diff）

```
electron/src/main/im/markdown-exporter.ts        | 96 ++++++++ (3a-3e + header update)
electron/tests/im/markdown-exporter.test.ts      | 89 ++++++ (import merge + 6 it)
```

注：`.superpowers/sdd/progress.md` / `task-1-report.md` 存在未提交的同期修订（ledger 维护），未纳入本任务 commit——保留由后续 ledger 维护者处置。