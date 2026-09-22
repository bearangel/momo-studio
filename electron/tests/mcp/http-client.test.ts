// electron/tests/mcp/http-client.test.ts
//
// P2 Task 3：HttpMcpClient（streamable_http 传输）单元测试。
//   - connect 发 initialize + initialized 通知（两次 POST）
//   - listTools 解析 tools 数组
//   - callTool 提取 text 内容并用 \n 拼接（与 host-manager.callMcpTool 对 stdio 的语义一致）
//   - HTTP 非 2xx 抛错且 isConnected=false（错误路径专项）
//   - 请求头透传 Authorization（token 不出现在日志断言里——日志防泄漏约束）
//
// fetch 全程 mock（vi.spyOn(globalThis, 'fetch')）：HttpMcpClient 每个请求
// 一次独立 POST，无连接态，桩实现无需区分会话。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { HttpMcpClient } from '../../src/main/mcp/http-client';
import type { McpServerConfig } from '../../src/main/mcp/types';

const cfg: McpServerConfig = {
  id: 'r1', name: 'ms', version: '1.0.0',
  transport: 'streamable_http', url: 'https://mcp.test/sse',
  headers: { Authorization: 'Bearer tk' }, command: '', args: [],
};

let fetchSpy: MockInstance<Parameters<typeof fetch>, ReturnType<typeof fetch>>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

/** JSON-RPC 成功响应桩 */
function rpcResult(method: string, result: unknown): Response {
  return {
    ok: true, status: 200,
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  } as unknown as Response;
}

describe('HttpMcpClient（streamable_http 传输）', () => {
  it('connect 发 initialize + initialized 通知（两次 POST）', async () => {
    fetchSpy.mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method: string };
      if (body.method === 'initialize') return rpcResult('initialize', { serverInfo: { name: 'x', version: '1' }, capabilities: {} });
      return rpcResult('notifications/initialized', {});
    });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(client.isConnected).toBe(true);
  });

  it('listTools 解析 tools 数组', async () => {
    fetchSpy.mockImplementation(async () =>
      rpcResult('tools/list', { tools: [{ name: 't1', description: 'd', inputSchema: {} }] }),
    );
    const client = new HttpMcpClient(cfg);
    await client.connect();
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('t1');
  });

  it('callTool 提取 text 内容并用 \\n 拼接', async () => {
    fetchSpy.mockImplementation(async () =>
      rpcResult('tools/call', { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], isError: false }),
    );
    const client = new HttpMcpClient(cfg);
    await client.connect();
    expect(await client.callTool('t1', {})).toBe('a\nb');
  });

  it('HTTP 非 2xx 抛错且 isConnected=false', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 502 } as unknown as Response);
    const client = new HttpMcpClient(cfg);
    await expect(client.connect()).rejects.toThrow(/502|远程 MCP/);
    expect(client.isConnected).toBe(false);
  });

  it('请求头带 Authorization（token 不出现在日志断言里）', async () => {
    fetchSpy.mockImplementation(async () => rpcResult('initialize', { serverInfo: {}, capabilities: {} }));
    const client = new HttpMcpClient(cfg);
    await client.connect();
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tk');
  });
});
