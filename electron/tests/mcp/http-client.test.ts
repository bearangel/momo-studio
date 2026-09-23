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
// 2026-09-23 streamable-HTTP 合规追加（context7 官方端点实测修）：
//   - Accept 双声明 application/json, text/event-stream（spec 允许两种响应媒体，
//     只声明 json 被严格服务器 406 拒绝——context7 实测）
//   - SSE 响应（content-type: text/event-stream）流式逐帧解析：单帧 / 多帧跳过
//     id 不匹配 / 分块切割 / 注释与非 JSON 行 / error 帧现行文案 / 流中断中文
//     报错 / 读到匹配后 cancel 释放连接 / EOF 冲刷无空行收尾帧
//   - initialize 响应 Mcp-Session-Id 回显（带 → 后续 post/notify 携带；无 → 不发）
//
// 响应桩自假对象升真 Response：生产代码已按 content-type 分流，真 fetch 响应
// 必带 headers（保真度规则：mock 必须仿真真实运行时语义）；真 body 单次消费，
// 故共享桩一律工厂函数按需新建。
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

/** JSON-RPC 成功响应桩（真 Response：带 headers，json() 语义与 fetch 一致） */
function rpcResult(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** JSON-RPC 错误响应桩（HTTP 200 + error 对象） */
function rpcError(code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** initialize 成功响应（多用例共用；extraHeaders 供 mcp-session-id 回显用例） */
function initializeOk(extraHeaders: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'x', version: '1' }, capabilities: {} },
    }),
    { status: 200, headers: { 'content-type': 'application/json', ...extraHeaders } },
  );
}

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
    mockResponses({ initialize: initializeOk() });
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
      initialize: initializeOk(),
      'tools/list': rpcResult({ tools: [{ name: 't1', description: 'd', inputSchema: {} }] }),
    });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('t1');
  });

  it('listTools 响应缺 tools 字段回 []（边界空值）', async () => {
    mockResponses({ initialize: initializeOk(), 'tools/list': rpcResult({}) });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    expect(await client.listTools()).toEqual([]);
  });

  it('callTool 返回原始 McpToolResult（含 content+isError），不再返回拼接文本——消除 host-manager 的 typeof string 分支（契约 #3）', async () => {
    mockResponses({
      initialize: initializeOk(),
      'tools/call': rpcResult({
        content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
        isError: false,
      }),
    });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    const result = await client.callTool('t1', {});
    expect(result).toEqual({
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
      isError: false,
    });
    expect(typeof result).not.toBe('string');
  });

  it('JSON-RPC error 响应抛错且透出服务器 message（错误路径专项）', async () => {
    mockResponses({
      initialize: initializeOk(),
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
    mockResponses({ initialize: initializeOk() });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    for (const call of fetchSpy.mock.calls) {
      const signal = (call[1] as RequestInit).signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect((signal as AbortSignal).aborted).toBe(false); // 请求发出时未到期
    }
  });

  it('请求头带 Authorization（initialize 与 notification 同 headers，token 不出现在日志断言里）', async () => {
    mockResponses({ initialize: initializeOk() });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    for (const call of fetchSpy.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer tk');
    }
  });
});

// ─── streamable-HTTP 规范合规（2026-09-23 context7 官方端点实测修）────────────

