// electron/tests/mcp/http-client.test.ts
//
// P2 Task 3：HttpMcpClient（streamable_http 传输）单元测试。
//   - connect 发 initialize 请求 + notifications/initialized 通知（两次 POST；notification 无 id）
//   - listTools 解析 tools 数组；响应缺 tools 字段回 []（边界空值）
//   - callTool 提取 text 内容并用 \n 拼接（与 host-manager.callMcpTool 对 stdio 的语义一致）
//   - JSON-RPC error 响应抛错且透出服务器 message（错误路径专项）
//   - HTTP 非 2xx 抛错且 isConnected=false（错误路径专项）
//   - 单请求 30s 超时接线：AbortSignal abort → 请求失败且 isConnected=false
//   - 请求头透传 Authorization（token 不出现在日志断言里——日志防泄漏约束）
//
// fetch 全程 mock（vi.spyOn(globalThis, 'fetch')）：HttpMcpClient 每个请求
// 一次独立 POST，无连接态，桩实现无需区分会话。notification 桩恒回 202 无
// body（MCP streamable HTTP 规范形态），且故意不提供 json 方法——notify 若
// 误调 response.json() 会立即 TypeError 变红。
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
function rpcResult(result: unknown): Response {
  return {
    ok: true, status: 200,
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  } as unknown as Response;
}

/** JSON-RPC 错误响应桩（HTTP 200 + error 对象） */
function rpcError(code: number, message: string): Response {
  return {
    ok: true, status: 200,
    json: async () => ({ jsonrpc: '2.0', id: 1, error: { code, message } }),
  } as unknown as Response;
}

/** initialize 成功响应（多用例共用） */
const initializeOk = rpcResult({ serverInfo: { name: 'x', version: '1' }, capabilities: {} });

/** notification 的规范响应：202 无 body——不提供 json 方法，notify 不得调用它 */
const notificationAccepted: Response = { ok: true, status: 202 } as unknown as Response;

/** 按方法分派响应桩；notifications/initialized 恒回 202；未知方法抛错（锁线协议方法名） */
function mockResponses(byMethod: Record<string, Response>): void {
  fetchSpy.mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { method: string };
    if (body.method === 'notifications/initialized') return notificationAccepted;
    const stub = byMethod[body.method];
    if (!stub) throw new Error(`测试桩未预期的 RPC 方法：${body.method}`);
    return stub;
  });
}

/** 取第 n 次 POST 的请求体（JSON 解析后） */
function bodyOf(call: number): Record<string, unknown> {
  return JSON.parse(
    String(fetchSpy.mock.calls[call]![1]?.body ?? '{}'),
  ) as Record<string, unknown>;
}

describe('HttpMcpClient（streamable_http 传输）', () => {
  it('connect 发 initialize 请求 + initialized 通知（两次 POST，notification 无 id）', async () => {
    mockResponses({ initialize: initializeOk });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // JSON-RPC 2.0 契约：请求带 id；notification 无 id（服务器据此禁止回应）
    expect(bodyOf(0).id).toBe(1);
    expect(bodyOf(1).method).toBe('notifications/initialized');
    expect(bodyOf(1).id).toBeUndefined();
    expect(client.isConnected).toBe(true);
  });

  it('listTools 解析 tools 数组', async () => {
    mockResponses({
      initialize: initializeOk,
      'tools/list': rpcResult({ tools: [{ name: 't1', description: 'd', inputSchema: {} }] }),
    });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('t1');
  });

  it('listTools 响应缺 tools 字段回 []（边界空值）', async () => {
    mockResponses({ initialize: initializeOk, 'tools/list': rpcResult({}) });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    expect(await client.listTools()).toEqual([]);
  });

  it('callTool 提取 text 内容并用 \\n 拼接', async () => {
    mockResponses({
      initialize: initializeOk,
      'tools/call': rpcResult({
        content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
        isError: false,
      }),
    });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    expect(await client.callTool('t1', {})).toBe('a\nb');
  });

  it('JSON-RPC error 响应抛错且透出服务器 message（错误路径专项）', async () => {
    mockResponses({
      initialize: initializeOk,
      'tools/list': rpcError(-32601, 'Method not found'),
    });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    await expect(client.listTools()).rejects.toThrow(/Method not found/);
  });

  it('HTTP 非 2xx 抛错且 isConnected=false', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 502 } as unknown as Response);
    const client = new HttpMcpClient(cfg);
    await expect(client.connect()).rejects.toThrow(/502|远程 MCP/);
    expect(client.isConnected).toBe(false);
  });

  it('单请求 30s 超时：fetch 以 TimeoutError 拒绝后抛错且 isConnected=false', async () => {
    // 真实语义：AbortSignal.timeout(30s) 到期 → undici fetch 以该 DOMException 拒绝。
    // 原生 30s 计时不可伪造，此处 mock 边界拒绝的终态形状（错误形状仿真）
    fetchSpy.mockRejectedValue(new DOMException('signal timed out', 'TimeoutError'));
    const client = new HttpMcpClient(cfg);
    await expect(client.connect()).rejects.toThrow('signal timed out');
    expect(client.isConnected).toBe(false);
  });

  it('每个 POST 携带未到期的 AbortSignal（30s 超时接线）', async () => {
    mockResponses({ initialize: initializeOk });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    for (const call of fetchSpy.mock.calls) {
      const signal = (call[1] as RequestInit).signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect((signal as AbortSignal).aborted).toBe(false); // 请求发出时未到期
    }
  });

  it('请求头带 Authorization（initialize 与 notification 同 headers，token 不出现在日志断言里）', async () => {
    mockResponses({ initialize: initializeOk });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    for (const call of fetchSpy.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer tk');
    }
  });
});
