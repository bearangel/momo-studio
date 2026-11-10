// electron/tests/oauth/endpoint-guard.test.ts
//
// OAuth 端点准入的回归锁（Task 4，2026-11-10 OAuth 模块）。
// 口径：https 任意主机；http 仅回环。判定逻辑复用 util/url-guard（Task 1）。
import { describe, it, expect } from 'vitest';
import { assertEndpointAllowed } from '../../src/main/oauth/protocol/endpoint-guard';
import { OAuthFailure } from '../../src/main/oauth/types';

describe('assertEndpointAllowed', () => {
  it('https 任意主机通过', () => {
    expect(() => assertEndpointAllowed('https://auth.example.com/token')).not.toThrow();
  });
  it('http 回环通过', () => {
    expect(() => assertEndpointAllowed('http://127.0.0.1:8080/token')).not.toThrow();
    expect(() => assertEndpointAllowed('http://localhost:8080/token')).not.toThrow();
  });
  it('非回环 http 抛 insecure_endpoint', () => {
    try {
      assertEndpointAllowed('http://example.com/token');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthFailure);
      expect((err as OAuthFailure).code).toBe('insecure_endpoint');
    }
  });
  it('非法 URL / 其他 scheme 抛 insecure_endpoint', () => {
    expect(() => assertEndpointAllowed('ftp://127.0.0.1/x')).toThrow(OAuthFailure);
    expect(() => assertEndpointAllowed('not a url')).toThrow(OAuthFailure);
    expect(() => assertEndpointAllowed('')).toThrow(OAuthFailure);
  });
  it('IPv6 回环 http 放行（真实产品回环监听为 [::1]）', () => {
    expect(() => assertEndpointAllowed('http://[::1]:51789/callback')).not.toThrow();
  });
  it('拒绝时错误带 insecure_endpoint 且 detail 携带原始 URL', () => {
    try {
      assertEndpointAllowed('http://evil.example/token');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthFailure);
      const failure = err as OAuthFailure;
      expect(failure.code).toBe('insecure_endpoint');
      expect(failure.detail).toBe('http://evil.example/token');
      expect(failure.name).toBe('OAuthFailure');
    }
  });
  it('放行路径不抛错（非回环 http 之外都交给共享守卫判定）', () => {
    expect(() => assertEndpointAllowed('https://127.0.0.1:8443/token')).not.toThrow();
    expect(() => assertEndpointAllowed('http://192.168.1.5:8080/token')).toThrow(OAuthFailure);
  });
});
