// electron/tests/sandbox/resolve-spawn.test.ts
//
// resolveShellSpawn 决策测试（v2.4.x 网络接线；2026-09-13 修订 B 双态化）：
//   - 双态推导：allow → net-on / deny → net-off
//   - opts.networkEnabled 显式覆盖（shell-tools 经策略查询桥解析 netOn 后传入——
//     接线锁：策略翻转后下一条 spawn 的 tag 随之变化）
//   - 既有基线：平台分支 / strict 阻断 / permissive 降级
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveShellSpawn, sandboxInstallHint } from '../../src/main/sandbox';
import { __setSandboxStateForTest } from '../../src/main/sandbox/probe';
import { __setSandboxSettingsForTest } from '../../src/main/sandbox/settings';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-spawn-'));
const linuxAvail = { platform: 'linux' as NodeJS.Platform, sandboxTool: 'bwrap' as const, toolVersion: 'bubblewrap 0.10',
  available: true, unavailableReason: null, windowsShell: null, executionPolicy: null, probedAt: 0 };
const linuxMissing = { ...linuxAvail, sandboxTool: null, toolVersion: null, available: false, unavailableReason: 'bwrap 未安装' };
const winState = { platform: 'win32' as NodeJS.Platform, sandboxTool: null, toolVersion: null, available: false,
  unavailableReason: null, windowsShell: 'pwsh.exe', executionPolicy: 'Restricted', probedAt: 0 };

beforeEach(() => { __setSandboxSettingsForTest(null); __setSandboxStateForTest(null); });

// 注：win32 分支测试需 mock process.platform——用 Object.defineProperty；
// linux 容器天然走 linux 分支。darwin 分支无法在本平台触发 → 用 mock platform 测。

describe('resolveShellSpawn 网络双态推导（修订 B）', () => {
  it('policy=allow → net-on（bwrap args 无 --unshare-net）', () => {
    __setSandboxStateForTest(linuxAvail);
    __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'allow' });
    const plan = resolveShellSpawn(tmp, 'x');
    if (plan.kind !== 'wrapped') throw new Error('应 wrapped');
    expect(plan.tag).toBe('bwrap/net-on');
    expect(plan.args).not.toContain('--unshare-net');
  });

  it('policy=deny → net-off（--unshare-net 在 args 里）', () => {
    __setSandboxStateForTest(linuxAvail);
    __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'deny' });
    const plan = resolveShellSpawn(tmp, 'x');
    if (plan.kind !== 'wrapped') throw new Error('应 wrapped');
    expect(plan.tag).toBe('bwrap/net-off');
    expect(plan.args).toContain('--unshare-net');
  });

  it('接线锁：opts.networkEnabled 显式覆盖双态（deny 基线下显式 netOn 翻转下一条 spawn tag）', () => {
    __setSandboxStateForTest(linuxAvail);
    __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'deny' });
    // 主进程策略查询解析 netOn 后显式传入（deny → false；allow → true）
    const beforeFlip = resolveShellSpawn(tmp, 'x', { networkEnabled: false });
    const afterFlip = resolveShellSpawn(tmp, 'x', { networkEnabled: true });
    if (beforeFlip.kind !== 'wrapped' || afterFlip.kind !== 'wrapped') throw new Error('应 wrapped');
    expect(beforeFlip.tag).toBe('bwrap/net-off');
    expect(afterFlip.tag).toBe('bwrap/net-on');
    expect(afterFlip.args).not.toContain('--unshare-net');
  });

  it('接线锁：opts 覆盖压过 allow 策略（显式 net-off 时代）', () => {
    __setSandboxStateForTest(linuxAvail);
    __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'allow' });
    const plan = resolveShellSpawn(tmp, 'x', { networkEnabled: false });
    if (plan.kind !== 'wrapped') throw new Error('应 wrapped');
    expect(plan.tag).toBe('bwrap/net-off');
  });
});

