// electron/tests/browser/url-input.win32.test.ts
//
// resolveNavigateInput 的 win32 路径语义测试（定值断言，跨平台跑出同一结果）。
// 模板来源：tests/browser/policy.win32.test.ts 文件头与 mock 段。
//
// mock/注入策略（两处都必须做，缺一不可）：
//   - node:path → win32（模板 :23-26）——被测模块内部的 resolve/join 走 win32
//   - node:url → 手工 win32 语义最小子集（模板 :28-46 的 drive 与 UNC 两形态）：
//     node:url 的 file↔path 映射按 process.platform 内部分叉且无 .win32 子形态可取，
//     只能手写
//   - fileUrlToPath 注入进被测函数（opts.fileUrlToPath，spec §5.3 接口就是为此留的口子）
//   - process.platform 不 mock（模板明示禁止）——win32 语义由 opts.platform 显式传入，
//     因此在 Linux CI 上同样跑出 win32 结果
import { describe, expect, it, vi } from 'vitest';
import { resolveNavigateInput } from '../../src/main/browser/url-input';

/**
 * win32 语义的 file URL → 路径。除模板的两形态外，补一条真实 Node 的抛错语义：
 * 无盘符形态（file:///x.html）在 Windows 上抛 ERR_INVALID_FILE_URL_PATH
 * （must be absolute）。模板未实现该抛错是因为 policy 用例不走此形态；本文件
 * 「win32 无盘符 → 回退按工作空间相对路径」正是被测契约，必须还原。
 */
function win32FileUrlToPath(u: URL | string): string {
  const url = typeof u === 'string' ? new URL(u) : u;
  if (url.protocol !== 'file:') throw new TypeError('invalid file URL');
  const host = url.hostname;
  const pathname = decodeURIComponent(url.pathname);
  if (host !== '' && host !== 'localhost') {
    return `\\\\${host}${pathname.replaceAll('/', '\\')}`;
  }
  if (!/^\/[A-Za-z]:[\\/]/.test(url.pathname)) {
    throw new TypeError('ERR_INVALID_FILE_URL_PATH: must be absolute');
  }
  return pathname.slice(1).replaceAll('/', '\\');
}

/** win32 语义的路径 → file URL（模板 :42-45） */
function win32PathToFileUrl(p: string): URL {
  if (p.startsWith('\\\\')) return new URL(`file://${p.slice(2).replaceAll('\\', '/')}`);
  return new URL(`file:///${p.replaceAll('\\', '/')}`);
}

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { default: actual.win32, ...actual.win32 };
});

vi.mock('node:url', async () => {
  const actual = await vi.importActual<typeof import('node:url')>('node:url');
  return {
    ...actual,
    fileURLToPath: win32FileUrlToPath,
    pathToFileURL: win32PathToFileUrl,
  };
});

function nav(raw: string): string {
  return resolveNavigateInput(raw, {
    workspaceDir: 'C:\\WS',
    platform: 'win32',
    fileUrlToPath: win32FileUrlToPath,
  }).url;
}

describe('resolveNavigateInput（win32 语义）', () => {
  it('裸文件名 → 工作空间内绝对 file URL', () => {
    expect(nav('report.html')).toBe('file:///C:/WS/report.html');
  });

  it('盘符形态是路径而非 scheme（C:\\abs\\a.html）', () => {
    expect(nav('C:\\abs\\a.html')).toBe('file:///C:/abs/a.html');
  });

  it('合法盘符 file URL 必须先走 fileUrlToPath（不得掉进相对分支）', () => {
    expect(nav('file:///C:/abs/a.html')).toBe('file:///C:/abs/a.html');
  });

  it('UNC file URL 按绝对路径保留', () => {
    expect(nav('file://srv/share/x.html')).toBe('file://srv/share/x.html');
  });

  it('无盘符 file URL 回退为工作空间相对路径（win32 已知取舍）', () => {
    expect(nav('file:///report.html')).toBe('file:///C:/WS/report.html');
  });

  it('#锚点保留（先切后缀再判绝对性）', () => {
    expect(nav('a.html#p2')).toBe('file:///C:/WS/a.html#p2');
  });

  it('盘符 file URL 的 ?query 与 #hash 挂回结果', () => {
    expect(nav('file:///C:/abs/a.html?x=1#p2')).toBe('file:///C:/abs/a.html?x=1#p2');
  });
});
