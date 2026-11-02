// electron/tests/browser/url-input.test.ts
//
// resolveNavigateInput 的「本机原生路径语义」测试（真实 node:path / node:url，
// 不 mock 任何模块）。
//
// 期望值一律由 pathToFileURL(...) 现算：本文件在 Windows 开发机上跑到的就是
// win32 语义，写死 `file:///ws/...` 字面量在开发机必然红（见 Global Constraints）。
// win32 语义的定值断言见 url-input.win32.test.ts。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveNavigateInput } from '../../src/main/browser/url-input';

/** 工作空间根的测试值（跨平台语义中立——断言侧用 path.join/path.resolve 现算） */
const WS = '/ws';

function nav(raw: string): string {
  return resolveNavigateInput(raw, { workspaceDir: WS }).url;
}

describe('resolveNavigateInput（本机原生路径语义）', () => {
  it('裸文件名 → 工作空间内的绝对 file URL', () => {
    expect(nav('report.html')).toBe(pathToFileURL(path.join(WS, 'report.html')).href);
  });

  it('./ 前缀相对路径 → 工作空间内归一', () => {
    expect(nav('./sub/a.html')).toBe(pathToFileURL(path.join(WS, 'sub/a.html')).href);
  });

  it('#锚点必须在判绝对性之前切出，不能当成文件名一部分', () => {
    expect(nav('a.html#p2')).toBe(pathToFileURL(path.join(WS, 'a.html')).href + '#p2');
  });

  it('?query 与 #hash 同时保留（顺序与内容原样）', () => {
    expect(nav('a.html?x=1#p2')).toBe(
      pathToFileURL(path.join(WS, 'a.html')).href + '?x=1#p2',
    );
  });

  it('字面 % 不报错、不被当编码（最终编码为 %25）', () => {
    expect(nav('研发 周报%模板.html')).toBe(
      pathToFileURL(path.join(WS, '研发 周报%模板.html')).href,
    );
  });

  it('合法 percent-encoding 先解码再编码（%E7%A0%94 = 研）', () => {
    expect(nav('%E7%A0%94.html')).toBe(pathToFileURL(path.join(WS, '研.html')).href);
  });

  it('.. 越界路径只做归一，不在这里拒绝（边界归 policy）', () => {
    expect(nav('../outside.html')).toBe(
      pathToFileURL(path.resolve(WS, '../outside.html')).href,
    );
  });

  it('平台绝对路径 → 原样语义（不做工作空间内重定位）', () => {
    expect(nav('/etc/hosts')).toBe(pathToFileURL(path.resolve('/etc/hosts')).href);
  });

  it('http URL 原样返回', () => {
    expect(nav('http://localhost:5173/x')).toBe('http://localhost:5173/x');
  });

  it('https URL 原样返回', () => {
    expect(nav('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
  });

  it('其他 scheme 原样透传（错误分类由 policy 的 BrowserProtocolError 负责）', () => {
    expect(nav('ftp://x/y')).toBe('ftp://x/y');
  });

  it('能被打成绝对路径的 file:// URL 原样返回（不被降级为相对路径）', () => {
    expect(nav('file:///C:/abs/a.html')).toBe('file:///C:/abs/a.html');
  });

  it.each(['', '   '])('空串/空白串 %j 抛「URL 为空」', (raw) => {
    expect(() => nav(raw)).toThrow(/URL 为空/);
  });
});
