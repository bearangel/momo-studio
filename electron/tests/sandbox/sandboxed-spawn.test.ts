// electron/tests/sandbox/sandboxed-spawn.test.ts
//
// resolveSandboxedSpawn 锁（spec 2026-11-03 §5.2）：任意 argv 包裹、网络恒关、
// 三态语义与 resolveShellSpawn 对齐。平台分支用 skipIf 保证跨宿主绿。
import fs from 'node:fs';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSandboxedSpawn } from '../../src/main/sandbox';
import { __setSandboxStateForTest } from '../../src/main/sandbox/probe';
import { __setSandboxSettingsForTest } from '../../src/main/sandbox/settings';

const ARGV = [process.execPath, '/tmp/momo-boot-fake.js', '/ws'];

/** 测试用探测状态构造器（SandboxProbeState 全 8 字段；沙箱不可用 = sandboxTool null） */
function probeState(sandboxTool: 'seatbelt' | 'bwrap' | null, unavailableReason: string | null) {
  return {
    platform: process.platform, sandboxTool, toolVersion: null,
    available: sandboxTool !== null, unavailableReason, windowsShell: null,
    executionPolicy: null, probedAt: 0,
  };
}

beforeEach(() => {
  // 语义默认：strict + 拒网（blocked 分支依赖；permissive 用例内显式覆盖）
  __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'deny' });
});

afterEach(() => {
  __setSandboxStateForTest(null);
  __setSandboxSettingsForTest(null);
});

describe('resolveSandboxedSpawn（任意 argv 包裹，net-off 固定）', () => {
  it('空 argv → 抛错', () => {
    expect(() => resolveSandboxedSpawn('/ws', [])).toThrow('argv');
  });

  it('沙箱不可用 + strict → blocked（含安装指引）', () => {
    __setSandboxStateForTest(probeState(null, '单测模拟不可用'));
    const plan = resolveSandboxedSpawn('/ws', ARGV);
    expect(plan.kind).toBe('blocked');
    if (plan.kind === 'blocked') expect(plan.reason).toContain('沙箱');
  });

  it('沙箱不可用 + permissive → plain 直跑（tag 标注 unsandboxed）', () => {
    __setSandboxStateForTest(probeState(null, '单测模拟不可用'));
    __setSandboxSettingsForTest({ mode: 'permissive', networkPolicy: 'deny' });
    const plan = resolveSandboxedSpawn('/ws', ARGV);
    expect(plan.kind).toBe('plain');
    if (plan.kind === 'plain') {
      expect(plan.shell).toBe(ARGV[0]);
      expect(plan.args).toEqual(ARGV.slice(1));
      expect(plan.tag).toContain('unsandboxed');
    }
  });

  it.skipIf(process.platform !== 'darwin')('darwin+seatbelt → wrapped：-f profile + argv 透传 + cleanupFiles', () => {
    __setSandboxStateForTest(probeState('seatbelt', null));
    const plan = resolveSandboxedSpawn('/ws', ARGV);
    expect(plan.kind).toBe('wrapped');
    if (plan.kind === 'wrapped') {
      expect(plan.tag).toBe('seatbelt/net-off');
      expect(plan.args[0]).toBe('-f');
      expect(fs.existsSync(plan.args[1]!)).toBe(true); // profile 已写盘
      expect(plan.args.slice(2)).toEqual(ARGV);
      expect(plan.cleanupFiles).toHaveLength(1);
      // net-off 的 OS 层断言（终审 triage）：profile 必须 (deny default) 且不含 allow network*
      const profile = fs.readFileSync(plan.args[1]!, 'utf-8');
      expect(profile).toContain('(deny default)');
      expect(profile).not.toContain('(allow network*');
      try { fs.unlinkSync(plan.args[1]!); } catch { /* 清理容错 */ }
    }
  });

  it.skipIf(process.platform !== 'linux')('linux+bwrap → wrapped：bwrapArgs + argv 透传', () => {
    __setSandboxStateForTest(probeState('bwrap', null));
    const plan = resolveSandboxedSpawn('/ws', ARGV);
    expect(plan.kind).toBe('wrapped');
    if (plan.kind === 'wrapped') {
      expect(plan.tag).toBe('bwrap/net-off');
      expect(plan.args.slice(-ARGV.length)).toEqual(ARGV);
      // net-off 的 OS 层断言（终审 triage）：bwrap 必须带 --unshare-net
      expect(plan.args).toContain('--unshare-net');
    }
  });

  it('profile 落盘于 os.tmpdir（不污染 workspace）', () => {
    __setSandboxStateForTest(
      process.platform === 'darwin'
        ? probeState('seatbelt', null)
        : probeState(null, '非 darwin'),
    );
    const plan = resolveSandboxedSpawn('/ws', ARGV);
    if (plan.kind === 'wrapped' && plan.cleanupFiles.length > 0) {
      expect(plan.cleanupFiles[0]!.startsWith(os.tmpdir())).toBe(true);
    }
  });
});
