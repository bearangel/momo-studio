// electron/src/main/workspace/git.ts
//
// 在指定目录初始化 git 仓库。供 workspace CRUD 调用，使每个 workspace
// 自带一个可用的版本控制环境，无需用户手动 `git init`。

import simpleGit from 'simple-git';
import { logger } from '../logger';

/** 在指定目录初始化 git 仓库，并创建一次空提交以确保 main 分支存在。 */
export async function initGitRepo(directoryPath: string): Promise<void> {
  const git = simpleGit(directoryPath);
  await git.init();
  await git.addConfig('user.name', 'Momo Studio');
  await git.addConfig('user.email', 'momo-studio@localhost');
  // 创建空 commit，确保 default branch 真实存在（而非仅 git init 后的 unborn）
  await git.commit('init: workspace 初始化', [], { '--allow-empty': null });
  logger.info('Git 仓库已初始化', { directoryPath });
}
