// electron/tests/mcp/iserror-propagation.test.ts
//
// P2 isError 语义透传——契约红测（momo-boundary-rules 铁律 4：生产者/消费者
// 成对修改 + 契约测试锁形状）。
//
// 根因（.superpowers/e2e/mcp-realmodel-report.md 缺陷 #3）：
//   stdio MCP 工具返回 {isError:true, content:[…E-500…]} 时，
//   host-manager.callMcpTool 只提取 text 拼接返回；runtime-entry 的 MCP 工具
//   执行把 resolve 视为成功，audit 红线被穿——message_events.tool_call_result
//   记 success=true。MCP 规范中「工具失败」标位仅靠错误文本随 result 字符串透传
//   给模型。
//
// 修复契约（momo-boundary-rules：两端成对）：
//   - 协议层：McpToolCallOutcome { text: string; isError: boolean }——host-manager
//     callMcpTool / HttpMcpClient.callTool / McpClient 返回形状统一收敛
//   - 主进程侧（runtime-spawner）：mcp:callTool 桥回写 {id, result, isError}
//   - 子进程侧（mcp-bridge）：requestMcpCall 解析 isError；isError=true 抛
//     McpToolError（new Error 子类，message = text 保留模型可见语义文案）
//   - 消费点（runtime-entry chat loop catch）：McpToolError 文本原样回填（非
//     通用「工具执行失败: ...」前缀），tool_result chunk success=false；模型
//     仍收到 raw 错误文本（回合不崩、语义转述）
//
// 本文件锁定的契约段：
//   1. McpClient.callTool 已返回原始 McpToolResult（既有）——契约稳定，宿主
//      收敛提取层（host-manager.callMcpTool）新形态
//   2. HttpMcpClient.callTool 由「拼接文本字符串」改为「返回原始 McpToolResult」
//      ——消除 host-manager 的 typeof string 分支
//   3. host-manager.callMcpTool → McpToolCallOutcome {text, isError}
//   4. spawner bridge 回写 payload 含 isError
//   5. child-side requestMcpCall 解析 isError 并导出 McpToolError
//   6. doExecuteTool mcp: 分支 isError 时抛 McpToolError（message = text）
//   7. tool_failure_text(err) 助手区分 McpToolError 原样回填

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { McpToolCallOutcome, McpToolError } from '../../src/main/mcp/types';
import { HttpMcpClient } from '../../src/main/mcp/http-client';
import type { McpServerConfig } from '../../src/main/mcp/types';

// ─── 1+3. host-manager.callMcpTool 形状 ─────────────────────────────────────

