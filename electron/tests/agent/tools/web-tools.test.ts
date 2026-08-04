// electron/tests/agent/tools/web-tools.test.ts
//
// WebTools（webfetch）单元测试：通过 vi.stubGlobal('fetch', ...) mock 全局 fetch，
// 不发真实网络请求。覆盖 8 个核心场景：
//   - HTML → Markdown（默认格式）
//   - format=text 纯文本
//   - CSS 选择器提取
//   - 选择器未匹配抛错
//   - HTTP 强制升级 HTTPS
//   - file:// 协议拒绝
//   - 4xx 不抛错返回 status
//   - JSON 响应原样返回
//
// 设计要点：
//   - mock 返回的 body 用 Readable.toWeb 包装 Buffer，模拟 Node Web ReadableStream，
//     走 readBodyWithCap 真实代码路径。
//   - fetchMock.mockReset() 在 beforeEach 重置，确保用例间调用历史不串。
//   - fetchMock.mock.calls[0][0] 取第一次调用第一个参数（URL），验证协议升级。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { WebTools } from '../../../src/main/agent/tools/web-tools';
import type { ToolContext } from '../../../src/main/agent/tools/types';

const ctx: ToolContext = {
  wsFs: { assertInWorkspace: (p: string) => p } as never,
  workspaceId: 'test',
  workspaceDir: '/tmp',
  skillRegistry: { list: () => [] } as never,
  streamSessionId: 'ssn',
  roomId: '!r',
  sendStreamChunk: () => {},
  permissionConfig: { allowedTools: [], deniedTools: [] },
};

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
beforeEach(() => fetchMock.mockReset());

/** 把 string 包装为 Node Web ReadableStream，模拟 fetch body 字节流。 */
function makeBody(content: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from([Buffer.from(content)])) as ReadableStream<Uint8Array>;
}

describe('webfetch', () => {
  it('HTML 转 Markdown', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      headers: { get: (k: string) => (k === 'content-type' ? 'text/html; charset=utf-8' : null) },
      body: makeBody('<html><body><h1>Hello</h1><p>World</p></body></html>'),
    });
    const tools = new WebTools();
    const result = await tools.execute('webfetch', { url: 'https://example.com' }, ctx);
    expect(result).toContain('status: 200');
    expect(result).toContain('# Hello');
  });

  it('format=text 纯文本', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => 'text/html' },
      body: makeBody('<p>Hello <b>World</b></p>'),
    });
    const tools = new WebTools();
    const result = await tools.execute(
      'webfetch',
      { url: 'https://x.com', format: 'text' },
      ctx,
    );
    expect(result).toContain('Hello');
    expect(result).not.toContain('<b>');
  });

  it('CSS 选择器提取', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => 'text/html' },
      body: makeBody('<article>Article</article><nav>Nav</nav>'),
    });
    const tools = new WebTools();
    const result = await tools.execute(
      'webfetch',
      { url: 'https://x.com', selector: 'article' },
      ctx,
    );
    expect(result).toContain('Article');
    expect(result).not.toContain('Nav');
  });

  it('选择器未匹配抛错', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => 'text/html' },
      body: makeBody('<p>hi</p>'),
    });
    const tools = new WebTools();
    await expect(
      tools.execute('webfetch', { url: 'https://x.com', selector: '.missing' }, ctx),
    ).rejects.toThrow(/未匹配/);
  });

  it('HTTP 强制升级 HTTPS', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => 'text/plain' },
      body: makeBody('ok'),
    });
    const tools = new WebTools();
    await tools.execute('webfetch', { url: 'http://example.com' }, ctx);
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/');
  });

  it('不允许 file:// 协议', async () => {
    const tools = new WebTools();
    await expect(
      tools.execute('webfetch', { url: 'file:///etc/passwd' }, ctx),
    ).rejects.toThrow(/协议/);
  });

  it('4xx 不抛错返回 status', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 404,
      headers: { get: () => 'text/html' },
      body: makeBody(''),
    });
    const tools = new WebTools();
    expect(await tools.execute('webfetch', { url: 'https://x.com' }, ctx)).toContain(
      'status: 404',
    );
  });

  it('JSON 响应原样返回', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => 'application/json' },
      body: makeBody('{"foo": "bar"}'),
    });
    const tools = new WebTools();
    expect(await tools.execute('webfetch', { url: 'https://api.x.com' }, ctx)).toContain(
      '{"foo": "bar"}',
    );
  });
});
