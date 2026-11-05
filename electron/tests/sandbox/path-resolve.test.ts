// electron/tests/sandbox/path-resolve.test.ts
//
// 登录 shell PATH 解析（path-resolve.ts）行为锁（工具链可见性修复 2026-11-04）：
//   - 成功解析：`$SHELL -l -c 'echo $PATH'` 输出落进程级缓存（第二次调用零 spawn）
//   - 优雅降级：超时 / 非零退出 / 空输出 / 无候选 → 沿用 process.env.PATH + warn
//   - darwin 回退链：SHELL 缺失 → /bin/zsh → /bin/bash 按序尝试
//   - win32：无登录 shell 语义，原样返回、零 spawn
//   - 并发去重：在途探测共享（一次 spawn，多个等待者同值）
//   - mergePathEntries：base 顺序保留 + extra 去重追加（纯函数）
//
// Mock 纪律（momo-test-rules）：只 mock 进程边界（node:child_process spawn）与
// 日志出口；合并/缓存/回退循环全部走真实实现。缓存是模块级状态——每个用例
// vi.resetModules + 动态 import 取全新模块实例，互不串扰。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const { spawnMock, warnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('../../src/main/logger', () => ({ logger: { warn: warnMock } }));

import { mergePathEntries } from '../../src/main/sandbox/path-resolve';

/** 每用例全新模块实例（模块级缓存隔离） */
async function freshModule(): Promise<typeof import('../../src/main/sandbox/path-resolve')> {
  vi.resetModules();
  return await import('../../src/main/sandbox/path-resolve');
}

const PLATFORM_DESCR = Object.getOwnPropertyDescriptor(process, 'platform');
/** 临时覆盖 process.platform（path-resolve 在调用时读取）；finally 恢复原描述符 */
async function withPlatform<R>(platform: NodeJS.Platform, fn: () => Promise<R>): Promise<R> {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    if (PLATFORM_DESCR) Object.defineProperty(process, 'platform', PLATFORM_DESCR);
  }
}

/** fake 子进程：stdout / 事件面 / kill 桩——由测试手动驱动 data/error/close */
function mkFakeChild(): {
  child: { stdout: EventEmitter; kill: ReturnType<typeof vi.fn>; on: EventEmitter['on'] };
  stdout: EventEmitter;
  events: EventEmitter;
} {
  const stdout = new EventEmitter();
  const events = new EventEmitter();
  return {
    child: { stdout, kill: vi.fn(), on: events.on.bind(events) },
    stdout,
    events,
  };
}

const SHELL_ORIG = process.env.SHELL;

beforeEach(() => {
  spawnMock.mockReset();
  warnMock.mockReset();
});

afterEach(() => {
  if (SHELL_ORIG === undefined) delete process.env.SHELL;
  else process.env.SHELL = SHELL_ORIG;
});

describe('mergePathEntries（纯函数）', () => {
  it('extra 新条目按序追加：base 顺序保留、与 base 重复及 extra 内部重复均去重', () => {
    const merged = mergePathEntries(
      `/usr/bin${path.delimiter}/bin`,
      `/opt/homebrew/bin${path.delimiter}/usr/bin${path.delimiter}/Users/u/.sdkman/candidates/java/current/bin${path.delimiter}/opt/homebrew/bin`,
    );
    expect(merged).toBe(
      `/usr/bin${path.delimiter}/bin${path.delimiter}/opt/homebrew/bin${path.delimiter}/Users/u/.sdkman/candidates/java/current/bin`,
    );
  });

  it('extra 条目已全部存在 → 原样返回 base（字符串同一性，不重建等值串）', () => {
    const base = `/a${path.delimiter}/b`;
    expect(mergePathEntries(base, `/b${path.delimiter}/a`)).toBe(base);
  });

  it('空条目跳过：extra 为空串或仅分隔符时不追加任何条目', () => {
    const base = `/a${path.delimiter}/b`;
    expect(mergePathEntries(base, '')).toBe(base);
    expect(mergePathEntries(base, path.delimiter.repeat(2))).toBe(base);
  });
});

