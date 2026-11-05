// electron/tests/sandbox/linux.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBwrapArgs } from '../../src/main/sandbox/linux';
import type { ShellSandboxPolicy } from '../../src/main/sandbox/types';

function mkPolicy(over: Partial<ShellSandboxPolicy> = {}): ShellSandboxPolicy {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-test-'));
  createdTmpDirs.push(tmp);
  return {
    workspaceDir: tmp, homeDir: tmp, tmpDir: os.tmpdir(),
    sensitiveDirs: [], networkEnabled: false, extraWriteDirs: [], writeScope: 'confined', ...over,
  };
}

const createdTmpDirs: string[] = [];
afterEach(() => {
  for (const dir of createdTmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildBwrapArgs', () => {
  it('基础结构：全盘 ro-bind + workspace bind + tmp bind + dev/proc + 会话加固', () => {
    const p = mkPolicy();
    const args = buildBwrapArgs(p);
    expect(args).toContain('--ro-bind'); expect(args).toContain('/');
    const wsIdx = args.indexOf('--bind');
    expect(args[wsIdx + 1]).toBe(p.workspaceDir);
    expect(args).toEqual(expect.arrayContaining(['--dev', '/dev', '--proc', '/proc']));
    expect(args).toContain('--new-session');
    expect(args).toContain('--die-with-parent');
  });

  it('网络关 → --unshare-net；网络开 → 无该 flag', () => {
    expect(buildBwrapArgs(mkPolicy({ networkEnabled: false }))).toContain('--unshare-net');
    expect(buildBwrapArgs(mkPolicy({ networkEnabled: true }))).not.toContain('--unshare-net');
  });

  it('敏感目录逐个 --tmpfs 覆盖', () => {
    const p = mkPolicy({ sensitiveDirs: ['/home/u/.ssh', '/home/u/.aws'] });
    const args = buildBwrapArgs(p);
    expect(args).toEqual(expect.arrayContaining(['--tmpfs', '/home/u/.ssh', '--tmpfs', '/home/u/.aws']));
  });

  it('敏感条目为普通文件（如 ~/.netrc）→ --ro-bind /dev/null 遮盖而非 tmpfs（审查 F4：tmpfs 挂不进文件）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-file-'));
    createdTmpDirs.push(tmp);
    const netrc = path.join(tmp, '.netrc');
    fs.writeFileSync(netrc, 'machine x login y password z');
    const dirEntry = path.join(tmp, '.ssh');
    fs.mkdirSync(dirEntry);
    const args = buildBwrapArgs(mkPolicy({ sensitiveDirs: [netrc, dirEntry] }));
    // 文件条目：/dev/null 只读遮盖（mount tmpfs 的目标必须是目录，否则 bwrap 整体失败）
    const fileIdx = args.indexOf(netrc);
    expect(args[fileIdx - 1]).toBe('/dev/null');
    expect(args[fileIdx - 2]).toBe('--ro-bind');
    // 目录条目：维持 tmpfs
    const dirIdx = args.indexOf(dirEntry);
    expect(args[dirIdx - 1]).toBe('--tmpfs');
  });

  it('快照：完整 args 数组稳定（网络关 + 一敏感目录）', () => {
    // 用固定 workspace 路径让快照与随机 tmpdir 后缀解耦——只锁 bwrap argv 结构
    const p: ShellSandboxPolicy = {
      workspaceDir: '/tmp/snapshot-ws',
      homeDir: '/home/snapshot',
      tmpDir: '/tmp',
      sensitiveDirs: ['/home/u/.ssh'],
      networkEnabled: false,
      extraWriteDirs: [],
      writeScope: 'confined',
    };
    expect(buildBwrapArgs(p)).toMatchInlineSnapshot(`
      [
        "--ro-bind",
        "/",
        "/",
        "--tmpfs",
        "/home/u/.ssh",
        "--bind",
        "/tmp/snapshot-ws",
        "/tmp/snapshot-ws",
        "--bind",
        "/tmp",
        "/tmp",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--unshare-net",
        "--new-session",
        "--die-with-parent",
      ]
    `);
  });

  it('授权态：存在目录每目录追加 --bind <dir> <dir>；未授权零追加（默认安全）', () => {
    // 终审 F1：存在性过滤下沉到本消费点——用磁盘真实目录断言 bind 形态
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-tc-'));
    createdTmpDirs.push(tmp);
    const real = path.join(tmp, '.rustup');
    fs.mkdirSync(real);
    const granted = buildBwrapArgs(mkPolicy({ extraWriteDirs: [real] }));
    expect(granted).toContain('--bind');
    const idx = granted.indexOf(real);
    expect(idx).toBeGreaterThan(0);
    expect(granted[idx - 1]).toBe('--bind');
    expect(granted[idx + 1]).toBe(real);
    const none = buildBwrapArgs(mkPolicy({ extraWriteDirs: [] }));
    expect(none.filter((a) => a === real)).toHaveLength(0);
  });

  it('授权态：不存在目录被过滤（bwrap 对不存在路径 --bind 硬失败——终审 F1 过滤下沉本消费点，policy 层全量透传）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-ghost-'));
    createdTmpDirs.push(tmp);
    const ghost = path.join(tmp, 'toolchain-ghost');
    const real = path.join(tmp, 'toolchain-real');
    fs.mkdirSync(real);
    const args = buildBwrapArgs(mkPolicy({ extraWriteDirs: [ghost, real] }));
    // 幽灵目录：零出现（单条不存在路径不得打挂整个会话的 spawn）
    expect(args.filter((a) => a === ghost)).toHaveLength(0);
    // 存在目录：正常 bind（过滤只剔除幽灵，不影响其余授权）
    expect(args[args.indexOf(real) - 1]).toBe('--bind');
  });
});
describe('buildBwrapArgs full-disk 写域（2026-11-05 spec §5.4）', () => {
  const fd: ShellSandboxPolicy = {
    workspaceDir: '/tmp/snapshot-ws', homeDir: '/home/snapshot', tmpDir: '/tmp',
    sensitiveDirs: ['/home/u/.ssh'], networkEnabled: false,
    extraWriteDirs: [], writeScope: 'full-disk',
  };

  it('次序锁：--bind / / 前置 → 敏感遮盖 → 核心 ro-bind → /usr/local re-bind 殿后', () => {
    const args = buildBwrapArgs(fd);
    const idx = (frag: string): number => args.indexOf(frag);
    expect(args.slice(0, 3)).toEqual(['--bind', '/', '/']);
    expect(idx('/home/u/.ssh')).toBeLessThan(idx('/usr/local'));       // 敏感遮盖在核心降级之前
    expect(idx('/usr/local')).toBeGreaterThan(args.lastIndexOf('--ro-bind')); // re-bind 殿后于全部 ro-bind
    expect(args.indexOf('/usr', idx('/usr/local'))).toBe(-1);          // /usr ro-bind 在 re-bind 之前且不重复
    expect(args).toContain('--tmpfs');
  });

  it('幽灵核心条目跳过：磁盘不存在的核心路径零出现且不抛（usr-merge/CI 无盘形态兜底）', () => {
    const args = buildBwrapArgs(fd);
    for (const core of ['/boot', '/lib', '/lib64']) {
      if (!fs.existsSync(core)) {
        expect(args.filter((a) => a === core)).toHaveLength(0);
      }
    }
  });

  it('confined 态首参仍为 --ro-bind / /（既有行为反证）', () => {
    expect(buildBwrapArgs({ ...fd, writeScope: 'confined' as const }).slice(0, 3))
      .toEqual(['--ro-bind', '/', '/']);
  });

  it('full-disk 态 extraWriteDirs 不追加独立 bind（全盘 RW 已覆盖，spec §5.4 省略语义）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-fd-tc-'));
    createdTmpDirs.push(tmp);
    const real = path.join(tmp, '.rustup');
    fs.mkdirSync(real);
    const args = buildBwrapArgs({ ...fd, extraWriteDirs: [real] });
    expect(args.filter((a) => a === real)).toHaveLength(0);
  });
});
