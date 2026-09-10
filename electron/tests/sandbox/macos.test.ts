// electron/tests/sandbox/macos.test.ts
// Seatbelt 无法在 Linux 容器实测——快照测试锁 profile 字符串，
// macOS 主机验收（spec §8）负责真机迭代。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderSeatbeltProfile } from '../../src/main/sandbox/macos';
import type { ShellSandboxPolicy } from '../../src/main/sandbox/types';

function mkPolicy(over: Partial<ShellSandboxPolicy> = {}): ShellSandboxPolicy {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'));
  createdTmpDirs.push(tmp);
  return {
    workspaceDir: tmp, homeDir: '/Users/dev', tmpDir: '/private/var/folders/xx/T',
    sensitiveDirs: ['/Users/dev/.ssh'], networkEnabled: false, ...over,
  };
}

const createdTmpDirs: string[] = [];
afterEach(() => {
  for (const dir of createdTmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('renderSeatbeltProfile', () => {
  it('骨架：deny default + 全盘读 + workspace/tmp 写 + 进程放行', () => {
    const p = renderSeatbeltProfile(mkPolicy());
    expect(p).toContain('(version 1)');
    expect(p).toContain('(deny default)');
    expect(p).toContain('(allow file-read* (subpath "/"))');
    expect(p).toContain('(allow file-write*');
    expect(p).toContain('(allow process-exec process-fork)');
  });

  it('敏感目录生成后置 deny 规则（覆盖前置 allow read）', () => {
    const p = renderSeatbeltProfile(mkPolicy({ sensitiveDirs: ['/Users/dev/.ssh', '/Users/dev/.gnupg'] }));
    expect(p.indexOf('(deny file-read* (subpath "/Users/dev/.ssh"))')).toBeGreaterThan(p.indexOf('(allow file-read* (subpath "/"))'));
    expect(p).toContain('(subpath "/Users/dev/.gnupg")');
  });

  it('网络关 → 无 network-outbound；开 → allow', () => {
    expect(renderSeatbeltProfile(mkPolicy({ networkEnabled: false }))).not.toContain('network-outbound');
    expect(renderSeatbeltProfile(mkPolicy({ networkEnabled: true }))).toContain('(allow network-outbound)');
  });

  it('路径含空格/引号转义', () => {
    const p = renderSeatbeltProfile(mkPolicy({ workspaceDir: '/Users/dev/My "Work" Space' }));
    expect(p).toContain('My \\"Work\\" Space');
  });

  it('完整快照（网络关）', () => {
    // 固定路径避免 mkdtempSync 后缀漂移——只锁 profile 字符串结构
    const p: ShellSandboxPolicy = {
      workspaceDir: '/Users/dev/snapshot-ws',
      homeDir: '/Users/dev',
      tmpDir: '/private/var/folders/xx/T',
      sensitiveDirs: ['/Users/dev/.ssh'],
      networkEnabled: false,
    };
    expect(renderSeatbeltProfile(p)).toMatchInlineSnapshot(`
      "(version 1)
      (deny default)
      (allow file-read* (subpath "/"))
      (deny file-read* (subpath "/Users/dev/.ssh"))
      (allow file-write* (subpath "/Users/dev/snapshot-ws") (subpath "/private/var/folders/xx/T") (subpath "/private/tmp"))
      (allow process-exec process-fork)
      (allow signal (target self))
      (allow file-ioctl sysctl-read mach-lookup)
      "
    `);
  });
});