describe('resolveLoginShellPath', () => {
  it('成功解析：$SHELL 登录探测 argv 契约 + 输出 trim 后缓存，第二次调用零 spawn', async () => {
    process.env.SHELL = '/bin/login-test-shell';
    const fake = mkFakeChild();
    spawnMock.mockReturnValueOnce(fake.child);
    const mod = await freshModule();
    const p = mod.resolveLoginShellPath();
    expect(spawnMock).toHaveBeenCalledWith(
      '/bin/login-test-shell',
      ['-l', '-c', 'echo $PATH'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    fake.stdout.emit('data', Buffer.from('/usr/bin:/bin:/opt/homebrew/bin\n'));
    fake.events.emit('close', 0);
    await expect(p).resolves.toBe('/usr/bin:/bin:/opt/homebrew/bin');
    // 缓存命中：第二次调用不再 spawn
    await expect(mod.resolveLoginShellPath()).resolves.toBe('/usr/bin:/bin:/opt/homebrew/bin');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('并发调用共享同一次探测（in-flight 去重：一次 spawn、多个等待者同值）', async () => {
    process.env.SHELL = '/bin/slow-login-shell';
    const fake = mkFakeChild();
    spawnMock.mockReturnValueOnce(fake.child);
    const mod = await freshModule();
    const p1 = mod.resolveLoginShellPath();
    const p2 = mod.resolveLoginShellPath();
    fake.stdout.emit('data', Buffer.from('/usr/bin:/bin'));
    fake.events.emit('close', 0);
    expect(await p1).toBe('/usr/bin:/bin');
    expect(await p2).toBe('/usr/bin:/bin');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('非零退出码（linux 单候选耗尽）→ 降级 process.env.PATH + warn，且降级结果同样缓存', async () => {
    await withPlatform('linux', async () => {
      process.env.SHELL = '/bin/bad-login-shell';
      const fake = mkFakeChild();
      spawnMock.mockReturnValueOnce(fake.child);
      const mod = await freshModule();
      const p = mod.resolveLoginShellPath();
      fake.stdout.emit('data', Buffer.from('whatever'));
      fake.events.emit('close', 127);
      await expect(p).resolves.toBe(process.env.PATH ?? '');
      expect(warnMock).toHaveBeenCalledTimes(1);
      // 降级结果缓存（每进程一次）：第二次调用零 spawn
      await expect(mod.resolveLoginShellPath()).resolves.toBe(process.env.PATH ?? '');
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
  });

  it('退出码 0 但输出为空 → 视为失败降级 process.env.PATH', async () => {
    await withPlatform('linux', async () => {
      process.env.SHELL = '/bin/empty-login-shell';
      const fake = mkFakeChild();
      spawnMock.mockReturnValueOnce(fake.child);
      const mod = await freshModule();
      const p = mod.resolveLoginShellPath();
      fake.events.emit('close', 0);
      await expect(p).resolves.toBe(process.env.PATH ?? '');
      expect(warnMock).toHaveBeenCalledTimes(1);
    });
  });

  it('探测超时 → SIGKILL 后降级 process.env.PATH（不留悬挂进程）', async () => {
    vi.useFakeTimers();
    try {
      await withPlatform('linux', async () => {
        process.env.SHELL = '/bin/hang-login-shell';
        const fake = mkFakeChild(); // 挂死：测试侧永不 emit close
        spawnMock.mockReturnValueOnce(fake.child);
        const mod = await freshModule();
        const p = mod.resolveLoginShellPath();
        await vi.advanceTimersByTimeAsync(3_000);
        await expect(p).resolves.toBe(process.env.PATH ?? '');
        expect(fake.child.kill).toHaveBeenCalledWith('SIGKILL');
        expect(warnMock).toHaveBeenCalledTimes(1);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('darwin：SHELL 缺失 → 回退 /bin/zsh（启动失败）→ /bin/bash 成功', async () => {
    await withPlatform('darwin', async () => {
      delete process.env.SHELL;
      const zsh = mkFakeChild();
      const bash = mkFakeChild();
      spawnMock.mockReturnValueOnce(zsh.child).mockReturnValueOnce(bash.child);
      const mod = await freshModule();
      const p = mod.resolveLoginShellPath();
      // 首选 /bin/zsh（登录探测 argv 契约同上）
      expect(spawnMock).toHaveBeenNthCalledWith(1, '/bin/zsh', ['-l', '-c', 'echo $PATH'], expect.anything());
      zsh.events.emit('error', new Error('spawn ENOENT'));
      // 回退循环经微任务推进到下一候选后再驱动 bash
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
      expect(spawnMock).toHaveBeenNthCalledWith(2, '/bin/bash', ['-l', '-c', 'echo $PATH'], expect.anything());
      bash.stdout.emit('data', Buffer.from('/usr/bin:/bin\n'));
      bash.events.emit('close', 0);
      await expect(p).resolves.toBe('/usr/bin:/bin');
      expect(warnMock).not.toHaveBeenCalled();
    });
  });

  it('linux：SHELL 未设置且无回退链 → 降级 process.env.PATH（零 spawn）', async () => {
    await withPlatform('linux', async () => {
      delete process.env.SHELL;
      const mod = await freshModule();
      await expect(mod.resolveLoginShellPath()).resolves.toBe(process.env.PATH ?? '');
      expect(spawnMock).not.toHaveBeenCalled();
      expect(warnMock).toHaveBeenCalledTimes(1);
    });
  });

  it('win32：无登录 shell 语义 → 原样返回 process.env.PATH，零 spawn', async () => {
    await withPlatform('win32', async () => {
      process.env.SHELL = '/irrelevant';
      const mod = await freshModule();
      await expect(mod.resolveLoginShellPath()).resolves.toBe(process.env.PATH ?? '');
      expect(spawnMock).not.toHaveBeenCalled();
      expect(warnMock).not.toHaveBeenCalled();
    });
  });
});