// 最小 stdio fake server：listTools 返回固定一个工具 fail_op → isError 文本可配
const fakeServerScript = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } }
    }) + '\\n');
  } else if (msg.method === 'notifications/initialized') {
    // noop
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { tools: [{ name: 'op', description: 'd', inputSchema: { type: 'object' } }] }
    }) + '\\n');
  } else if (msg.method === 'tools/call') {
    const isError = process.env.MCP_FAKE_IS_ERROR === '1';
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: {
        content: [{ type: 'text', text: process.env.MCP_FAKE_TEXT || 'OK' }],
        isError,
      }
    }) + '\\n');
  }
});
`;

const tmpRoot = path.join(os.tmpdir(), `ap-iserror-${Date.now()}`);
let fakeScriptPath: string;

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  fakeScriptPath = path.join(tmpRoot, 'fake-mcp.cjs');
  fs.writeFileSync(fakeScriptPath, fakeServerScript);
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
  delete process.env.MCP_FAKE_TEXT;
  delete process.env.MCP_FAKE_IS_ERROR;
});

describe('MCP isError 语义透传契约（缺陷 #3 回归锁）', () => {
  it('1. host-manager.callMcpTool stdio isError=true → {text, isError:true}', async () => {
    // 走 config.env 而非 process.env：McpClient.connect 用 buildMcpEnv 白名单
    // 过滤 process.env（MCP server 是第三方，不能继承主进程全部环境变量）——按
    // MCP 契约，测试场景的工具注入只能走 config.env 段。
    const { callMcpTool, registerMcpDefinition } = await import('../../src/main/mcp/host-manager');
    registerMcpDefinition({
      id: 'ie-1', name: 'iserror-stdio', version: '1.0.0',
      command: process.execPath, args: [fakeScriptPath],
      env: { MCP_FAKE_TEXT: '操作失败：上游不可用', MCP_FAKE_IS_ERROR: '1' },
    });
    const outcome: McpToolCallOutcome = await callMcpTool('ws-ie', 'iserror-stdio', 'op', {});
    expect(outcome).toEqual({ text: '操作失败：上游不可用', isError: true });
  }, 15000);

  it('2. host-manager.callMcpTool stdio isError=false → {text, isError:false}', async () => {
    const { callMcpTool, registerMcpDefinition } = await import('../../src/main/mcp/host-manager');
    registerMcpDefinition({
      id: 'ie-2', name: 'iserror-ok', version: '1.0.0',
      command: process.execPath, args: [fakeScriptPath],
      env: { MCP_FAKE_TEXT: '正常返回', MCP_FAKE_IS_ERROR: '0' },
    });
    const outcome = await callMcpTool('ws-ie', 'iserror-ok', 'op', {});
    expect(outcome).toEqual({ text: '正常返回', isError: false });
  }, 15000);
});

// ─── 2. HttpMcpClient.callTool 返回原始 McpToolResult ──────────────────────

describe('HttpMcpClient raw shape（消除 typeof string 分支）', () => {
  it('callTool 返回原始 McpToolResult（含 content+isError），不再返回拼接文本', async () => {
    const cfg: McpServerConfig = {
      id: 'h1', name: 'http-shape', version: '1.0.0',
      transport: 'streamable_http',
      url: 'https://mcp.test/sse',
      headers: { Authorization: 'Bearer tk' },
      command: '',
      args: [],
    };
    // fetch stub：initialize + tools/call
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string; id?: number };
      if (body.method === 'notifications/initialized') {
        return { ok: true, status: 202 } as unknown as Response;
      }
      if (body.method === 'initialize') {
        return {
          ok: true, status: 200,
          json: async () => ({ jsonrpc: '2.0', id: body.id, result: { serverInfo: {}, capabilities: {} } }),
        } as unknown as Response;
      }
      if (body.method === 'tools/call') {
        return {
          ok: true, status: 200,
          json: async () => ({
            jsonrpc: '2.0', id: body.id,
            result: { content: [{ type: 'text', text: 'upstream-down' }], isError: true },
          }),
        } as unknown as Response;
      }
      throw new Error(`未桩：${body.method}`);
    });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    const result = await client.callTool('op', {});
    expect(result).toEqual({
      content: [{ type: 'text', text: 'upstream-down' }],
      isError: true,
    });
    // typeof 不再是 string（消除 host-manager 的 typeof string 分支）
    expect(typeof result).not.toBe('string');
    fetchSpy.mockRestore();
  }, 15000);
});

// ─── 5+6+7. 子进程契约（McpToolError + doExecuteTool + toolFailureText） ─────

describe('子进程侧契约（McpToolError + doExecuteTool + tool_failure_text）', () => {
  beforeEach(() => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    process.env.AP_USER_DATA_DIR = tmpRoot;
    runMigrations();
  });

  it('3. requestMcpCall 解析 isError 并解析文本（mcp-bridge 子进程侧）', async () => {
    // 捕获 mcp:callTool 载荷并回写 {id, result, isError:true}——直接调内部 handler
    // （绕开 process.emit('message',...) 的 Signals 类型不匹配）
    const originalSend = process.send;
    const sent: Array<Record<string, unknown>> = [];
    let capturedHandler: ((msg: unknown) => void) | null = null;
    process.send = ((msg: unknown): boolean => {
      sent.push(msg as Record<string, unknown>);
      const m = msg as { type?: string; id?: string };
      if (m.type === 'mcp:callTool' && typeof m.id === 'string' && capturedHandler) {
        capturedHandler({ id: m.id, result: '工具失败：E-500', isError: true });
      }
      return true;
    }) as NonNullable<typeof process.send>;
    const originalOn = process.on;
    process.on = ((event: string, cb: (msg: unknown) => void) => {
      if (event === 'message') capturedHandler = cb;
      return process;
    }) as typeof process.on;
    try {
      const { requestMcpCall } = await import('../../src/main/agent/mcp-bridge');
      const outcome = await requestMcpCall('ws-x', 'srv', 'tool', {});
      expect(outcome).toEqual({ text: '工具失败：E-500', isError: true });
    } finally {
      process.send = originalSend;
      process.on = originalOn;
    }
  });

  it('4. requestMcpCall isError=false → resolve 正常（不抛）', async () => {
    const originalSend = process.send;
    let capturedHandler: ((msg: unknown) => void) | null = null;
    process.send = ((msg: unknown): boolean => {
      const m = msg as { type?: string; id?: string };
      if (m.type === 'mcp:callTool' && typeof m.id === 'string' && capturedHandler) {
        capturedHandler({ id: m.id, result: 'all good', isError: false });
      }
      return true;
    }) as NonNullable<typeof process.send>;
    const originalOn = process.on;
    process.on = ((event: string, cb: (msg: unknown) => void) => {
      if (event === 'message') capturedHandler = cb;
      return process;
    }) as typeof process.on;
    try {
      const { requestMcpCall } = await import('../../src/main/agent/mcp-bridge');
      const outcome = await requestMcpCall('ws-x', 'srv', 'tool', {});
      expect(outcome).toEqual({ text: 'all good', isError: false });
    } finally {
      process.send = originalSend;
      process.on = originalOn;
    }
  });

  it('5. McpToolError 类可被识别，message 即错误文本', () => {
    const err = new McpToolError('E-500 不可用');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.message).toBe('E-500 不可用');
    expect(err.name).toBe('McpToolError');
  });

  it('6. tool_failure_text 助手：McpToolError 原样回填；其他错误加前缀', async () => {
    const { toolFailureText } = await import('../../src/main/agent/runtime-entry');
    expect(toolFailureText(new McpToolError('raw'))).toBe('raw');
    expect(toolFailureText(new Error('x'))).toBe('工具执行失败: x');
    expect(toolFailureText('string-throw')).toBe('工具执行失败: string-throw');
  });
});
