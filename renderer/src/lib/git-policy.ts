// renderer/src/lib/git-policy.ts
//
// Git Policy 默认值的运行时实现 —— 与 electron 端 defaultGitPolicy() 保持同步。
// 不能放在 ipc/types.d.ts（那是声明文件，会被 tsc 抹除、Vite 无法在运行时加载），
// 故单独放到 lib/ 下作为真正的运行时模块。renderer 各处需要默认 policy 时引用此处，
// 避免在组件里硬编码重复一份默认值。
import type { GitPolicy } from '../ipc/types';

export function defaultGitPolicy(): GitPolicy {
  return {
    allowAgentCommits: true,
    defaultBranch: 'main',
    fallbackBranchPattern: 'agent/{agent_slug}/{task_id}',
    commitMessage: {
      template: '{type}{taskId} {summary}',
      patterns: [
        { code: 'S', name: '故事任务', regex: '^S\\d{8}\\s+.+', example: 'S12345678 用户管理模型' },
        { code: 'B', name: 'Bug 修复', regex: '^B\\d{8}\\s+.+', example: 'B12345678 修复登录崩溃' },
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
