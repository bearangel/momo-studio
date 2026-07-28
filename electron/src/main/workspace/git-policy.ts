// electron/src/main/workspace/git-policy.ts
//
// Workspace 级 Git Policy —— 约束 agent 在本 workspace 内的 commit 行为：
//   - allowAgentCommits：是否允许 agent 自动提交（关闭后所有 agent commit 被拒）
//   - defaultBranch / fallbackBranchPattern：agent 应在哪个分支提交
//   - commitMessage：commit message 规则（模板 + 可匹配的 pattern 列表 + 校验级别）
//
// 配置以 JSON blob 整体存入 git_policies 表（migration v7），而非拆成多列：
// 规则结构可能演进（增删字段），blob 形式让 schema 稳定、升级只需改 TS 类型。
// 未显式配置的 workspace 永远读到一个一致的默认 policy（defaultGitPolicy），
// 因此调用方无需区分“未配置”与“显式配置成默认”两种状态。

import { ipcMain } from 'electron';
import { getDb } from '../storage/db';
import { logger } from '../logger';

/** 一条可识别的 commit message 模式（如故事任务号 / bug 号 / conventional commit） */
export interface CommitPattern {
  /** 模式代号，用于 UI 展示与归类，如 'S' / 'B' / 'chore' */
  code: string;
  /** 人类可读名称，如 "故事任务" */
  name: string;
  /** JS 正则字符串，匹配整条 commit message 首行即视为合规 */
  regex: string;
  /** 合规示例，用于错误提示与文档展示 */
  example: string;
}

/** commit message 校验级别 */
export type CommitValidation = 'strict' | 'warning' | 'none';

/** 一份完整的 Git Policy 配置 */
export interface GitPolicy {
  /** 是否允许 agent 自动 commit（false 时 agent 只能产出 diff 由人合并） */
  allowAgentCommits: boolean;
  /** 默认目标分支，如 'main' */
  defaultBranch: string;
  /** agent 自动建分支时的命名模板，如 'agent/{agent_slug}/{task_id}' */
  fallbackBranchPattern: string;
  commitMessage: {
    /** commit message 渲染模板，占位符由调用方在提交时填充 */
    template: string;
    /** 合规 pattern 列表，命中任一即视为合规 */
    patterns: CommitPattern[];
    /** 校验级别：strict 阻止不合规 / warning 仅告警 / none 不校验 */
    validation: CommitValidation;
    /** 追加到每条 commit 的 trailer（如 Signed-off-by） */
    trailers: Array<{ key: string; value: string }>;
  };
}

interface PolicyRow {
  config_json: string;
}

/**
 * 返回默认 Git Policy —— 内置三类常见 commit 风格 + warning 级别。
 * 未显式配置的 workspace 读到的就是这个对象（getGitPolicy 未命中行时直接返回），
 * 保证“开箱即用”体验：agent commit 默认允许，但违规会告警而非静默放行。
 */
export function defaultGitPolicy(): GitPolicy {
  return {
    allowAgentCommits: true,
    defaultBranch: 'main',
    fallbackBranchPattern: 'agent/{agent_slug}/{task_id}',
    commitMessage: {
      template: '{type}{taskId} {summary}',
      patterns: [
        {
          code: 'S',
          name: '故事任务',
          regex: '^S\\d{8}\\s+.+',
          example: 'S12345678 用户管理模型',
        },
        {
          code: 'B',
          name: 'Bug 修复',
          regex: '^B\\d{8}\\s+.+',
          example: 'B12345678 修复登录崩溃',
        },
        {
          code: 'chore',
          name: 'Conventional Commit',
          regex: '^(feat|fix|chore|docs|refactor|test)(\\(.+\\))?:\\s+.+',
          example: 'feat(git): policy 配置',
        },
      ],
      validation: 'warning',
      trailers: [],
    },
  };
}

/**
 * 读取某 workspace 的 Git Policy。
 * 未命中行时返回 defaultGitPolicy() 的深拷贝（调用方修改返回值不会污染默认常量），
 * 因此无需区分“未配置”与“显式默认”两种状态。
 */
export function getGitPolicy(workspaceId: string): GitPolicy {
  const db = getDb();
  const row = db
    .prepare('SELECT config_json FROM git_policies WHERE workspace_id = ?')
    .get(workspaceId) as PolicyRow | undefined;

  if (!row) {
    // 深拷贝默认值，避免调用方就地修改影响后续 getGitPolicy 调用的基准
    return JSON.parse(JSON.stringify(defaultGitPolicy())) as GitPolicy;
  }
  return JSON.parse(row.config_json) as GitPolicy;
}

/**
 * 写入（覆盖）某 workspace 的 Git Policy。
 * config_json 由 JSON.stringify 整体序列化；非法 JSON 在读取时才会暴露，
 * 故调用方应传入经过类型检查的 GitPolicy 对象。
 */
export function setGitPolicy(workspaceId: string, policy: GitPolicy): void {
  const db = getDb();
  const json = JSON.stringify(policy);
  db.prepare(
    'INSERT OR REPLACE INTO git_policies (workspace_id, config_json) VALUES (?, ?)',
  ).run(workspaceId, json);
  logger.info('Git Policy 已更新', { workspaceId });
}

/**
 * 注册 gitPolicy:* IPC handlers —— workspace 域 Git Policy 的读写通道。
 *   gitPolicy:get(workspaceId) → GitPolicy（未配置则返回默认）
 *   gitPolicy:set(workspaceId, policy) → 覆盖写入
 * 与 allocation 一样归属 workspace 域，但通道命名空间独立。
 */
export function registerGitPolicyHandlers(): void {
  ipcMain.handle('gitPolicy:get', async (_evt, workspaceId: string) => {
    return getGitPolicy(workspaceId);
  });

  ipcMain.handle('gitPolicy:set', async (_evt, workspaceId: string, policy: GitPolicy) => {
    setGitPolicy(workspaceId, policy);
    return;
  });

  logger.info('Git Policy IPC handlers 已注册');
}
