// electron/tests/agent/tools/sandbox-env.test.ts
// buildSandboxEnv 平台化回归锁（spec 2026-11-02 §5.1）。
//
// 背景：旧实现只按大写 `PATH` 比对，而 Windows 环境变量名是 `Path`——
// 白名单把 PATH 整条丢掉，子进程里 node / python / npm / git 全部解析失败；
// `PATHEXT` 也不在清单内，PowerShell 无法解析外部程序。
//
// 用例 4/5 用 toEqual 快照锁死 posix 分支与改动前逐字相等（大小写敏感语义不变）。

import { describe, it, expect } from 'vitest';
import { buildSandboxEnv } from '../../../src/main/agent/tools/shell-tools';
import type { ToolContext } from '../../../src/main/agent/tools/types';

const ctx = { workspaceDir: 'C:\\ws' } as unknown as ToolContext;

describe('buildSandboxEnv', () => {
  it('win32：大小写混合的 Path / SystemRoot 被保留', () => {
    const out = buildSandboxEnv(ctx, {
      Path: 'C:\\bin', PATHEXT: '.COM;.EXE;.BAT', SystemRoot: 'C:\\Windows', windir: 'C:\\Windows',
    }, 'win32');
    expect(out.Path).toBe('C:\\bin');
    expect(out.PATHEXT).toBe('.COM;.EXE;.BAT');
    expect(out.SystemRoot).toBe('C:\\Windows');
    expect(out.windir).toBe('C:\\Windows');
    // win32 分支同样必须注入两个环境标识（终审 Minor 6：此前只有 posix 用例锁住，
    // win32 漏注入时模型脚本读不到 WORKSPACE_DIR，测试却全绿）
    expect(out.WORKSPACE_DIR).toBe('C:\\ws');
    expect(out.MOMO_STUDIO_AGENT).toBe('1');
  });

  it('win32：注入 PYTHONUTF8 与 PYTHONIOENCODING', () => {
    const out = buildSandboxEnv(ctx, {}, 'win32');
    expect(out.PYTHONUTF8).toBe('1');
    expect(out.PYTHONIOENCODING).toBe('utf-8');
    expect(out.WORKSPACE_DIR).toBe('C:\\ws');
    expect(out.MOMO_STUDIO_AGENT).toBe('1');
  });

  it('win32：白名单外的变量不下发', () => {
    const out = buildSandboxEnv(ctx, { Path: 'x', OPENAI_API_KEY: 'sk-x', GITHUB_TOKEN: 'g' }, 'win32');
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.GITHUB_TOKEN).toBeUndefined();
  });

  it('posix：输出与旧实现逐字相等，且不注入 PYTHONUTF8', () => {
    const out = buildSandboxEnv(ctx, {
      PATH: '/usr/bin', HOME: '/home/u', OPENAI_API_KEY: 'sk-x', GITHUB_TOKEN: 'g',
    }, 'linux');
    expect(out).toEqual({
      PATH: '/usr/bin', HOME: '/home/u',
      WORKSPACE_DIR: 'C:\\ws', MOMO_STUDIO_AGENT: '1',
    });
  });

  it('posix：大小写不同不算命中（保持既有大小写敏感语义）', () => {
    const out = buildSandboxEnv(ctx, { Path: '/usr/bin' }, 'linux');
    expect(out.PATH).toBeUndefined();
  });
});