describe('resolveShellSpawn 平台分支（既有基线）', () => {
  it('linux + bwrap 可用 → wrapped：bwrap 前缀 + bash -c 收尾 + 缓存 env 注入', () => {
    __setSandboxStateForTest(linuxAvail);
    __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'deny' });
    const plan = resolveShellSpawn(tmp, 'echo hi');
    expect(plan.kind).toBe('wrapped');
    if (plan.kind !== 'wrapped') return;
    expect(plan.shell).toBe('bwrap');
    expect(plan.args[plan.args.length - 2]).toBe('-c');
    expect(plan.args[plan.args.length - 1]).toBe('echo hi');
    expect(plan.tag).toBe('bwrap/net-off');
    expect(plan.envAdditions.npm_config_cache).toContain('npm-cache');
    expect(plan.envAdditions.PIP_CACHE_DIR).toContain('pip-cache');
  });

  it('网络开关驱动 bwrap args（关 → --unshare-net 在 args 里）', () => {
    __setSandboxStateForTest(linuxAvail);
    __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'deny' });
    const p1 = resolveShellSpawn(tmp, 'x');
    __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'allow' });
    const p2 = resolveShellSpawn(tmp, 'x');
    if (p1.kind !== 'wrapped' || p2.kind !== 'wrapped') throw new Error('应 wrapped');
    expect(p1.args).toContain('--unshare-net');
    expect(p2.args).not.toContain('--unshare-net');
  });

  it('linux + 不可用 + strict → blocked（文案含安装指引 + permissive 逃生门）', () => {
    __setSandboxStateForTest(linuxMissing);
    __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'allow' });
    const plan = resolveShellSpawn(tmp, 'echo hi');
    expect(plan.kind).toBe('blocked');
    if (plan.kind !== 'blocked') return;
    expect(plan.reason).toContain('bubblewrap');
    expect(plan.reason).toContain('permissive');
  });

  it('linux + 不可用 + permissive → plain + unsandboxed tag', () => {
    __setSandboxStateForTest(linuxMissing);
    __setSandboxSettingsForTest({ mode: 'permissive', networkPolicy: 'deny' });
    const plan = resolveShellSpawn(tmp, 'echo hi');
    expect(plan.kind).toBe('plain');
    if (plan.kind !== 'plain') return;
    expect(plan.shell).toBe('/bin/bash');
    expect(plan.tag).toBe('unsandboxed:bwrap 未安装');
  });

  it('win32（platform mock）→ plain + powershell + 不带 -ExecutionPolicy Bypass（不消费网络态）', () => {
    const desc = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      __setSandboxStateForTest(winState);
      __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'allow' });
      const plan = resolveShellSpawn(tmp, 'Write-Output hi');
      expect(plan.kind).toBe('plain');
      if (plan.kind !== 'plain') return;
      expect(plan.shell).toBe('pwsh.exe');
      expect(plan.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', 'Write-Output hi']);
      expect(plan.tag).toBe('win-powershell');
    } finally { desc && Object.defineProperty(process, 'platform', desc); }
  });

  it('win32（platform mock）：无论双态/opts 如何，winpolicy 均不消费网络布尔（Windows 核实结论锁）', () => {
    const desc = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      __setSandboxStateForTest(winState);
      for (const net of [true, false]) {
        const plan = resolveShellSpawn(tmp, 'x', { networkEnabled: net });
        expect(plan.kind).toBe('plain');
        if (plan.kind !== 'plain') return;
        expect(plan.tag).toBe('win-powershell'); // tag 恒定——无 net-off 概念，信任门永不触发
      }
    } finally { desc && Object.defineProperty(process, 'platform', desc); }
  });

  it('darwin（platform mock）+ seatbelt 可用 → wrapped + profile 文件已写 + 登记 cleanupFiles', () => {
    const desc = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      __setSandboxStateForTest({ platform: 'darwin', sandboxTool: 'seatbelt', toolVersion: null,
        available: true, unavailableReason: null, windowsShell: null, executionPolicy: null, probedAt: 0 });
      __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'deny' });
      const plan = resolveShellSpawn(tmp, 'echo hi');
      expect(plan.kind).toBe('wrapped');
      if (plan.kind !== 'wrapped') return;
      expect(plan.shell).toBe('sandbox-exec');
      expect(plan.tag).toBe('seatbelt/net-off');
      // -f = profile 从文件读（-p 是把参数当 SBPL 字符串解析——传文件路径会整串
      // 被当成未绑定变量，主机实测 exit 65「unbound variable」）
      expect(plan.args[0]).toBe('-f');
      const profile = plan.args[1]!;
      expect(fs.existsSync(profile)).toBe(true);
      expect(plan.cleanupFiles).toEqual([profile]);
      fs.rmSync(profile, { force: true });
    } finally { desc && Object.defineProperty(process, 'platform', desc); }
  });
});

describe('sandboxInstallHint（blocked 文案按平台分支，主机验收 P0 修复）', () => {
  it('darwin → 系统内置指引，不含 Linux 安装命令', () => {
    const hint = sandboxInstallHint('darwin');
    expect(hint).toContain('内置');
    expect(hint).toContain('permissive'); // 逃生门两平台共有
    expect(hint).not.toContain('apt install');
    expect(hint).not.toContain('bubblewrap');
  });

  it('linux → bwrap 安装指引保持原样（既有断言的文案基线）', () => {
    const hint = sandboxInstallHint('linux');
    expect(hint).toContain('bubblewrap');
    expect(hint).toContain('permissive');
  });

  it('darwin（platform mock）+ 未探测 + strict → blocked 文案走 darwin 分支', () => {
    const desc = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      __setSandboxStateForTest(null);
      __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'deny' });
      const plan = resolveShellSpawn(tmp, 'echo hi');
      expect(plan.kind).toBe('blocked');
      if (plan.kind !== 'blocked') return;
      expect(plan.reason).toContain('沙箱未探测');
      expect(plan.reason).toContain('内置');
      expect(plan.reason).not.toContain('apt install');
    } finally { desc && Object.defineProperty(process, 'platform', desc); }
  });
});
