# Task 3 Report — 建议清理 + 命中统计 + 长度 enforcement（v2.2 记忆 P3）

> **Slot note:** 此 `task-3-report.md` 槽位此前由 P2 批次 Task 3 使用（commit `33235b7` 自动提取管线报告）。本 P3 Task 3 按本次任务指令 overwrite 该文件——P2 报告原文保留在 git 历史中，可通过 `git show 33235b7:.superpowers/sdd/task-3-report.md` 查阅。

**Status:** ✅ 完成
**Commit:** `feat(memory): 命中统计+建议清理标记+长度上限（v2.2 记忆 P3）`
**Date:** 2026-09-03

---

## 实施范围

### 1. content 长度 enforcement（repo 层）
`electron/src/main/storage/memories/repo.ts`：
- 新增导出常量 `CONTENT_LIMIT = 2000` / `RULE_CONTENT_LIMIT = 4000`
- 新增内部 `validateContentLength(kind, content)`——超限抛错，错误信息含上限数字（UI 直接呈现）
- `insertMemory` / `updateMemory` 在事务前先校验：update 沿用既有 `existing.kind`（kind 不可 patch）
- 错误信息示例：`记忆内容长度不能超过 4000 字（规则类），当前 4001 字`

### 2. 命中统计 + 建议清理黄标 + textarea maxLength（renderer）
`renderer/src/components/settings/MemorySettings.tsx`：
- 列表行元信息增「命中 N 次 · 最近 YYYY-MM-DD」（lastUsedAt 为 null 显示「未使用」）
- `STALE_DAYS = 90` 常量；`isStaleAuto(e)` 判定：仅 `source === 'auto'`，`lastUsedAt ?? createdAt` 距今 > 90 天
- 命中建议清理的行渲染 `<Badge tone="warning">建议清理</Badge>`（语义 token `bg-status-warning-tint text-status-warning`，复用 ui/Badge 原子件）
- 删除仍走现有「二次确认」对话框（spec §6.6 可逆原则——仅展示，删除由用户操作）
- 编辑/新增对话框从 `<Input>` 切 `<textarea>`（原生，token 样式对齐 ui/Input），`maxLength` 按 kind 动态（rule=4000/其他=2000）
- 剩余字数提示「还可输入 N 字」（N = max(0, limit - len)）

### 3. Rider 回归锁
`electron/tests/memory/markdown.test.ts` 追加 1 用例：global 层含段 → 导出 global → 再导入 global → `imported=0 / skipped=2`（`scopeKind='global' + workspaceId 空串占位` 路径锁）——一次绿=既有实现已覆盖该路径，验证不漂移

---

## TDD 路径

1. **repo 边界**（红→绿）：`repo.test.ts` 增 `describe('content 长度上限 enforcement')` 4 用例（`1999/2000/2001` 普通 + `4000/4001` rule + update 路径 + insert 超限主表不留半行）
2. **rider**（一次绿=回归锁）：`markdown.test.ts` 增 global 自往返去重 1 用例
3. **UI**（红→绿）：`MemorySettings.test.tsx` 增 6 用例（命中统计 1 + 黄标 2：含 user 不黄标 + createdAt 兜底 / 长度上限 3：编辑 rule=4000 / 编辑 knowledge=2000 / 新增默认 rule=4000 → 切 knowledge 动态 2000 + 剩余字数提示）

---

## 验证结果

| 验证项 | 命令 | 结果 |
|---|---|---|
| electron 受影响测试 | `cd electron && npx pnpm@9.0.0 vitest run tests/memory/ tests/storage/memories/` | 104 passed (9 files) |
| electron 全套回归 | `cd electron && npx pnpm@9.0.0 vitest run` | **1426 passed (171 files)** |
| renderer settings | `cd renderer && npx pnpm@9.0.0 vitest run src/components/settings/` | 83 passed (10 files) |
| renderer 全套回归 | `cd renderer && npx pnpm@9.0.0 vitest run` | **814 passed (91 files)** |
| typecheck 双端 | 根 `npx pnpm@9.0.0 typecheck` | electron Done / renderer Done |
| renderer lint | `cd renderer && npx pnpm@9.0.0 lint` | 0 errors / 0 warnings |
| lsp_diagnostics（4 改动文件） | MemorySettings.tsx / .test.tsx / repo.ts / repo.test.ts / markdown.test.ts | 0 diagnostics |

零回归。

---

## 关键决策与保真度

- **跨进程常量各自持有**：renderer 侧 `CONTENT_LIMIT/RULE_CONTENT_LIMIT` 与 electron 侧对齐——非共享源（renderer 不能 import electron 代码），值变化需双侧同步（注释明确标注）。这是 v2.2 P3 设计约定，与 v1.x P0 lessons「跨模块 ID 单点生成沿线透传」一致（接受常数镜像而非共享，跨进程边界无法直接共享）
- **UI textarea 而非复用 Input**：spec/plan 要求 textarea，token 样式对齐 Input；多行内容（已有 markdown 导出多行 content 测试用例）合理需要
- **createdAt 兜底**：plan 显式要求；null lastUsedAt 表示「从未被检索」，此时以创建时间作为新鲜度评估基准
- **删除仍走确认**：spec §6.6 可逆原则——建议清理仅作展示标识，不自动删
- **错误信息含上限数字**：错误信息「记忆内容长度不能超过 2000 字」含中文+数字——UI 拒绝后用户能直接看到阈值
- **wsEntry fixture 标注 MemoryEntry**：测试 fixture 显式用契约类型，避免 `lastUsedAt: null` 推导为 `null` 字面量类型导致 override number 报错（提升保真度，tsc strict 下真实拦截）

---

## 风险与遗留

- **长度 enforcement 可能影响 LLM 自动提取路径**（extraction.ts 调用 `insertMemory`）。本次未跑 LLM 端到端验证——若真实提取产出 >2000 字将抛错拒绝。这是预期行为（spec §6.6），但实际提取管线的窗口/分块策略需关注。P3 Task 5「打磨批」/未来验收时确认
- **`isStaleAuto` 用 `Date.now()` 而非数据库 NOW**——单机单进程场景，无影响
- **textarea 自带 maxLength 只在输入时截断**：典型边界是 kind 从 rule 切 knowledge 后历史超长文本保留——repo 校验为最终防线

---

## Commit 变更

```
feat(memory): 命中统计+建议清理标记+长度上限（v2.2 记忆 P3）
```

5 files / +230 / -9
- `electron/src/main/storage/memories/repo.ts`：校验函数 + 两常量导出（+16）
- `electron/tests/storage/memories/repo.test.ts`：4 边界用例（+40）
- `electron/tests/memory/markdown.test.ts`：1 global 去重回归锁用例（+18）
- `renderer/src/components/settings/MemorySettings.tsx`：STALE_DAYS / 长度常量 / 辅助函数 / MemoryContentTextarea / 列表元信息增行（+75 / -9）
- `renderer/src/components/settings/MemorySettings.test.tsx`：6 用例 + wsEntry 类型标注 MemoryEntry（+90）