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
    sensitiveDirs: [], networkEnabled: false, ...over,
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
});