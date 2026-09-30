// electron/src/main/journal/baseline.ts
//
// 任务起点扫描基线捕获（未入账变更误归因根治，2026-09-29）。
//
// 职责：任务首次进入 in_progress 时，对 workspace 内每个 git 仓跑
// `git status --porcelain=v1 --untracked-files=all`（与 detector 同款口径），
// 把当时的全部脏路径（workspace 根相对 POSIX）+ 内容 sha256 落库为
// 「起点基线」。此后 detector.scanUnjournaled 用它把「累计脏」换算成
// 「任务期间新增/再改动」——历史脏文件不再被误归因到每个任务。
//
// 调用点（全部 →in_progress 路径的接线审计，2026-09-29 grep 确认）：
//   - task/starter.ts startTask：事务提交后、返回前同步 await——所有「新启动」
//     路径（executor.launch / lifecycle.startTaskAndKickoff / conflict-executor）
//     都经 startTask，单点覆盖；必须先于 kickoff 派发（异步捕获会让 agent
//     自己的写入污染基线，造成归因假阴性）
//   - task/lifecycle.ts resumePausedTask（paused→in_progress）：幂等守卫下
//     首次 start 已建基线则 no-op；仅防「首次启动早于本功能上线的 paused 任务
//     resume」漏网（此时补建的是当前瞬时基线，best-effort）
//   - task/dispatcher.ts tryPickup 也有 →in_progress，但 TaskDispatcher 是
//     2.1 未接线预留（router-bootstrap.ts 明确不再构造），无生产流量，不接线
//
// 铁律：捕获失败绝不阻塞任务启动——git 不可用 / 任一仓非零退出 / 截断 /
// workspaceDir 取不到 / 写库失败，一律记 degraded 基线（或纯 warn）不抛。
// 基线是 best-effort 基础设施：坏了的代价只是扫描回退「累计差集 + UI 提示」，
// 不值得为此让任务启动失败。
//
// 键契约（与消费者 detector.scanUnjournaled 单点对齐）：
//   - path：workspace 根相对 POSIX 形态（toPosixRelPath，与 detector 变更集同口径）
//   - contentHash：sha256 hex（recorder.hashContent，Buffer 直读二进制保真）；
//     null = 捕获时文件不可读（已删除等）——null ≠ 空内容（空文件有确定的
//     sha256 值 e3b0c44…，删除才是 null）
//
// 已知可接受边界：并发任务共享 worktree 时，A 任务在 B 任务捕获基线之后的
// 写入会落进 B 的「任务期间新脏」——基线是瞬时快照，不区分写入者。
//
// 存储注入：消费 recorder 模块单例 getJournalStore()（与 detector 同源，
// 主进程由 registerJournalIpc 注册即注入）。runner 注入形态与 detector 一致
// （测试可 fake）。

import path from 'node:path';
import { discoverRepos } from '../git/repos';
import { getWorkspace } from '../workspace/crud';
import { logger } from '../logger';
import { toPosixRelPath } from '../platform/paths';
import { getJournalStore } from './recorder';
import { defaultGitRunner, hashFileOrNull, parsePorcelain } from './detector';
import type { GitRunner } from './detector';
import type { BaselineMetaRow } from './store';

/**
 * 捕获任务起点基线（幂等：已有基线——含 degraded——则直接跳过）。
 *
 * 行为：
 *   - store 未注入 → warn 返回（连 degraded 行都无处可写；生产主进程注册即注入，
 *     走到这里的未注入属接线缺陷，但按 best-effort 铁律仍不抛）
 *   - workspace 行不存在 / directoryPath 缺失 → 记 degraded 基线（无 path 行）
 *   - 任一仓 git status 非零 / ENOENT / 截断 → 记 degraded 基线
 *   - 正常 → meta 行（degraded=0）+ 每个脏路径一行（hash 或 null）原子落库
 *   - 任何意外异常（含 degraded 写入失败）→ warn 吞掉，绝不向调用方抛出
 */
export async function captureTaskScanBaseline(
  workspaceId: string,
  taskId: string,
  opts?: { runner?: GitRunner },
): Promise<void> {
  const store = getJournalStore();
  if (!store) {
    logger.warn('任务起点基线捕获跳过：journal store 未注入（best-effort，不阻塞任务启动）', {
      workspaceId,
      taskId,
    });
    return;
  }

  // 幂等守卫：meta 行存在（含 degraded）即已有基线，跳过。
  // 零脏工作区的合法空基线同样有 meta 行，与「无基线」（null）可区分。
  if (store.getBaselineMeta(workspaceId, taskId) !== null) return;

  try {
    const degradedAt = (reason: string): void => {
      store.insertBaseline(
        { workspaceId, taskId, capturedAt: Date.now(), degraded: true },
        [],
      );
      logger.warn('任务起点基线降级记录（扫描将回退累计差集）', {
        workspaceId,
        taskId,
        reason,
      });
    };

    // workspaceDir 自查：startTask / resumePausedTask 入参均无目录，
    // 经 workspaces 存储（workspaceId → directoryPath）取
    const ws = getWorkspace(workspaceId);
    if (!ws) {
      degradedAt(`workspace 不存在或 directoryPath 缺失: ${workspaceId}`);
      return;
    }
    const workspaceDir = ws.directoryPath;

    const runner = opts?.runner ?? defaultGitRunner;
    const paths: Array<{ path: string; contentHash: string | null }> = [];
    for (const repo of discoverRepos(workspaceDir)) {
      const r = await runner(['-C', repo, 'status', '--porcelain=v1', '--untracked-files=all']);
      if (r.code !== 0 || r.errCode !== null || r.truncated) {
        degradedAt(
          `git status 失败（repo=${repo} code=${r.code} errCode=${r.errCode} truncated=${r.truncated}）`,
        );
        return;
      }
      for (const rel of parsePorcelain(r.stdout)) {
        const abs = path.resolve(repo, rel);
        // 与 detector 同口径：relative 到 workspace 根 + POSIX 归一
        const wsRel = toPosixRelPath(workspaceDir, abs);
        if (wsRel === '') continue;
        paths.push({ path: wsRel, contentHash: hashFileOrNull(abs) });
      }
    }

    const meta: BaselineMetaRow = {
      workspaceId,
      taskId,
      capturedAt: Date.now(),
      degraded: false,
    };
    store.insertBaseline(meta, paths);
  } catch (err) {
    // 兜底：捕获链路任何意外异常（含 degraded 写入失败）——warn 不抛。
    // 无 meta 行时下一次捕获点（resume 等）会自然重试
    logger.warn('任务起点基线捕获异常（扫描将回退累计差集）', {
      workspaceId,
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
