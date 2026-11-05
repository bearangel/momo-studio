// electron/tests/agent/tools/sandboxed-exec.test.ts
//
// execSandboxed 行为锁（spec 2026-11-03 §5.2）：env 白名单 / 超时强杀 /
// 输出炸弹截断 / abort 即时中止 / 退出码与 stdio 透传。
// 全用例钉死 permissive + state=null → plain 路径（不依赖宿主沙箱可用性）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setSandboxStateForTest } from '../../../src/main/sandbox/probe';
import { __setSandboxSettingsForTest } from '../../../src/main/sandbox/settings';
import { execSandboxed } from '../../../src/main/agent/tools/shared/sandboxed-exec';

// 登录 shell PATH 探测替身（进程边界 mock，momo-test-rules）：探测结果钉为
// 确定目录，mergePathEntries 保留真实实现（与 shell-tools.test.ts 同形）。
vi.mock('../../../src/main/sandbox/path-resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/sandbox/path-resolve')>();
  return { ...actual, resolveLoginShellPath: vi.fn(async () => '/opt/momo-login-test/bin') };
});

const NODE = process.execPath;
// 测试环境为纯 node：ELECTRON_RUN_AS_NODE 是 no-op（无害）；打包环境 execPath=
// electron 二进制，该 env 使其以 node 模式启动——协议由本测试锁定。
const ENV = { ELECTRON_RUN_AS_NODE: '1' };
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-sbxexec-'));

beforeEach(() => {
  __setSandboxSettingsForTest({ mode: 'permissive', networkPolicy: 'deny', writePolicy: 'confined' });
  __setSandboxStateForTest({ platform: process.platform, sandboxTool: null, toolVersion: null, available: false, unavailableReason: '单测钉 plain', windowsShell: null, executionPolicy: null, probedAt: 0 });
});

afterEach(() => {
  __setSandboxStateForTest(null);
  __setSandboxSettingsForTest(null);
});

describe('execSandboxed（plain 路径行为锁）', () => {
  it('成功执行：退出码与 stdout 透传', async () => {
    const r = await execSandboxed({ argv: [NODE, '-e', "console.log('hello-sbx')"], cwd: tmpWs, timeoutMs: 10_000, maxOutputBytes: 64 * 1024, env: ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('hello-sbx');
    expect(r.timedOut).toBe(false);
  });

  it('非零退出码与 stderr 透传', async () => {
    const r = await execSandboxed({ argv: [NODE, '-e', "console.error('boom'); process.exit(3)"], cwd: tmpWs, timeoutMs: 10_000, maxOutputBytes: 64 * 1024, env: ENV });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('boom');
  });

  it('Review Focus：死循环脚本 → 超时强杀，Promise 必 resolve', async () => {
    const r = await execSandboxed({ argv: [NODE, '-e', 'while(true){}'], cwd: tmpWs, timeoutMs: 1_500, maxOutputBytes: 64 * 1024, env: ENV });
    expect(r.timedOut).toBe(true);
  });

  it('Review Focus：输出炸弹 → maxOutputBytes 截断并标注', async () => {
    const r = await execSandboxed({ argv: [NODE, '-e', "process.stdout.write('x'.repeat(3_000_000))"], cwd: tmpWs, timeoutMs: 10_000, maxOutputBytes: 1_000, env: ENV });
    expect(Buffer.byteLength(r.stdout, 'utf-8')).toBeLessThanOrEqual(1_000);
    expect(r.truncated).toBe(true);
  });

  it('abortSignal → 即时中止', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const r = await execSandboxed({ argv: [NODE, '-e', 'while(true){}'], cwd: tmpWs, timeoutMs: 10_000, maxOutputBytes: 64 * 1024, env: ENV, abortSignal: ac.signal });
    expect(r.aborted).toBe(true);
  });

  it('env 白名单：非白名单父进程变量不泄露', async () => {
    process.env.MOMO_SECRET_LEAK = 'should-not-leak';
    try {
      const r = await execSandboxed({ argv: [NODE, '-e', "console.log(process.env.MOMO_SECRET_LEAK ?? 'clean')"], cwd: tmpWs, timeoutMs: 10_000, maxOutputBytes: 64 * 1024, env: ENV });
      expect(r.stdout).toContain('clean');
    } finally {
      delete process.env.MOMO_SECRET_LEAK;
    }
  });

  it('req.env 追加变量可见（ELECTRON_RUN_AS_NODE 协议锁定）', async () => {
    const r = await execSandboxed({ argv: [NODE, '-e', 'console.log(process.env.ELECTRON_RUN_AS_NODE)'], cwd: tmpWs, timeoutMs: 10_000, maxOutputBytes: 64 * 1024, env: ENV });
    expect(r.stdout.trim()).toBe('1');
  });

  // 登录 shell PATH 工具链增补（2026-11-04 sdkman 事故回归锁）：与 bash 通道
  // （shell-tools.ts）同源——插件 run_js 子进程同样能看到登录 shell 工具链目录。
  it('PATH 增补登录 shell 工具链目录（只增值、不加键）', async () => {
    const r = await execSandboxed({ argv: [NODE, '-e', 'console.log(process.env.PATH)'], cwd: tmpWs, timeoutMs: 10_000, maxOutputBytes: 64 * 1024, env: ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('/opt/momo-login-test/bin');
  });

  it('strict + 沙箱不可用 → blocked 抛错（不静默降级）', async () => {
    __setSandboxStateForTest({ platform: process.platform, sandboxTool: null, toolVersion: null, available: false, unavailableReason: '单测模拟不可用', windowsShell: null, executionPolicy: null, probedAt: 0 });
    __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'deny', writePolicy: 'confined' });
    await expect(execSandboxed({ argv: [NODE, '-e', ''], cwd: tmpWs, timeoutMs: 1_000, maxOutputBytes: 1_000 })).rejects.toThrow('沙箱');
  });
});
