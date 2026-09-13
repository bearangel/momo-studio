// electron/tests/files/workspace-fs.win32.test.ts
//
// assertInWorkspace 的 win32 路径语义测试（v2.10 Windows 全平台化 T2）。
// 模板来源：tests/platform/paths.win32.test.ts 文件头（T1 落地形态）。
//
// mock 策略（brief 裁定：realpath 反逃逸链保持——win32 用例聚焦比对逻辑段，
// 该链的 posix 符号链接行为由 workspace-fs.test.ts 既有用例覆盖）：
//   - node:path → path.win32（模板：工厂内 importActual 取 .win32 双形态返回）
//   - node:fs → 模拟 NTFS 大小写不敏感文件系统：realpathSync 按「根前缀回写
//     规范大小写」模拟 case-preserving 解析（真实 Windows 行为——realpathSync
//     返回盘上规范大小写形态）；existsSync 按小写前缀命中。Linux 真实 fs 解析
//     win32 形态路径必 ENOENT，realpath/exists 探测只能经 mock 覆盖 win32 形态
//   - process.platform 不 mock（模板明示禁止）——平台分叉经 isInsideDir 显式
//     win32 入口（PATH_SEMANTICS_WIN32：随当前 path 模块 sep 分叉）
// mock 工厂被提升到文件顶部、不能引用外部变量——规范根 'C:\WS\proj' 在工厂内
// 以字面量书写，与下方用例保持一致。
import { describe, it, expect, vi } from 'vitest';
import { WorkspaceFS } from '../../src/main/files/workspace-fs';

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { default: actual.win32, ...actual.win32 };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const ROOT = 'C:\\WS\\proj';
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

describe('WorkspaceFS.assertInWorkspace（win32 语义）', () => {
  it('大小写混合输入命中（NTFS 大小写不敏感）：返回 normalize 后原大小写路径', () => {
    const wsFs = new WorkspaceFS('C:\\WS\\proj');
    expect(wsFs.assertInWorkspace('c:\\ws\\proj\\a.txt')).toBe('c:\\ws\\proj\\a.txt');
  });

  it('正斜杠混合形态 + 大小写混合：win32 归一后命中', () => {
    const wsFs = new WorkspaceFS('C:\\WS\\proj');
    expect(wsFs.assertInWorkspace('c:/ws/proj/a.txt')).toBe('c:\\ws\\proj\\a.txt');
  });

  it("相对路径 '..' 穿越拒绝", () => {
    const wsFs = new WorkspaceFS('C:\\WS\\proj');
    expect(() => wsFs.assertInWorkspace('..\\outside')).toThrow('路径越界');
  });

  it('异盘绝对路径拒绝（d: 不是 c: 的子路径）', () => {
    const wsFs = new WorkspaceFS('C:\\WS\\proj');
    expect(() => wsFs.assertInWorkspace('d:\\ws\\proj\\a.txt')).toThrow('路径越界');
  });

  it('兄弟前缀目录不误伤（projX 不是 proj 子目录）', () => {
    const wsFs = new WorkspaceFS('C:\\WS\\proj');
    expect(() => wsFs.assertInWorkspace('C:\\WS\\projX\\a.txt')).toThrow('路径越界');
  });

  it('根自身命中（含大小写变体）', () => {
    const wsFs = new WorkspaceFS('C:\\WS\\proj');
    expect(wsFs.assertInWorkspace('.')).toBe('C:\\WS\\proj');
    expect(wsFs.assertInWorkspace('c:\\ws\\proj')).toBe('c:\\ws\\proj');
  });

  it('目录内点前缀文件名不误伤（..foo.txt 命中）', () => {
    const wsFs = new WorkspaceFS('C:\\WS\\proj');
    expect(wsFs.assertInWorkspace('..foo.txt')).toBe('C:\\WS\\proj\\..foo.txt');
  });
});
