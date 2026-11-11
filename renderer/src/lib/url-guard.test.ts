// renderer/src/lib/url-guard.test.ts
//
// URL 准入判定 renderer 镜像测试（与 electron/tests/main/util/url-guard.test.ts
// 双端契约）：https 任意主机 + http 仅回环。McpConfigDialog 提交防线回归锁。
import { describe, it, expect } from 'vitest';
import { isHttpsOrLoopbackHttp, isLoopbackHost } from './url-guard';

describe('isLoopbackHost', () => {
  it('localhost / 127.0.0.1 / ::1 / 0.0.0.0 视为回环（大小写不敏感，剥 IPv6 方括号）', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(true);
  });

  it('非回环主机拒绝', () => {
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('192.168.1.5')).toBe(false);
    expect(isLoopbackHost('127.0.0.2')).toBe(false);
  });
});

describe('isHttpsOrLoopbackHttp', () => {
  it('https 任意主机通过', () => {
    expect(isHttpsOrLoopbackHttp('https://mcp.example.com/mcp')).toBe(true);
    expect(isHttpsOrLoopbackHttp('https://127.0.0.1:8443/x')).toBe(true);
  });

  it('http 回环通过（127.0.0.1 带端口路径；[::1] IPv6 字面量）', () => {
    expect(isHttpsOrLoopbackHttp('http://127.0.0.1:8080/x')).toBe(true);
    expect(isHttpsOrLoopbackHttp('http://[::1]:51789/callback')).toBe(true);
    expect(isHttpsOrLoopbackHttp('http://localhost:3000/mcp')).toBe(true);
  });

  it('http 非回环拒绝（域名 / 内网 IP）', () => {
    expect(isHttpsOrLoopbackHttp('http://example.com')).toBe(false);
    expect(isHttpsOrLoopbackHttp('http://192.168.1.5/mcp')).toBe(false);
  });

  it('非 http(s) scheme 与非法串拒绝', () => {
    expect(isHttpsOrLoopbackHttp('ftp://example.com/x')).toBe(false);
    expect(isHttpsOrLoopbackHttp('file:///etc/passwd')).toBe(false);
    expect(isHttpsOrLoopbackHttp('not a url')).toBe(false);
    expect(isHttpsOrLoopbackHttp('')).toBe(false);
  });

  it('非字符串入参直接拒绝（类型防御）', () => {
    expect(isHttpsOrLoopbackHttp(undefined)).toBe(false);
    expect(isHttpsOrLoopbackHttp(123)).toBe(false);
    expect(isHttpsOrLoopbackHttp(null)).toBe(false);
  });
});
