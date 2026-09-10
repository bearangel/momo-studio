// electron/tests/sandbox/bwrap-integration.test.ts
// 真实 bwrap 集成（容器 user namespace 被拦时自动 skip，spec §7）。
// 不造假绿（momo-test-rules）：容器 seccomp 拦 clone(CLONE_NEWUSER) 时
// bwrap 冒烟失败 → bwrapOk=false → describe.skipIf 整组跳过并在输出中可见；
// 仅当 bwrap 真实可用（macOS 主机 / 配置了 user namespace 的 Linux）时才执行断言。
import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveShellSpawn } from '../../src/main/sandbox';
import { __setSandboxStateForTest } from '../../src/main/sandbox/probe';
import { __setSandboxSettingsForTest } from '../../src/main/sandbox/settings';

const run = promisify(execFile);

// skipIf 在 collection 期求值——必须同步探测（beforeAll 太晚）
const bwrapOk = (() => {
  try { execSync('bwrap --ro-bind / / /bin/echo ok', { stdio: 'ignore', timeout: 5000 }); return true; }
  catch { return false; }
})();

describe.skipIf(!bwrapOk)('真实 bwrap 沙箱（容器拦 user namespace 时整组跳过）', () => {
  // 清理模块级单例测试钩子——防泄漏污染同 worker 内后续测试文件
  afterEach(() => {
    __setSandboxStateForTest(null);
    __setSandboxSettingsForTest(null);
  });

  it('workspace 内写文件成功', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-ws-'));
    __setSandboxStateForTest({ platform: 'linux', sandboxTool: 'bwrap', toolVersion: 'test',
      available: true, unavailableReason: null, windowsShell: null, executionPolicy: null, probedAt: 0 });
    __setSandboxSettingsForTest({ mode: 'strict', networkEnabled: false });
    const plan = resolveShellSpawn(ws, `echo hi > ${JSON.stringify(path.join(ws, 'out.txt'))}`);
    if (plan.kind !== 'wrapped') throw new Error('应 wrapped');
    await run(plan.shell, plan.args, { timeout: 10_000 }).catch(() => undefined);
    expect(fs.existsSync(path.join(ws, 'out.txt'))).toBe(true);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('workspace 外写被拒（只读文件系统）', async () => {
    const outside = path.join(os.homedir(), `momo-sbx-${Date.now()}.txt`);
    __setSandboxStateForTest({ platform: 'linux', sandboxTool: 'bwrap', toolVersion: 'test',
      available: true, unavailableReason: null, windowsShell: null, executionPolicy: null, probedAt: 0 });
    __setSandboxSettingsForTest({ mode: 'strict', networkEnabled: false });
    const plan = resolveShellSpawn(os.tmpdir(), `echo x > ${JSON.stringify(outside)}`);
    if (plan.kind !== 'wrapped') throw new Error('应 wrapped');
    // 断言文件系统副作用而非退出码——bwrap 失败形态是 EROFS 报错（exit 非 0，catch 吞掉）
    await run(plan.shell, plan.args, { timeout: 10_000 }).catch(() => undefined);
    expect(fs.existsSync(outside)).toBe(false);
    if (fs.existsSync(outside)) fs.rmSync(outside, { force: true });
  });
});
