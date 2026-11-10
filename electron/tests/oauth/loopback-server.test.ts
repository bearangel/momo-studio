import { describe, it, expect } from 'vitest';
import { startLoopbackServer, parseManualCallback } from '../../src/main/oauth/protocol/loopback-server';
import { OAuthFailure } from '../../src/main/oauth/types';

describe('startLoopbackServer', () => {
  it('随机端口，收到正确 state 返回 code 并关闭', async () => {
    const server = await startLoopbackServer({
      host: '127.0.0.1',
      port: null,
      expectedState: 'st-1',
      timeoutMs: 5000,
    });
    expect(server.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const waiting = server.waitForCallback();
    const response = await fetch(`${server.redirectUri}?code=abc&state=st-1`);
    expect(response.status).toBe(200);
    await expect(waiting).resolves.toEqual({ code: 'abc' });
    await server.close();
  });

  it('state 不匹配返回 400 且继续等待后续正确回调', async () => {
    const server = await startLoopbackServer({
      host: '127.0.0.1',
      port: null,
      expectedState: 'st-2',
      timeoutMs: 5000,
    });
    const waiting = server.waitForCallback();
    const bad = await fetch(`${server.redirectUri}?code=x&state=wrong`);
    expect(bad.status).toBe(400);
    const good = await fetch(`${server.redirectUri}?code=ok&state=st-2`);
    expect(good.status).toBe(200);
    await expect(waiting).resolves.toEqual({ code: 'ok' });
    await server.close();
  });

  it('路径不符返回 404 且不影响等待', async () => {
    const server = await startLoopbackServer({
      host: '127.0.0.1',
      port: null,
      expectedState: 'st-3',
      timeoutMs: 5000,
    });
    const waiting = server.waitForCallback();
    const origin = new URL(server.redirectUri).origin;
    expect((await fetch(`${origin}/other?code=x&state=st-3`)).status).toBe(404);
    await fetch(`${server.redirectUri}?code=ok&state=st-3`);
    await expect(waiting).resolves.toEqual({ code: 'ok' });
    await server.close();
  });

  it('缺 code 返回 400 并继续等待', async () => {
    const server = await startLoopbackServer({
      host: '127.0.0.1',
      port: null,
      expectedState: 'st-4',
      timeoutMs: 5000,
    });
    const waiting = server.waitForCallback();
    expect((await fetch(`${server.redirectUri}?state=st-4`)).status).toBe(400);
    await fetch(`${server.redirectUri}?code=ok&state=st-4`);
    await expect(waiting).resolves.toEqual({ code: 'ok' });
    await server.close();
  });

  it('超时抛 authorization_timeout', async () => {
    const server = await startLoopbackServer({
      host: '127.0.0.1',
      port: null,
      expectedState: 'st-5',
      timeoutMs: 50,
    });
    await expect(server.waitForCallback()).rejects.toMatchObject({ code: 'authorization_timeout' });
    await server.close();
  });

  it('固定端口被占用抛 redirect_port_in_use', async () => {
    const first = await startLoopbackServer({
      host: '127.0.0.1',
      port: null,
      expectedState: 'a',
      timeoutMs: 5000,
    });
    const port = Number(new URL(first.redirectUri).port);
    await expect(
      startLoopbackServer({
        host: '127.0.0.1',
        port,
        expectedState: 'b',
        timeoutMs: 5000,
      })
    ).rejects.toMatchObject({ code: 'redirect_port_in_use' });
    await first.close();
  });
});

describe('parseManualCallback', () => {
  it('接受完整回调 URL', () => {
    expect(parseManualCallback('http://127.0.0.1:51789/callback?code=abc&state=st', 'st')).toBe('abc');
  });
  it('接受裸 code', () => {
    expect(parseManualCallback('abc', 'st')).toBe('abc');
  });
  it('state 不匹配抛 authorization_cancelled', () => {
    try {
      parseManualCallback('http://127.0.0.1:51789/callback?code=abc&state=no', 'st');
      expect.unreachable();
    } catch (err) {
      expect((err as OAuthFailure).code).toBe('authorization_cancelled');
    }
  });
  it('URL 缺 code 抛 token_exchange_failed', () => {
    expect(() => parseManualCallback('http://127.0.0.1:51789/callback?state=st', 'st')).toThrow(
      OAuthFailure
    );
  });
});