/** 构造一条 SSE message 帧（context7 实测形态：event 行 + 单行 data JSON + 空行收帧） */
function sseFrame(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** SSE 响应桩：chunks 为原始文本分块（模拟网络分片切割），content-type 按实测回 text/event-stream */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('HttpMcpClient streamable-HTTP 合规（Accept 双声明 / SSE 响应解析 / 会话头回显）', () => {
  it('Accept 头双声明 application/json, text/event-stream——单声明 json 会被严格服务器 406 拒（context7 实测）', async () => {
    mockResponses({ initialize: initializeOk() });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    expect(fetchSpy).toHaveBeenCalledTimes(2); // initialize + initialized 通知，两类请求都要带
    for (const call of fetchSpy.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers.Accept).toBe('application/json, text/event-stream');
    }
  });

  it('SSE 单帧响应：解析 data 帧里的 JSON-RPC result（event: message 实测形态）', async () => {
    mockResponses({
      initialize: initializeOk(),
      'tools/list': sseResponse([
        sseFrame({
          jsonrpc: '2.0',
          id: 2, // initialize 占 id=1，tools/list 是第二个带 id 请求
          result: { tools: [{ name: 'resolve-library-id', description: 'd', inputSchema: {} }] },
        }),
      ]),
    });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('resolve-library-id');
  });

  it('SSE 多帧：跳过无 id 的服务器通知帧与 id 不匹配的他人响应帧，取目标帧', async () => {
    mockResponses({
      initialize: initializeOk(),
      'tools/list': sseResponse([
        // 服务器主动推送（无 id 通知）——必须跳过
        sseFrame({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } }),
        // 其他请求的响应（id 不匹配）——必须跳过
        sseFrame({ jsonrpc: '2.0', id: 99, result: { unrelated: true } }),
        // 目标响应
        sseFrame({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 't1', description: 'd', inputSchema: {} }] } }),
      ]),
    });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('t1');
  });

  it('SSE 分块切割：chunk 边界切碎 event 行与 JSON 中段仍正确解析（跨 chunk 行缓冲）', async () => {
    const whole = sseFrame({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [{ name: 'split-ok', description: 'd', inputSchema: {} }] },
    });
    const chunks: string[] = [];
    for (let i = 0; i < whole.length; i += 7) chunks.push(whole.slice(i, i + 7)); // 7 字节恶切
    mockResponses({ initialize: initializeOk(), 'tools/list': sseResponse(chunks) });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    const tools = await client.listTools();
    expect(tools[0]!.name).toBe('split-ok');
  });

  it('SSE 注释行与非 JSON data 行跳过（keepalive 心跳不误伤）', async () => {
    mockResponses({
      initialize: initializeOk(),
      'tools/list': sseResponse([
        ': ping\n\n', // SSE 注释行（keepalive 惯用）
        'event: ping\ndata: keepalive\n\n', // 非 JSON data 行
        sseFrame({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'after-heartbeat', description: 'd', inputSchema: {} }] } }),
      ]),
    });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    const tools = await client.listTools();
    expect(tools[0]!.name).toBe('after-heartbeat');
  });

  it('SSE id 匹配的 error 帧 → 按现行文案抛错（错误路径专项）', async () => {
    mockResponses({
      initialize: initializeOk(),
      'tools/list': sseResponse([
        sseFrame({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: '上游限流' } }),
      ]),
    });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    await expect(client.listTools()).rejects.toThrow('远程 MCP tools/list 错误：上游限流');
  });

  it('SSE 流提前结束（无 id 匹配帧即 close）→ 抛中文错误', async () => {
    mockResponses({
      initialize: initializeOk(),
      'tools/list': sseResponse([
        sseFrame({ jsonrpc: '2.0', method: 'notifications/message', params: {} }),
      ]),
    });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    await expect(client.listTools()).rejects.toThrow('远程 MCP tools/list 响应流提前结束');
  });

  it('SSE 流未以空行收尾（EOF 冲刷残留帧）仍能取到响应', async () => {
    // 非规范收尾但数据完整：EOF 时冲刷未终止的半帧，不误判为提前结束
    const raw = `event: message\ndata: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [{ name: 'no-trailing-blank', description: 'd', inputSchema: {} }] },
    })}`; // 故意无结尾 \n\n
    mockResponses({ initialize: initializeOk(), 'tools/list': sseResponse([raw]) });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    const tools = await client.listTools();
    expect(tools[0]!.name).toBe('no-trailing-blank');
  });

  it('SSE 读到匹配帧后 cancel 释放连接（服务器保持长连接不主动 close 的场景）', async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sseFrame({
              jsonrpc: '2.0',
              id: 2,
              result: { tools: [{ name: 'long-poll', description: 'd', inputSchema: {} }] },
            }),
          ),
        );
        // 故意不 close：模拟 SSE 长连接继续挂着——读到匹配后必须 cancel 释放
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchSpy.mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method: string };
      if (body.method === 'initialize') return initializeOk();
      if (body.method === 'notifications/initialized') return notificationAccepted;
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    const tools = await client.listTools();
    expect(tools[0]!.name).toBe('long-poll');
    expect(cancelled).toBe(true);
  });

  it('initialize 响应带 mcp-session-id → 后续 post/notify 请求头回显（initialize 本身不带）', async () => {
    mockResponses({
      initialize: initializeOk({ 'mcp-session-id': 'sess-abc-123' }),
      'tools/list': rpcResult({ tools: [] }),
    });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    await client.listTools();
    expect(fetchSpy).toHaveBeenCalledTimes(3); // initialize / initialized 通知 / tools/list
    const initHeaders = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    const notifyHeaders = (fetchSpy.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    const listHeaders = (fetchSpy.mock.calls[2]![1] as RequestInit).headers as Record<string, string>;
    expect(initHeaders['Mcp-Session-Id']).toBeUndefined(); // 握手时会话 id 尚不存在
    expect(notifyHeaders['Mcp-Session-Id']).toBe('sess-abc-123'); // initialized 通知也要回显
    expect(listHeaders['Mcp-Session-Id']).toBe('sess-abc-123');
  });

  it('initialize 响应无 mcp-session-id → 后续请求不带该头（context7 无状态服务器形态）', async () => {
    mockResponses({
      initialize: initializeOk(), // 无 mcp-session-id 响应头
      'tools/list': rpcResult({ tools: [] }),
    });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    await client.listTools();
    for (const call of fetchSpy.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers['Mcp-Session-Id']).toBeUndefined();
    }
  });
});
