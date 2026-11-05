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
    sensitiveDirs: ['/Users/dev/.ssh'], networkEnabled: false, extraWriteDirs: [], writeScope: 'confined', ...over,
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

  it('网络关 → 无 network 放行；开 → allow network*（含 bind/inbound——dev server 监听场景）', () => {
    expect(renderSeatbeltProfile(mkPolicy({ networkEnabled: false }))).not.toContain('network');
    expect(renderSeatbeltProfile(mkPolicy({ networkEnabled: true }))).toContain('(allow network*)');
  });

  it('/dev/null 写入常态放行（shell 重定向惯用法 2>/dev/null）', () => {
    const profile = renderSeatbeltProfile(mkPolicy({ networkEnabled: false }));
    expect(profile).toContain('(allow file-write* (literal "/dev/null"))');
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
      extraWriteDirs: [],
      writeScope: 'confined',
    };
    expect(renderSeatbeltProfile(p)).toMatchInlineSnapshot(`
      "(version 1)
      (deny default)
      (allow file-read* (subpath "/"))
      (deny file-read* (subpath "/Users/dev/.ssh"))
      (allow file-write* (subpath "/Users/dev/snapshot-ws") (subpath "/private/var/folders/xx/T") (subpath "/private/tmp"))
      (allow file-write* (literal "/dev/null"))
      (allow process-exec process-fork)
      (allow signal (target self))
      (allow file-ioctl sysctl-read mach-lookup)
      "
    `);
  });

  it('授权态：工具链目录逐个出现在 allow file-write*，deny default 语义不变', () => {
    const p = mkPolicy({
      networkEnabled: true,
      extraWriteDirs: ['/Users/dev/.rustup', '/Users/dev/.cargo'],
    });
    const prof = renderSeatbeltProfile(p);
    expect(prof).toContain('(allow file-write* (subpath "/Users/dev/.rustup"))');
    expect(prof).toContain('(allow file-write* (subpath "/Users/dev/.cargo"))');
    // 敏感 deny 不受授权影响（后置覆盖语义保留——授权只扩写维度，不动读遮蔽）
    expect(prof).toContain('(deny file-read* (subpath "/Users/dev/.ssh"))');
  });

  it('未授权（空数组）：profile 无任何工具链目录行（默认安全方向）', () => {
    const prof = renderSeatbeltProfile(mkPolicy({ extraWriteDirs: [] }));
    expect(prof).not.toContain('.rustup');
    expect(prof).not.toContain('.cargo');
  });

  it('授权目录不存在仍渲染 allow 行（终审 F1：macOS 全量渲染语义——pip:user 首装前 ~/Library/Python 不存在，安装动作会创建它，spec §9「授权即生效」）', () => {
    const prof = renderSeatbeltProfile(mkPolicy({ extraWriteDirs: ['/Users/dev/Library/Python'] }));
    expect(prof).toContain('(allow file-write* (subpath "/Users/dev/Library/Python"))');
  });
});

describe('renderSeatbeltProfile full-disk 写域（2026-11-05 spec §5.4）', () => {
  const fd: ShellSandboxPolicy = {
    workspaceDir: '/Users/dev/snapshot-ws', homeDir: '/Users/dev',
    tmpDir: '/private/var/folders/xx/T', sensitiveDirs: ['/Users/dev/.ssh'],
    networkEnabled: false, extraWriteDirs: [], writeScope: 'full-disk',
  };

  it('快照：全盘 allow → 核心 deny 逐条 → /usr/local re-allow 殿后（后匹配优先——次序即正确性）', () => {
    expect(renderSeatbeltProfile(fd)).toMatchInlineSnapshot(`
      "(version 1)
      (deny default)
      (allow file-read* (subpath "/"))
      (deny file-read* (subpath "/Users/dev/.ssh"))
      (allow file-write* (subpath "/"))
      (deny file-write* (subpath "/System"))
      (deny file-write* (subpath "/bin"))
      (deny file-write* (subpath "/sbin"))
      (deny file-write* (subpath "/usr"))
      (deny file-write* (subpath "/etc"))
      (deny file-write* (subpath "/private/etc"))
      (deny file-write* (subpath "/Library"))
      (deny file-write* (subpath "/Users/dev/.ssh"))
      (allow file-write* (subpath "/usr/local"))
      (allow file-write* (literal "/dev/null"))
      (allow process-exec process-fork)
      (allow signal (target self))
      (allow file-ioctl sysctl-read mach-lookup)
      "
    `);
  });

  it('次序锁：全盘 allow 在所有核心 deny 之前；re-allow 在 deny /usr 之后', () => {
    const p = renderSeatbeltProfile(fd);
    expect(p.indexOf('(allow file-write* (subpath "/"))')).toBeLessThan(p.indexOf('(deny file-write* (subpath "/System"))'));
    expect(p.indexOf('(allow file-write* (subpath "/usr/local"))')).toBeGreaterThan(p.indexOf('(deny file-write* (subpath "/usr"))'));
  });

  it('sensitiveDirs 读遮蔽共存（写域与读遮蔽正交）', () => {
    expect(renderSeatbeltProfile(fd)).toContain('(deny file-read* (subpath "/Users/dev/.ssh"))');
  });

  it('confined 态无全盘写行（既有行为反证）', () => {
    const c = { ...fd, writeScope: 'confined' as const };
    expect(renderSeatbeltProfile(c)).not.toContain('(allow file-write* (subpath "/"))');
  });

  it('full-disk 态 extraWriteDirs 授权行不渲染（全盘 allow 已覆盖，spec §5.4 省略语义）', () => {
    const p = renderSeatbeltProfile({ ...fd, extraWriteDirs: ['/Users/dev/.rustup'] });
    expect(p).not.toContain('.rustup');
  });
});

describe('renderSeatbeltProfile full-disk 凭据写遮蔽（终审 F1 修复，2026-11-05）', () => {
  // 主机实证：full-disk 语义下 file-read* deny 不拦写——新建/覆写/整目录替换
  // 三向量全部穿透（authorized_keys 植入面）。修复：full-disk 分支对 sensitiveDirs
  // 追加 file-write* deny（后匹配优先压过 allow /），与 Linux tmpfs 遮蔽语义对齐。
  const fd: ShellSandboxPolicy = {
    workspaceDir: '/Users/dev/ws', homeDir: '/Users/dev',
    tmpDir: '/private/var/folders/xx/T', sensitiveDirs: ['/Users/dev/.ssh', '/Users/dev/.gnupg'],
    networkEnabled: false, extraWriteDirs: [], writeScope: 'full-disk',
  };

  it('sensitiveDirs 逐条生成 file-write* deny（读写双遮蔽）', () => {
    const p = renderSeatbeltProfile(fd);
    expect(p).toContain('(deny file-write* (subpath "/Users/dev/.ssh"))');
    expect(p).toContain('(deny file-write* (subpath "/Users/dev/.gnupg"))');
  });

  it('次序锁：写 deny 在全盘 allow 之后（后匹配优先才生效），在读 deny 邻近处', () => {
    const p = renderSeatbeltProfile(fd);
    expect(p.indexOf('(deny file-write* (subpath "/Users/dev/.ssh"))'))
      .toBeGreaterThan(p.indexOf('(allow file-write* (subpath "/"))'));
  });

  it('confined 态不新增写 deny（deny default 已兜住——既有行为反证）', () => {
    const p = renderSeatbeltProfile({ ...fd, writeScope: 'confined' as const });
    expect(p).not.toContain('(deny file-write*');
  });
});
