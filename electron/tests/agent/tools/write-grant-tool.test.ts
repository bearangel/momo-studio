// electron/tests/agent/tools/write-grant-tool.test.ts
// 文件写工具的写授权硬门控包装（spec hard-gate §7）：越界捕获 → 上报 → 等待三态 →
// covered 刷新 extra 根重执行。等待/桥均注入替身（非 fork 环境桥不可达——IPC 边界替身）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import {
  runWithWriteGrant,
  extractOutOfWsPath,
  __setWriteGrantToolForTest,
} from '../../../src/main/agent/tools/write-grant-tool';
import type { ToolContext } from '../../../src/main/agent/tools/types';

const capturedSends: Array<Record<string, unknown>> = [];
const realSend = process.send;

beforeEach(() => {
  capturedSends.length = 0;
  Object.defineProperty(process, 'send', {
    value: (msg: unknown): boolean => {
      capturedSends.push(msg as Record<string, unknown>);
      return true;
    },
    configurable: true,
  });
});
afterEach(() => {
  Object.defineProperty(process, 'send', { value: realSend, configurable: true });
  __setWriteGrantToolForTest(null);
});

/** 最小 ctx（helper 仅触达 streamSessionId/workspaceId/wsFs/abortSignal 四字段） */
function mkCtx(wsFs?: { setExtraRootDirs: (d: string[]) => void }): ToolContext {
  return {
    streamSessionId: 'ss-tool',
    workspaceId: 'ws-tool',
    wsFs: wsFs ?? { setExtraRootDirs: vi.fn() },
  } as unknown as ToolContext;
}

const OUTSIDE = path.join('/', 'tmp', 'outside-dir', 'My File.txt'); // 带空格路径

function throwOutOfWs(): never {
  throw new Error(`路径越界: ${OUTSIDE} 不在 workspace 内`);
}

describe('extractOutOfWsPath（§7 regex 契约）', () => {
  it('越界文案提取完整路径（含空格不截断）', () => {
    expect(extractOutOfWsPath(`路径越界: ${OUTSIDE} 不在 workspace 内`)).toBe(OUTSIDE);
  });
  it('符号链接逃逸文案提取', () => {
    expect(extractOutOfWsPath(`符号链接逃逸: ${OUTSIDE}`)).toBe(OUTSIDE);
  });
  it('非越界错误 → null', () => {
    expect(extractOutOfWsPath('文件不存在: /x')).toBeNull();
    expect(extractOutOfWsPath('未知工具: foo')).toBeNull();
  });
});

describe('runWithWriteGrant（spec §7）', () => {
  it('op 成功 → 原样返回（零上报零等待）', async () => {
    const r = await runWithWriteGrant(mkCtx(), 'write_file', '/in/ws', async () => '文件已写入');
    expect(r).toBe('文件已写入');
    expect(capturedSends).toHaveLength(0);
  });

  it('非越界错误原样上抛（不进等待）', async () => {
    await expect(
      runWithWriteGrant(mkCtx(), 'write_file', '/x', async () => {
        throw new Error('文件不存在: /x');
      }),
    ).rejects.toThrow('文件不存在');
    expect(capturedSends).toHaveLength(0);
  });

  it('越界 → 上报 write-blocked-report（command=工具+路径）→ denied → 统一拒绝文案', async () => {
    __setWriteGrantToolForTest({ wait: async () => ({ kind: 'denied' as const }) });
    let calls = 0;
    const r = await runWithWriteGrant(mkCtx(), 'write_file', OUTSIDE, async () => {
      calls += 1;
      throwOutOfWs();
    });
    expect(calls).toBe(1); // denied 不重执行
    // dirs 形态取决于 normalizeGrantDirs 对不存在路径的上溯产物（/tmp → realpath）——锁前缀不锁值
    expect(r).toMatch(/^用户已拒绝授权（目录：.+）。请勿重试同一目标；如确需写入请与用户协商其他方案。$/);
    const report = capturedSends.find((m) => m.type === 'write-blocked-report') as
      | { dirs?: string[]; command?: string; streamSessionId?: string; workspaceId?: string }
      | undefined;
    expect(report).toBeDefined();
    expect(report?.streamSessionId).toBe('ss-tool');
    expect(report?.workspaceId).toBe('ws-tool');
    expect(report?.command).toBe(`write_file ${OUTSIDE}`);
  });

  it('越界 → covered → setExtraRootDirs(三层合成) → 重执行成功', async () => {
    const setExtra = vi.fn();
    __setWriteGrantToolForTest({
      net: async () => ({ netOn: false, toolchainOn: false, extraDirs: ['/granted-root'] }),
      wait: async () => ({ kind: 'covered' as const }),
    });
    let calls = 0;
    const r = await runWithWriteGrant(mkCtx({ setExtraRootDirs: setExtra }), 'write_file', OUTSIDE, async () => {
      calls += 1;
      if (calls === 1) throwOutOfWs();
      return '文件已写入';
    });
    expect(r).toBe('文件已写入');
    expect(calls).toBe(2);
    expect(setExtra).toHaveBeenCalledWith(['/granted-root']);
  });

  it('aborted → 抛 AbortError（穿透明既约定）', async () => {
    __setWriteGrantToolForTest({ wait: async () => ({ kind: 'aborted' as const }) });
    await expect(
      runWithWriteGrant(mkCtx(), 'write_file', OUTSIDE, async () => { throwOutOfWs(); }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('covered 后重执行仍越界（授权与目标不匹配）→ 轮次收敛：3 次等待后原始错误上抛（不无限循环）', async () => {
    __setWriteGrantToolForTest({
      net: async () => ({ netOn: false, toolchainOn: false, extraDirs: [] }),
      wait: async () => ({ kind: 'covered' as const }),
    });
    let calls = 0;
    await expect(
      runWithWriteGrant(mkCtx(), 'write_file', OUTSIDE, async () => {
        calls += 1;
        throwOutOfWs();
      }),
    ).rejects.toThrow('路径越界');
    expect(calls).toBe(4); // 3 轮等待 + 末轮重执行
  });
});
