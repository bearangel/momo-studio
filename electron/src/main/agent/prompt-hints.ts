// electron/src/main/agent/prompt-hints.ts
//
// system prompt 动态注入段构造器（Task 13 自 runtime-entry.ts 迁出）。
// 三类提示追加在基础 system prompt 之后：工具预算 / PM 任务拆分教学 / task 上下文。

import type { RuntimeConfig } from './runtime-config';
import type { TaskContext } from '../memory';

/**
 * 格式化预算提示，注入 system prompt 末尾。
 * -1（无限）→ 不提示；0 → 禁用；N → 提示上限。
 */
export function formatBudgetHint(maxToolCalls: number): string {
  if (maxToolCalls === -1) return '';
  if (maxToolCalls === 0) return '\n\n## 工具调用预算\n本任务禁止使用任何工具。';
  return `\n\n## 工具调用预算\n本任务工具调用上限：${maxToolCalls} 次（所有参与 agent 共享此预算）。请合理规划工具使用。`;
}

/**
 * 为多成员会话 leader（会话快照判定 + 有 subAgents）注入任务拆分教学 prompt。
 * 教 LLM 在以下场景主动 dispatch 给 sub agent：
 *   - 任务涉及多文件 / 多模块（>3 文件）
 *   - 任务可并行（多个独立子任务）
 *   - 任务超出单一 agent 上下文承受（大 review / 大型实现）
 *
 * 子 agent 列表注入让 LLM 知道可用资源和擅长领域。
 * 非 leader / 无 subAgents → 返回空字符串（不影响普通 agent）。
 * v25 Task 10：判定条件自 role==='main' 切会话快照（config.isLeader，spec §4.7）。
 * turn-mandate Task 2（spec §5.6 #7）：拆分原则限定「当前任务」语境，去掉
 * 「不要全部自己做」类无条件前进指令；简单请求直接完成，不要为拆分而拆分。
 */
export function formatDispatchHint(config: RuntimeConfig): string {
  if (!config.isLeader || config.subAgents.length === 0) return '';
  const subList = config.subAgents
    .map((s) => `- dispatch:${s.slug} — ${s.description}`)
    .join('\n');
  return `\n\n## 任务拆分指南（PM 角色）
你是主 agent（PM），有以下子 agent 可委派：
${subList}

**拆分原则（限当前任务）**：
1. **当前任务**涉及 ≥3 个文件、多个模块、或含可并行子任务时，优先 dispatch 给合适的子 agent
2. 每个子任务描述清晰、自包含（不要让子 agent 猜测上下文）
3. 子 agent 完成后会有回执，PM 整合结果再回复用户
4. 简单请求（<3 文件 / 单步）直接完成，不要为拆分而拆分
5. 子任务相互独立时，在**同一次回复中连续发出多个 dispatch 工具调用**并行执行，不要拆到多轮（多轮 = 串行等待）

**长任务自身管理**：
- 多轮对话累积时调 \`compact\` 工具压缩上下文（≥200 字符总结）
- 单段回复超 ~3KB 时调 \`task_complete\` 分段持久化（最多 5 段）
- 大文件用 \`read_file\` 的 offset/limit 分页读取（默认 2000 行/次）`;
}

/**
 * >30 条历史时的压缩建议（turn-mandate spec §5.6 #1 / §11-3）：只建议动作，
 * 不内嵌前进指令——压缩后的续跑/收尾由 compact 分支按 mandate 判定
 * （runtime-entry，Task 4 改造）。此处文案须保持中性，避免前进祈使句被
 * LLM 复制到自身计划里导致循环执行。
 */
export function buildCompactSuggestHint(msgCount: number): string {
  return (
    `[系统提示] 对话历史已较长（${msgCount} 条消息）。如影响工作质量，可调用 compact ` +
    '工具压缩上下文（写一份 ≥200 字符的总结）。压缩后依据本轮授权状态决定继续或收尾。'
  );
}

/**
 * v2（B 子系统 Task B11）：把 TaskContext 格式化为注入 system prompt 的中文提示。
 *
 * 携带 task 元信息（id/title/description）+ 已完成进度（关键事件摘要）+ 已改动文件。
 * agent 据此感知自己在执行哪个任务、已完成哪些步骤、改了哪些文件——避免重复劳动。
 */
export function formatTaskHint(ctx: TaskContext): string {
  const eventsBlock =
    ctx.events.length > 0
      ? `\n已完成进度:\n${ctx.events.map((e) => `- ${e.summary}`).join('\n')}`
      : '';
  const artifactsBlock =
    ctx.artifacts.length > 0
      ? `\n已改动的文件:\n${ctx.artifacts.map((a) => `- ${a.action}: ${a.path}`).join('\n')}`
      : '';
  return `\n\n[任务上下文] 你正在执行任务 #${ctx.task.id}: ${ctx.task.title}
描述: ${ctx.task.description}${eventsBlock}${artifactsBlock}`;
}
