// electron/src/main/agent/tools/write-grant-tool.ts
// 文件写工具的写授权硬门控包装（spec 2026-10-03 hard-gate §7）：WorkspaceFS
// 越界异常 → 上报弹卡（复用 write-blocked-report 通道）→ 无限等待三态出口 →
// covered 刷新 extra 根后重执行。bash 不走本 helper（shell-tools 自带轮次循环
// ——其检测在结果文本侧）。
import os from 'node:os';
import { normalizeGrantDirs } from './sandbox-write-hint';
import { requestEffectiveNetwork } from './net-trust-bridge';
import { waitForWriteGrant, formatWriteDeniedResult } from './write-grant-wait';
import type { ToolContext } from './types';

/** WorkspaceFS 越界异常文案（文案锁见 workspace-fs.test.ts——本 regex 是其消费契约；
 *  贪婪 .+ 以固定后缀「 不在 workspace 内」为锚——路径可含空格，\S+ 会截断） */
const OUT_OF_WS = /路径越界: (.+) 不在 workspace 内/;
const SYMLINK_ESCAPE = /符号链接逃逸: (.+)/;

/** 轮次上限（spec §7：与 bash WRITE_WAIT_MAX_ROUNDS 同值——mv 双路径/patch 多根收敛） */
const WRITE_TOOL_MAX_ROUNDS = 3;

type WaitFn = typeof waitForWriteGrant;
type NetQueryFn = typeof requestEffectiveNetwork;
let waitOverride: WaitFn | null = null;
let netOverride: NetQueryFn | null = null;
export function __setWriteGrantToolForTest(o: { wait?: WaitFn; net?: NetQueryFn } | null): void {
  waitOverride = o?.wait ?? null;
  netOverride = o?.net ?? null;
}

/** 从错误消息提取越界路径；非越界错误返回 null */
export function extractOutOfWsPath(errorMessage: string): string | null {
  const m = OUT_OF_WS.exec(errorMessage) ?? SYMLINK_ESCAPE.exec(errorMessage);
  return m?.[1] ?? null;
}

export async function runWithWriteGrant<T>(
  ctx: ToolContext,
  toolName: string,
  pathArg: string,
  op: () => Promise<T>,
): Promise<T | string> {
  const queryNet = netOverride ?? requestEffectiveNetwork;
  const doWait = waitOverride ?? waitForWriteGrant;
  for (let round = 0; round < WRITE_TOOL_MAX_ROUNDS; round += 1) {
    let rawPath: string | null = null;
    try {
      return await op();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rawPath = extractOutOfWsPath(msg);
      if (rawPath === null) throw err; // 非越界错误不进门控
    }
    const dirs = normalizeGrantDirs([rawPath], os.homedir());
    process.send?.({
      type: 'write-blocked-report',
      streamSessionId: ctx.streamSessionId,
      workspaceId: ctx.workspaceId,
      dirs,
      command: `${toolName} ${pathArg}`.slice(0, 200),
    });
    const wait = await doWait({
      dirs,
      signal: ctx.abortSignal,
      isCovered: async () => {
        try {
          const eff = await queryNet(ctx.streamSessionId, ctx.workspaceId);
          return dirs.some((d) => eff.extraDirs.includes(d));
        } catch {
          return false;
        }
      },
    });
    if (wait.kind === 'aborted') {
      const e = new Error(`${toolName} 被中断`);
      e.name = 'AbortError';
      throw e;
    }
    if (wait.kind === 'denied') return formatWriteDeniedResult(dirs);
    // covered：刷新 extra 根（三层合成）→ 循环头重执行
    try {
      const eff = await queryNet(ctx.streamSessionId, ctx.workspaceId);
      ctx.wsFs.setExtraRootDirs(eff.extraDirs);
    } catch {
      // 刷新失败不阻断——下一轮越界会再走本 helper
    }
  }
  return await op(); // 末轮重执行：再越界则原始错误上抛（LLM 换方案或重发工具调用）
}
