// electron/tests/agent/tools/git-tools.win32.test.ts
//
// resolveRepoPath 的 toPosixRelPath 路径（v2.10 T2：git-tools 本地 toPosixRel
// 退役改 import 共享 helper——纯搬家，调用点语义不变）win32 语义测试。
// 模板来源：tests/platform/paths.win32.test.ts 文件头。
//
// brief 用例：'C:\WS' 根与 'c:\ws\services\api' 命中——发现列表第二项刻意
// 用小写盘符变体，锁「win32 大小写不敏感 relative 归一后命中发现条目」。
//
// mock 策略：
//   - node:path → win32（模板）
//   - git/repos → 固定仓清单（真实 discoverRepos 走 Linux fs 对 win32 形态
//     恒空，不可用；真实发现行为由 git-tools-repo.test.ts 真实 git fixture
//     覆盖）
//   - node:fs → NTFS 模拟（同 workspace-fs.win32.test.ts 策略，根 'C:\WS'）
//     ——WorkspaceFS 构造与 assertInWorkspace 的 realpath/exists 探测需要
import { describe, it, expect, vi } from 'vitest';
import { resolveRepoPath } from '../../../src/main/agent/tools/git-tools';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { default: actual.win32, ...actual.win32 };
});

const { mockRepos } = vi.hoisted(() => ({
  mockRepos: { list: ['C:\\WS', 'c:\\ws\\services\\api'] as string[] },
}));

vi.mock('../../../src/main/git/repos', () => ({
  discoverRepos: () => mockRepos.list,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const ROOT = 'C:\\WS';
  const lowerRoot = ROOT.toLowerCase();
  const canon = (p: string): string =>
    p.toLowerCase().startsWith(lowerRoot) ? ROOT + p.slice(ROOT.length) : p;
  return {
    default: {
      ...actual,
      realpathSync: (p: string) => canon(p),
      existsSync: (p: string) => typeof p === 'string' && p.toLowerCase().startsWith(lowerRoot),
    },
  };
});

function mkWsFs(): WorkspaceFS {
  return new WorkspaceFS('C:\\WS');
}

describe('resolveRepoPath（win32 语义）', () => {
  it('缺省（undefined）→ workspace 根', () => {
    expect(resolveRepoPath('C:\\WS', mkWsFs(), undefined)).toBe('C:\\WS');
  });

  it('反斜杠相对 repo 命中「盘符大小写变体」发现条目：返回发现列表原始路径', () => {
    // 发现列表第二项 'c:\ws\services\api'（小写盘符）经 win32 大小写不敏感
    // relative 归一后与输入 'services\api' 同为 'services/api'，命中并原样返回
    expect(resolveRepoPath('C:\\WS', mkWsFs(), 'services\\api')).toBe('c:\\ws\\services\\api');
  });

  it("根仓形态 '.' 命中 workspaceDir", () => {
    expect(resolveRepoPath('C:\\WS', mkWsFs(), '.')).toBe('C:\\WS');
  });

  it('未命中 → 错误含「不在发现列表」与可用清单', () => {
    expect(() => resolveRepoPath('C:\\WS', mkWsFs(), 'nope')).toThrow(/不在发现列表/);
    expect(() => resolveRepoPath('C:\\WS', mkWsFs(), 'nope')).toThrow(/services\/api/);
  });

  it('绝对路径拒绝（repo 契约是 workspace 相对路径）', () => {
    expect(() => resolveRepoPath('C:\\WS', mkWsFs(), 'C:\\WS\\services\\api')).toThrow('绝对路径');
  });

  it("相对 repo '..' 越界拒绝", () => {
    expect(() => resolveRepoPath('C:\\WS', mkWsFs(), '..\\outside')).toThrow('路径越界');
  });
});
