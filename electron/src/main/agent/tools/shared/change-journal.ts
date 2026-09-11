// electron/src/main/agent/tools/shared/change-journal.ts
//
// 变更账本工具层接线（v2.5 Task 4）：file-tools / apply-patch-tools 写路径
// 共用的记账入口。三件事：
//   1) buildRecordCtx——从 ToolContext 一次性构造 RecordCtx（生产注入链：
//      doExecuteTool toolCtx.taskId ← config.currentTaskId）
//   2) toJournalRelPath——路径归一键（'./a.ts' 与 'a.ts' 同键；与
//      readTracker 的 abs 归一教训同源，review M4）
//   3) *Safe 系列包装——「记账失败不阻塞工具执行」铁律（安全网自身不能变
//      成故障点）：store 未注入 warn 一次后降级跳过；recordChange 抛错仅
//      warn。生产 store 注入见 runtime-entry main()（子进程直接开 SQLite
//      WAL 连接——MemoryTools getDb() 同款先例）；测试注入见
//      __setJournalStoreForTest（journal/recorder.ts）。
//
// __setJournalEnabledForTest(false)：整体逃逸阀——既有无 db fixture 的工具
// 测试可显式关闭记账交互（默认依赖 store 未注入降级路径，不关闭也不报错）。

import fs from 'node:fs';
import nodePath from 'node:path';
import { logger } from '../../../logger';
import {
  recordChange,
  recordDeleteTree,
  getJournalStore,
  type RecordCtx,
} from '../../../journal/recorder';
import type { JournalOp } from '../../../journal/types';
import type { ToolContext } from '../types';

let journalEnabled = true;
let warnedNoStore = false;

/** 测试逃逸阀：false 时全部记账入口静默跳过（生产恒为 true） */
export function __setJournalEnabledForTest(enabled: boolean): void {
  journalEnabled = enabled;
}

/**
 * 构造记账上下文。taskId 快速会话可空；sessionId 取 ctx.roomId
 * （空串——无会话上下文的运行时形态——归一为 null，与列语义对齐）。
 */
export function buildRecordCtx(toolName: string, ctx: ToolContext): RecordCtx {
  return {
    workspaceId: ctx.workspaceId,
    taskId: ctx.taskId ?? null,
    sessionId: ctx.roomId || null,
    streamSessionId: ctx.streamSessionId,
    toolName,
  };
}

/** 工具入参路径 → 账本归一键：workspace 相对正规路径（assertInWorkspace 内含越界防御） */
export function toJournalRelPath(ctx: ToolContext, p: string): string {
  const abs = ctx.wsFs.assertInWorkspace(p);
  return nodePath.relative(ctx.workspaceDir, abs);
}

/** store 未注入时降级：warn 一次（不逐调用刷日志），跳过记账 */
function degradeIfNoStore(): boolean {
  if (getJournalStore() !== null) return false;
  if (!warnedNoStore) {
    warnedNoStore = true;
    logger.warn('journal store 未注入，跳过工具记账（降级不阻塞工具执行；生产注入点见 runtime-entry main）');
  }
  return true;
}

/** 单条记账（write-ahead）：任何失败只 warn，绝不阻塞工具执行 */
export function recordChangeSafe(
  rc: RecordCtx,
  filePath: string,
  op: JournalOp,
  before: string | null,
  after: string | null,
  oldPath?: string,
): void {
  if (!journalEnabled) return;
  if (degradeIfNoStore()) return;
  try {
    recordChange(rc, filePath, op, before, after, oldPath);
  } catch (err) {
    logger.warn('变更账本记账失败（降级不阻塞工具执行）', {
      op,
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 删除树记账（rm 目录/单文件统一入口；recorder 内部自辨单文件边界） */
export function recordDeleteTreeSafe(rc: RecordCtx, workspaceDir: string, relDir: string): void {
  if (!journalEnabled) return;
  if (degradeIfNoStore()) return;
  try {
    recordDeleteTree(rc, workspaceDir, relDir);
  } catch (err) {
    logger.warn('变更账本删除树记账失败（降级不阻塞工具执行）', {
      relDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 目录移动记账：逐文件记 rename（path=目标侧相对路径, oldPath=源侧相对路径,
 * before=文件内容）。目录 rename 无单文件内容可 hash，逐文件条目让撤销按文件
 * 精确逆移（rename 条目守卫键 = beforeHash，见 journal/revert.ts）。
 * 目标侧已存在目录时 rename(2) 仅在目标为空目录时成功（ENOTEMPTY 由
 * wsFs.rename 原样抛出，工具层行为不变）；空目录被替换不损失文件内容，无需记账。
 */
export function recordRenameTreeSafe(
  rc: RecordCtx,
  workspaceDir: string,
  srcRel: string,
  dstRel: string,
): void {
  if (!journalEnabled) return;
  if (degradeIfNoStore()) return;
  try {
    const absSrc = nodePath.join(workspaceDir, srcRel);
    if (!fs.existsSync(absSrc)) return;
    walkForRename(absSrc, '', (absFile, relFromSrc) => {
      const content = fs.readFileSync(absFile, 'utf-8');
      recordChangeSafe(
        rc,
        nodePath.join(dstRel, relFromSrc),
        'rename',
        content,
        null,
        nodePath.join(srcRel, relFromSrc),
      );
    });
  } catch (err) {
    logger.warn('变更账本目录移动记账失败（降级不阻塞工具执行）', {
      srcRel,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 目录 walker：与 recorder.walkFiles 同风格（不追踪符号链接，防递归环） */
function walkForRename(absRoot: string, relRoot: string, cb: (absFile: string, rel: string) => void): void {
  for (const name of fs.readdirSync(absRoot)) {
    const abs = nodePath.join(absRoot, name);
    const rel = relRoot === '' ? name : nodePath.join(relRoot, name);
    if (fs.statSync(abs).isDirectory()) {
      walkForRename(abs, rel, cb);
    } else {
      cb(abs, rel);
    }
  }
}
