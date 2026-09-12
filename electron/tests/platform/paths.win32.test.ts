// electron/tests/platform/paths.win32.test.ts
// win32 路径语义测试。容器/CI 是 linux——经下方 vi.mock 把整棵被测模块图里的
// path 替换为 path.win32 实现（resolve / relative / sep 全 win32 语义）。
//
// ============================ win32 测试模板（供 T2 起后续任务直接复制） ============================
//
//   import { describe, it, expect, vi } from 'vitest';
//
//   vi.mock('node:path', async () => {
//     const actual = await vi.importActual<typeof import('node:path')>('node:path');
//     return { default: actual.win32, ...actual.win32 };
//   });
//
// 两个关键点：
//  1. 被测模块必须 import path from 'node:path'（带 node: 前缀）——vi.mock 按模块 ID
//     拦截，'node:path' 与 'path' 是两个不同 ID，mock 只命中前者（本仓既有约定即带前缀）；
//  2. mock 只改 path 对象语义，process.platform 仍是 linux——凡按平台分叉的逻辑需有
//     显式注入入口（如 isInsideDir 第三参 opts.win32），测试传 true 进 win32 分支。
//     不要试图 vi.mock('node:process') 或改 process.platform（污染全局、跨用例泄漏）。
//
// 另：mock 工厂被 vitest 提升到文件顶部，不能引用外部变量——path.win32 必须在工厂内
// 经 await vi.importActual('node:path') 取真实模块后取 .win32。
// ============================ 模板结束 ============================
import { describe, it, expect, vi } from 'vitest';
import { isInsideDir, toPosixRelPath } from '../../src/main/platform/paths';

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { default: actual.win32, ...actual.win32 };
});

describe('isInsideDir（win32 语义）', () => {
  it('大小写不敏感：盘符与目录段大小写混合仍命中', () => {
    expect(isInsideDir('C:\\WS', 'c:\\ws\\proj\\a.txt', { win32: true })).toBe(true);
  });

  it('默认分支走 process.platform：本环境（linux）严格比对，大小写不同即 false', () => {
    // 文档化默认行为——mock 环境下不传 opts 时按真实 platform（linux）分叉
    expect(isInsideDir('C:\\WS', 'c:\\ws\\proj\\a.txt')).toBe(false);
  });

  it('正斜杠混合形态：win32 resolve 归一后命中', () => {
    expect(isInsideDir('C:\\WS', 'c:/ws/proj/a.txt', { win32: true })).toBe(true);
  });

  it('UNC 路径：子路径命中（含服务器名大小写混合）', () => {
    expect(isInsideDir('\\\\srv\\share\\ws', '\\\\srv\\share\\ws\\proj\\a.txt', { win32: true })).toBe(true);
    expect(isInsideDir('\\\\SRV\\Share\\WS', '\\\\srv\\share\\ws\\a', { win32: true })).toBe(true);
  });

  it('异盘拒绝：C: 与 c: 同盘但 d: 是另一个根', () => {
    expect(isInsideDir('C:\\other\\x', 'c:\\ws', { win32: true })).toBe(false);
    expect(isInsideDir('c:\\ws', 'C:\\other\\x', { win32: true })).toBe(false);
    expect(isInsideDir('C:\\ws', 'd:\\ws\\a', { win32: true })).toBe(false);
  });

  it("'..' 前缀文件名不误伤：目录内 ..foo.txt 命中，兄弟前缀 wsfoo.txt 拒绝", () => {
    expect(isInsideDir('C:\\ws', 'C:\\ws\\..foo.txt', { win32: true })).toBe(true);
    expect(isInsideDir('C:\\ws', 'C:\\wsfoo.txt', { win32: true })).toBe(false);
  });

  it('自身命中（含大小写变体）', () => {
    expect(isInsideDir('C:\\ws', 'C:\\ws', { win32: true })).toBe(true);
    expect(isInsideDir('C:\\ws', 'c:\\wS', { win32: true })).toBe(true);
  });

  it("'..' 穿越出根拒绝", () => {
    expect(isInsideDir('C:\\ws', 'C:\\ws\\..\\other\\a.txt', { win32: true })).toBe(false);
  });

  it('非法输入返回 false（win32 态同口径）', () => {
    expect(isInsideDir('', 'C:\\ws', { win32: true })).toBe(false);
    expect(isInsideDir('C:\\ws', '', { win32: true })).toBe(false);
    expect(isInsideDir(undefined as unknown as string, 'C:\\ws', { win32: true })).toBe(false);
  });
});

describe('toPosixRelPath（win32 语义）', () => {
  it('反斜杠相对路径统一为 /', () => {
    expect(toPosixRelPath('C:\\ws', 'C:\\ws\\a\\b')).toBe('a/b');
    expect(toPosixRelPath('C:\\ws', 'C:\\ws\\x\\y\\z.txt')).toBe('x/y/z.txt');
  });

  it('父方向与跨根形态', () => {
    expect(toPosixRelPath('C:\\ws\\a', 'C:\\ws')).toBe('..');
    expect(toPosixRelPath('C:\\ws', 'C:\\ws')).toBe('');
    // 异盘 relative 无相对路径可表达——Node 直接返回 to 的绝对路径（docs 明示），
    // posix 化后即 'd:/other/x'（调用方以 isInsideDir 判边界，不依赖此形态穿越）
    expect(toPosixRelPath('C:\\ws', 'd:\\other\\x')).toBe('d:/other/x');
  });

  it('混合斜杠输入归一（win32 relative 先归一再 posix 化）', () => {
    expect(toPosixRelPath('C:\\ws', 'C:/ws/a/b')).toBe('a/b');
  });
});
