// electron/tests/agent/mcp-spawner-win32.test.ts
//
// MCP spawner win32 shell 分支（v2.10.0 Windows 全平台化 Task 3）：
// 裸命令 `npx -y @mcp/server` 在 win32 上必 ENOENT——Node spawn 无 shell 时
// 直接走 CreateProcess，只解析 .exe（PATHEXT 不参与），而 npx 实为 npx.cmd
// 批处理 shim。本测试锁死修正契约：
//   - win32 → spawn opts.shell === true + args 逐元素经 escapeWinArg 转义
//   - linux → shell 未设（undefined）+ args 原样（零变化）
//   - 内嵌 `"` → 拒绝启动（中文报错 + spawn 不被调用）
//
// Mock 收窄（对齐 momo-test-rules）：只 mock 进程边界 node:child_process.spawn；
// escapeWinArg 与 McpClient 全走真实实现。fake proc 的 stdin.write 收到带 id 的
// JSON-RPC 请求时同步回发 initialize 应答（仿真真实 NDJSON 线协议——connect
// 全程真实跑完握手，而非半途挂起留孤儿 timer）。
//
// 接线锁：摘掉 client.ts connect() 里的 shell 三元 → win32 断言必红。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// vi.mock 工厂被提升到 import 之前，用 vi.hoisted 共享 spawn mock
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import { McpClient, escapeWinArg } from '../../src/main/mcp/client';
import type { McpServerConfig } from '../../src/main/mcp/types';

/** spawn 调用参数形状（command, args, opts）——从无类型 mock 收敛为结构化断言用 */
type SpawnCall = [string, string[], { shell?: boolean; env?: NodeJS.ProcessEnv; stdio?: string[] }];

/**
 * 仿真 ChildProcessWithoutNullStreams 的最小面：stdout/stderr 可 emit data、
 * stdin.write 回放 initialize 应答、on/kill 可调用。connect() 的全部消费点
 * （stdout.on / stderr.on / on('exit') / on('error') / stdin.write）都被覆盖。
 */
function makeFakeProc(): {
  proc: unknown;
  emitExit: () => void;
} {
  const bus = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = {
    write: vi.fn((payload: string) => {
      const msg = JSON.parse(payload) as { id?: number };
      // 只应答带 id 的请求（notification 无 id 不应答——真实线协议语义）
      if (msg.id !== undefined) {
        stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {} } }) + '\n',
          ),
        );
      }
    }),
  };
  const proc = Object.assign(bus, { stdout, stderr, stdin, kill: vi.fn() });
  return { proc, emitExit: () => bus.emit('exit', 0) };
}

/** process.platform 双态注入 + 还原（Object.defineProperty 覆写值属性） */
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

const originalPlatform: NodeJS.Platform = process.platform;

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => makeFakeProc().proc);
});

afterEach(() => {
  // 平台还原必须无条件执行——泄漏 win32 态会污染同 worker 后续测试
  setPlatform(originalPlatform);
});

/** 平台态下 connect 并返回捕获到的 spawn 调用（断言 shell/args 契约） */
async function connectAndCapture(
  platform: NodeJS.Platform,
  args: string[],
): Promise<{ client: McpClient; call: SpawnCall }> {
  setPlatform(platform);
  const config: McpServerConfig = {
    id: 'mcp-win',
    name: 'win-mcp',
    version: '1.0.0',
    command: 'npx',
    args,
  };
  const client = new McpClient(config);
  await client.connect();
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const call = spawnMock.mock.calls[0] as unknown as SpawnCall;
  await client.disconnect();
  return { client, call };
}

