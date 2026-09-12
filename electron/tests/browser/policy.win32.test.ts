// electron/tests/browser/policy.win32.test.ts
//
// BrowserPolicy.assertFilePath 的 win32 路径语义测试（v2.10 T2：:157 relative
// 变体与 :170 realpath 锚定统一换 isInsideDir）。模板来源：
// tests/platform/paths.win32.test.ts 文件头。
//
// mock 策略：
//   - node:path → win32（模板）
//   - node:url → 手工 win32 语义最小子集：node:url 的 file↔path 映射按
//     process.platform 内部分叉且无 .win32 子形态可取（与 node:path 不同），
//     只能手工实现 drive（file:///C:/a → C:\a）与 UNC（file://srv/s/a →
//     \\srv\s\a）两形态，行为对齐 Node 文档的 win32 语义
//   - node:fs → NTFS 模拟（同 workspace-fs.win32.test.ts 策略；支持两个
//     规范根：盘符根 'C:\WS' 与 UNC 根 '\\srv\share\ws'）——realpath 反逃逸
//     链的 posix 符号链接行为由 policy.test.ts 既有真实 fs 用例覆盖
//   - process.platform 不 mock（模板明示禁止）——平台分叉经 isInsideDir
//     显式 win32 入口（PATH_SEMANTICS_WIN32）
import { describe, it, expect, vi } from 'vitest';
import { BrowserPolicy } from '../../src/main/browser/policy';
import { BrowserFileAccessError } from '../../src/main/browser/errors';
import type { WorkspaceBrowserSettings } from '../../src/main/browser/types';

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { default: actual.win32, ...actual.win32 };
});

vi.mock('node:url', async () => {
  const actual = await vi.importActual<typeof import('node:url')>('node:url');
  return {
    ...actual,
    fileURLToPath: (u: URL | string): string => {
      const url = typeof u === 'string' ? new URL(u) : u;
      if (url.protocol !== 'file:') throw new TypeError('invalid file URL');
      const host = url.hostname;
      const pathname = decodeURIComponent(url.pathname);
      if (host !== '' && host !== 'localhost') {
        return `\\\\${host}${pathname.replaceAll('/', '\\')}`;
      }
      return pathname.slice(1).replaceAll('/', '\\');
    },
    pathToFileURL: (p: string): URL => {
      if (p.startsWith('\\\\')) return new URL(`file://${p.slice(2).replaceAll('\\', '/')}`);
      return new URL(`file:///${p.replaceAll('\\', '/')}`);
    },
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const ROOTS = ['C:\\WS', '\\\\srv\\share\\ws'];
  const canon = (p: string): string => {
    for (const r of ROOTS) {
      if (p.toLowerCase().startsWith(r.toLowerCase())) return r + p.slice(r.length);
    }
    return p;
  };
  return {
    default: {
      ...actual,
      realpathSync: (p: string) => canon(p),
      existsSync: (p: string) =>
        typeof p === 'string' && ROOTS.some((r) => p.toLowerCase().startsWith(r.toLowerCase())),
    },
  };
});

const settings: WorkspaceBrowserSettings = {
  trust: 'always',
  evaluateEnabled: false,
  blacklist: [],
  whitelist: [],
};

describe('BrowserPolicy.assertFilePath（win32 语义）', () => {
  it('UNC file:// 形态命中：路径段大小写混合仍放行，返回 UNC file URL', () => {
    const policy = new BrowserPolicy(() => settings, '\\\\srv\\share\\ws');
    expect(policy.assertUrl('ws1', 'file://srv/share/ws/PROJ/a.txt')).toBe(
      'file://srv/share/ws/PROJ/a.txt',
    );
  });

  it('盘符根 + 大小写混合 file:// 命中', () => {
    const policy = new BrowserPolicy(() => settings, 'C:\\WS');
    expect(policy.assertUrl('ws1', 'file:///c:/ws/proj/a.txt')).toBe('file:///c:/ws/proj/a.txt');
  });

  it('percent-encoding 形态的 .. 穿越拒绝（URL 归一化不可达的编码段）', () => {
    const policy = new BrowserPolicy(() => settings, 'C:\\WS');
    expect(() => policy.assertUrl('ws1', 'file:///C:/WS/%2E%2E/outside/a.txt')).toThrow(
      BrowserFileAccessError,
    );
  });

  it('异盘 file:// 拒绝（d: 不是 C: 子路径）', () => {
    const policy = new BrowserPolicy(() => settings, 'C:\\WS');
    expect(() => policy.assertUrl('ws1', 'file:///d:/other/a.txt')).toThrow(BrowserFileAccessError);
  });

  it('根自身命中（file:// 目录形态）', () => {
    const policy = new BrowserPolicy(() => settings, 'C:\\WS');
    expect(policy.assertUrl('ws1', 'file:///c:/ws')).toBe('file:///c:/ws');
  });
});
