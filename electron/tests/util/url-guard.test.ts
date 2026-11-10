// electron/tests/util/url-guard.test.ts
//
// 共享 URL 准入判定的回归锁（Task 1，2026-11-10 OAuth 模块）。
// 口径：https 任意主机；http 仅回环（本地研发场景）。
import { describe, it, expect } from 'vitest';
import { isLoopbackHost, isHttpsOrLoopbackHttp } from '../../src/main/util/url-guard';

describe('isLoopbackHost', () => {
  it('识别四种回环写法（含大小写）', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(true);
  });
  it('剥离 WHATWG URL 的 IPv6 方括号（真实调用链传入 [::1]）', () => {
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(new URL('http://[::1]:8080/x').hostname).toBe('[::1]');
  });
  it('非回环一律 false', () => {
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('127.0.0.2')).toBe(false);
  });
});

describe('isHttpsOrLoopbackHttp', () => {
  it('https 任意主机放行', () => {
    expect(isHttpsOrLoopbackHttp('https://example.com/a')).toBe(true);
  });
  it('http 仅回环放行', () => {
    expect(isHttpsOrLoopbackHttp('http://127.0.0.1:51789/callback')).toBe(true);
    expect(isHttpsOrLoopbackHttp('http://localhost:8080/x')).toBe(true);
    expect(isHttpsOrLoopbackHttp('http://[::1]:51789/callback')).toBe(true);
    expect(isHttpsOrLoopbackHttp('http://example.com/x')).toBe(false);
    expect(isHttpsOrLoopbackHttp('http://192.168.1.5:8080/x')).toBe(false);
  });
  it('非法 URL / 其他 scheme 拒绝', () => {
    expect(isHttpsOrLoopbackHttp('')).toBe(false);
    expect(isHttpsOrLoopbackHttp('ftp://127.0.0.1/x')).toBe(false);
    expect(isHttpsOrLoopbackHttp('not a url')).toBe(false);
  });
  it('非字符串入参拒绝（运行时防御）', () => {
    // 模拟 IPC/JSON 边界传入的非字符串值（参数类型为 unknown，无需强转）
    expect(isHttpsOrLoopbackHttp(undefined)).toBe(false);
    expect(isHttpsOrLoopbackHttp(12345)).toBe(false);
    expect(isHttpsOrLoopbackHttp(null)).toBe(false);
  });
});
