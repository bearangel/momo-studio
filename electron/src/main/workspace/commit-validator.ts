// electron/src/main/workspace/commit-validator.ts
//
// Commit message 合规校验 —— 把 GitPolicy.commitMessage.patterns 里的正则
// 逐条尝试匹配 message。这是纯函数，不触碰 DB，方便在 agent 提交链路与
// renderer 实时预览中复用同一套判定逻辑。
//
// 三种校验级别的语义：
//   none    —— 完全不校验，任何 message 都放行
//   warning —— 仍执行校验并产出 ValidationResult，但 isCommitBlocked 永远返回 false
//              （违规只告警，不阻断 agent 提交）
//   strict  —— 违规即阻断（isCommitBlocked 返回 true）

import type { CommitPattern, GitPolicy } from './git-policy';

export interface ValidationResult {
  /** 是否命中任一 pattern（none 级别恒为 true） */
  valid: boolean;
  /** 命中的 pattern（便于上层归类 / 记日志），未命中时为 undefined */
  matchedPattern?: CommitPattern;
  /** 未命中时的可读错误提示，已拼好期望格式供直接展示 */
  error?: string;
}

/**
 * 用 policy 的 patterns 校验单条 commit message。
 *
 * 校验级别 none 时直接放行（返回 valid:true），不消耗正则。
 * strict / warning 走同一套正则匹配：命中任一 pattern 即合规；
 * 全部未命中时返回 valid:false 并拼出期望格式提示。
 *
 * pattern 里的 regex 若是非法正则，会被 try/catch 跳过而非抛错——
 * 用户在 UI 自定义的正则可能写错，校验器不应因此崩溃。
 */
export function validateCommitMessage(message: string, policy: GitPolicy): ValidationResult {
  // none 级别：不校验，恒放行
  if (policy.commitMessage.validation === 'none') {
    return { valid: true };
  }

  for (const p of policy.commitMessage.patterns) {
    let re: RegExp;
    try {
      re = new RegExp(p.regex);
    } catch {
      // 非法正则跳过：避免一条坏 pattern 让整个校验器抛错
      continue;
    }
    if (re.test(message)) {
      return { valid: true, matchedPattern: p };
    }
  }

  const expected = policy.commitMessage.patterns.map((p) => p.example).join(' 或 ');
  return {
    valid: false,
    error: `Commit message 不符合规则。期望格式: ${expected}`,
  };
}

/**
 * 提交阻断决策 —— agent 提交链路在真正 git commit 前调用本函数，
 * 返回 true 表示该提交必须被拒绝。
 *
 *   none    → 永不阻断
 *   warning → 永不阻断（违规仅告警，由调用方决定如何提示）
 *   strict  → validateCommitMessage 不通过即阻断
 */
export function isCommitBlocked(message: string, policy: GitPolicy): boolean {
  if (policy.commitMessage.validation !== 'strict') {
    return false;
  }
  return !validateCommitMessage(message, policy).valid;
}

/**
 * 渲染 fallback 分支名 —— 把 fallbackBranchPattern 里的占位符替换成实际值。
 *
 * 支持的占位符：
 *   {agent_slug} → ctx.agentSlug（调用方传入的 agent 标识，如 'agent'）
 *   {task_id}    → ctx.taskId（通常用 streamSessionId，保证同一次会话复用同一分支）
 *
 * 纯字符串 replace，不做额外校验——pattern 里的非法字符（如空格）由 git 自行报错。
 * 未出现的占位符保持原样（不影响已渲染的部分）。
 */
export function renderFallbackBranch(
  pattern: string,
  ctx: { agentSlug: string; taskId: string },
): string {
  return pattern.replace('{agent_slug}', ctx.agentSlug).replace('{task_id}', ctx.taskId);
}

/**
 * 渲染最终 commit message —— 把 template 里的 {summary} 占位符替换成 message，
 * 追加可选的 description 作为 commit body，最后拼接 trailers。
 *
 * 逻辑：
 *   1. template.replace('{summary}', message) 得到首行
 *   2. 若 description 提供，空行隔开后追加为 body（多行）
 *   3. trailers 数组逐条拼成 `Key: Value` 追加到末尾（git trailer 惯例）
 *
 * template 里其他占位符（如 {type} / {taskId}）当前不替换——这些字段在 agent 提交
 * 链路中没有可靠来源，保留原样由调用方在设计 template 时自行取舍。
 */
export function renderCommitMessage(
  message: string,
  description: string | undefined,
  commitMsgPolicy: GitPolicy['commitMessage'],
): string {
  const firstLine = commitMsgPolicy.template.replace('{summary}', message);
  const lines: string[] = [firstLine];
  // description 作为 commit body：空行隔开后追加（git commit message 惯例）
  if (description) {
    lines.push('');
    lines.push(description);
  }
  // trailers 追加到末尾，每条一行 `Key: Value`
  for (const trailer of commitMsgPolicy.trailers) {
    lines.push(`${trailer.key}: ${trailer.value}`);
  }
  return lines.join('\n');
}