describe('escapeWinArg 契约（win32 参数转义 helper）', () => {
  it('白名单安全字符原样返回（包名/flag/版本/路径形态）', () => {
    expect(escapeWinArg('npx')).toBe('npx');
    expect(escapeWinArg('-y')).toBe('-y');
    expect(escapeWinArg('@modelcontextprotocol/server-github')).toBe('@modelcontextprotocol/server-github');
    expect(escapeWinArg('--transport=stdio')).toBe('--transport=stdio');
    expect(escapeWinArg('C:/tools/server-v1.2.0.js')).toBe('C:/tools/server-v1.2.0.js');
  });

  it('含空格 → 双引号包裹', () => {
    expect(escapeWinArg('hello world')).toBe('"hello world"');
    expect(escapeWinArg('C:\\Program Files\\tool')).toBe('"C:\\Program Files\\tool"');
  });

  it('含 cmd 元字符（& ^ % ( ) | < > , ; !）→ 双引号包裹（引号内 cmd 全部字面化）', () => {
    expect(escapeWinArg('a&b')).toBe('"a&b"');
    expect(escapeWinArg('a^b')).toBe('"a^b"');
    expect(escapeWinArg('a%b')).toBe('"a%b"');
    expect(escapeWinArg('a(b)c')).toBe('"a(b)c"');
    expect(escapeWinArg('a|b')).toBe('"a|b"');
    expect(escapeWinArg('a<b>c')).toBe('"a<b>c"');
    expect(escapeWinArg('a,b;c')).toBe('"a,b;c"');
    expect(escapeWinArg('hello!')).toBe('"hello!"');
  });

  it('内嵌双引号 → 抛中文错误拒绝（无法安全转义，绝不静默破损）', () => {
    expect(() => escapeWinArg('a"b')).toThrow(/双引号/);
    expect(() => escapeWinArg('say "hi" now')).toThrow(/拒绝启动/);
  });

  it('空字符串 → 双引号包裹（空参数必须显式成对引号才能存活 argv 切分）', () => {
    expect(escapeWinArg('')).toBe('""');
  });
});

describe('McpClient.connect 平台双态（win32 shell 分支 / linux 原样）', () => {
  it('win32 → opts.shell === true + args 逐元素经 escapeWinArg 转义', async () => {
    const { call } = await connectAndCapture('win32', [
      '-y',
      '@modelcontextprotocol/server-everything',
      '--port 3000',
      'a&b',
    ]);
    const [command, args, opts] = call;
    expect(command).toBe('npx');
    expect(opts.shell).toBe(true);
    // 逐元素转义：白名单原样、空格/metachar 包裹
    expect(args).toStrictEqual([
      '-y',
      '@modelcontextprotocol/server-everything',
      '"--port 3000"',
      '"a&b"',
    ]);
    // 其余 opts 不因平台分支漂移（env 白名单 + 三管道 stdio 语义不变）
    expect(opts.stdio).toStrictEqual(['pipe', 'pipe', 'pipe']);
    expect(opts.env).toBeTypeOf('object');
  });

  it('linux → shell 未设（undefined）+ args 原样零变化', async () => {
    const originalArgs = ['-y', '@modelcontextprotocol/server-github', '--port 3000', 'a&b'];
    const { call } = await connectAndCapture('linux', originalArgs);
    const [, args, opts] = call;
    expect(opts.shell).toBeUndefined();
    expect(args).toStrictEqual(originalArgs);
    expect(opts.stdio).toStrictEqual(['pipe', 'pipe', 'pipe']);
  });

  it('win32 + 参数内嵌双引号 → connect 拒绝（中文报错）且 spawn 不被调用', async () => {
    setPlatform('win32');
    const config: McpServerConfig = {
      id: 'mcp-quote',
      name: 'quote-mcp',
      version: '1.0.0',
      command: 'npx',
      args: ['-y', 'a"b'],
    };
    const client = new McpClient(config);
    await expect(client.connect()).rejects.toThrow(/双引号/);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(client.isConnected).toBe(false);
  });

  it('win32 转义在握手链路上真实可用（connect 全程 resolve，非仅 spawn 形态）', async () => {
    // 防御性回归：shell 分支不破坏 initialize 握手的 stdin/stdout 线协议消费
    // （不经 connectAndCapture——该 helper 返回前已 disconnect，isConnected 必 false）
    setPlatform('win32');
    const config: McpServerConfig = {
      id: 'mcp-handshake',
      name: 'handshake-mcp',
      version: '1.0.0',
      command: 'npx',
      args: ['-y', '@scope/server x'],
    };
    const client = new McpClient(config);
    await expect(client.connect()).resolves.toBeUndefined();
    expect(client.isConnected).toBe(true);
    await client.disconnect();
  });
});
