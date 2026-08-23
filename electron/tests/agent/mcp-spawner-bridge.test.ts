// electron/tests/agent/mcp-spawner-bridge.test.ts
//
// mcp:listTools / mcp:callTool 子进程桥（P2 Task 9，恢复 task-driven 路径的
// MCP 工具可用性——根因：spawner 无 mcp:* 响应者，子进程 mcp-bridge.ts 30s 超时）：
//   - listTools 成功 → child.send 恰为 { id, tools }；失败 → { id, error }
//   - callTool 透传 args（参数序 workspaceId/mcpName/toolName/args）→ { id, result } / { id, error }
//   - 响应不带 type 字段（子进程 mcp-bridge.ts 仅按 m.id 配对，不检查 type）——
//     全部用 toStrictEqual 锁死精确载荷键
//   - audit:toolCall 分支（T8）与 mcp 分支共存互不干扰
//
// Fix round 1（死通道防御 + 非错误收敛 + 池惰性填充）：
//   - listTools / callTool 分支先 ensureMcpStarted（getMcpConfig → getOrStartMcp）
//     再 listMcpTools / callMcpTool——invocationCallOrder 锁调用顺序
//   - getOrStartMcp 拒绝 / MCP 未注册 → { id, error }
//   - 死通道竞态：子进程在 await 期间死亡 → child.send 抛 ERR_IPC_CHANNEL_CLOSED
//     被 sendMcpResponse 吞掉，handler 正常 resolve（无 unhandledRejection 逃逸）
//   - 非 Error 抛出物（string rejection）→ error 字段收敛为字符串而非 undefined
//
// fork 被 mock，message handler 被捕获后直接调用；host-manager / audit 模块被
// mock（本测试只验证桥的转发逻辑，不碰真 MCP 进程池与真库）。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpToolInfo, McpServerConfig } from '../../src/main/mcp/types';

// vi.mock 工厂被提升到 import 之前，用 vi.hoisted 共享 handler 捕获槽与 send spy
const captured = vi.hoisted(() => ({
  handler: null as ((msg: unknown) => void | Promise<void>) | null,
  send: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  fork: vi.fn(() => ({
    pid: 4343,
    on: (event: string, cb: (msg: unknown) => void) => {
      if (event === 'message') captured.handler = cb;
    },
    off: vi.fn(),
    send: captured.send,
    kill: vi.fn(),
    connected: true,
    once: vi.fn(),
  })),
}));

vi.mock('../../src/main/mcp/host-manager', () => ({
  listMcpTools: vi.fn(),
  callMcpTool: vi.fn(),
  getOrStartMcp: vi.fn(),
  getMcpConfig: vi.fn(),
}));
vi.mock('../../src/main/audit/insert', () => ({ insertToolCall: vi.fn() }));
vi.mock('../../src/main/audit/quota', () => ({ enforceAuditQuota: vi.fn() }));

import { spawnForAgent } from '../../src/main/agent/runtime-spawner';
import { listMcpTools, callMcpTool, getOrStartMcp, getMcpConfig } from '../../src/main/mcp/host-manager';
import { insertToolCall } from '../../src/main/audit/insert';
import type { AgentRuntimeOpts } from '../../src/main/agent/runtime-config';

const runtimeConfig: AgentRuntimeOpts = {
  instanceId: 'inst1',
  workspaceId: 'ws-mcp',
  workspaceDir: '/tmp/ws-mcp',
  agentAssignmentId: 'inst1',
  agentUserId: 'agent-pm-1',
  teamSessionId: 'sess-team',
  systemPrompt: '',
  modelName: 'glm-4.7',
  llmApiKey: 'k',
};

const SAMPLE_TOOLS: McpToolInfo[] = [
  { name: 'create_issue', description: '建 issue', inputSchema: { type: 'object' } },
];

const MCP_CONFIG: McpServerConfig = {
  id: 'mcp-1',
  name: 'github',
  version: '1.0.0',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
};

/** spawn 一个 runtime 并返回捕获到的 message handler */
async function spawnAndGetHandler(): Promise<(msg: unknown) => void | Promise<void>> {
  captured.handler = null;
  await spawnForAgent({
    assignmentId: 'inst1',
    runtimeConfig,
    onChunk: vi.fn(),
    onExit: vi.fn(),
  });
  expect(captured.handler).toBeTruthy();
  return captured.handler as (msg: unknown) => void | Promise<void>;
}

/** 取 send 的第 n 次调用载荷（锁精确键集用） */
function sentPayload(callIdx = 0): unknown {
  expect(captured.send).toHaveBeenCalledTimes(callIdx + 1);
  return captured.send.mock.calls[callIdx]?.[0];
}

describe('runtime-spawner mcp 桥（mcp:listTools / mcp:callTool）', () => {
  beforeEach(() => {
    // mockReset 清调用 + 实现（clearAllMocks 只清调用，上一测试的
    // mockRejectedValue 实现会泄漏到下一测试）；再设默认：MCP 已注册 + send 正常回写
    vi.clearAllMocks();
    vi.mocked(listMcpTools).mockReset();
    vi.mocked(callMcpTool).mockReset();
    vi.mocked(getOrStartMcp).mockReset();
    vi.mocked(getMcpConfig).mockReset().mockReturnValue(MCP_CONFIG);
    captured.send.mockImplementation(() => true);
  });

  it('mcp:listTools 成功 → 回写恰为 { id, tools }（无 type 字段）', async () => {
    const handler = await spawnAndGetHandler();
    vi.mocked(listMcpTools).mockResolvedValue(SAMPLE_TOOLS);
    await handler({ type: 'mcp:listTools', id: 'req-1', workspaceId: 'ws-mcp', mcpName: 'github' });
    expect(listMcpTools).toHaveBeenCalledWith('ws-mcp', 'github');
    expect(sentPayload()).toStrictEqual({ id: 'req-1', tools: SAMPLE_TOOLS });
  });

  it('mcp:listTools 失败 → 回写恰为 { id, error }', async () => {
    const handler = await spawnAndGetHandler();
    vi.mocked(listMcpTools).mockRejectedValue(new Error('MCP github 未启动'));
    await handler({ type: 'mcp:listTools', id: 'req-2', workspaceId: 'ws-mcp', mcpName: 'github' });
    expect(sentPayload()).toStrictEqual({ id: 'req-2', error: 'MCP github 未启动' });
  });

  it('mcp:callTool 成功 → args 原样透传 + 回写恰为 { id, result }', async () => {
    const handler = await spawnAndGetHandler();
    vi.mocked(callMcpTool).mockResolvedValue('issue #42 已创建');
    await handler({
      type: 'mcp:callTool',
      id: 'req-3',
      workspaceId: 'ws-mcp',
      mcpName: 'github',
      toolName: 'create_issue',
      args: { title: 'bug', labels: ['p1'] },
    });
    expect(callMcpTool).toHaveBeenCalledTimes(1);
    expect(callMcpTool).toHaveBeenCalledWith('ws-mcp', 'github', 'create_issue', {
      title: 'bug',
      labels: ['p1'],
    });
    // Fix 2：callTool 分支同样先惰性启动（防御 discovery 被跳过的路径）
    expect(getOrStartMcp).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getOrStartMcp).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(callMcpTool).mock.invocationCallOrder[0],
    );
    expect(sentPayload()).toStrictEqual({ id: 'req-3', result: 'issue #42 已创建' });
  });

  it('mcp:callTool 失败 → 回写恰为 { id, error }', async () => {
    const handler = await spawnAndGetHandler();
    vi.mocked(callMcpTool).mockRejectedValue(new Error('工具执行超时'));
    await handler({
      type: 'mcp:callTool',
      id: 'req-4',
      workspaceId: 'ws-mcp',
      mcpName: 'github',
      toolName: 'create_issue',
      args: {},
    });
    expect(sentPayload()).toStrictEqual({ id: 'req-4', error: '工具执行超时' });
  });

  it('mcp:callTool args 缺省 → 以空对象调用 host-manager', async () => {
    const handler = await spawnAndGetHandler();
    vi.mocked(callMcpTool).mockResolvedValue('pong');
    await handler({
      type: 'mcp:callTool',
      id: 'req-5',
      workspaceId: 'ws-mcp',
      mcpName: 'github',
      toolName: 'ping',
    });
    expect(callMcpTool).toHaveBeenCalledWith('ws-mcp', 'github', 'ping', {});
    expect(sentPayload()).toStrictEqual({ id: 'req-5', result: 'pong' });
  });

  it('audit:toolCall 分支与 mcp 分支共存：audit 仍落库且不回写，mcp 照常响应', async () => {
    const handler = await spawnAndGetHandler();
    vi.mocked(listMcpTools).mockResolvedValue([]);
    handler({
      type: 'audit:toolCall',
      toolName: 'read_file',
      inputSummary: 'README.md',
      outputSummary: '内容',
      success: true,
      durationMs: 42,
    });
    // audit 分支不回写任何 mcp 响应
    expect(captured.send).not.toHaveBeenCalled();
    await handler({ type: 'mcp:listTools', id: 'req-6', workspaceId: 'ws-mcp', mcpName: 'github' });
    expect(insertToolCall).toHaveBeenCalledTimes(1);
    expect(insertToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-mcp', toolName: 'read_file' }),
    );
    expect(sentPayload()).toStrictEqual({ id: 'req-6', tools: [] });
  });

  it('mcp 请求不落入 chunk 通道（onChunk 不被调用）', async () => {
    const onChunk = vi.fn();
    captured.handler = null;
    await spawnForAgent({ assignmentId: 'inst1', runtimeConfig, onChunk, onExit: vi.fn() });
    const handler = captured.handler!;
    vi.mocked(callMcpTool).mockResolvedValue('ok');
    await handler({
      type: 'mcp:callTool',
      id: 'req-7',
      workspaceId: 'ws-mcp',
      mcpName: 'github',
      toolName: 'ping',
      args: {},
    });
    expect(onChunk).not.toHaveBeenCalled();
  });
});

describe('runtime-spawner mcp 桥 fix round 1（死通道防御 / 池惰性填充 / 非错误收敛）', () => {
  beforeEach(() => {
    // 同上：mockReset 防实现泄漏
    vi.clearAllMocks();
    vi.mocked(listMcpTools).mockReset();
    vi.mocked(callMcpTool).mockReset();
    vi.mocked(getOrStartMcp).mockReset();
    vi.mocked(getMcpConfig).mockReset().mockReturnValue(MCP_CONFIG);
    captured.send.mockImplementation(() => true);
  });

  it('mcp:listTools 先 ensureMcpStarted（getMcpConfig → getOrStartMcp）再 listMcpTools（顺序锁定）', async () => {
    const handler = await spawnAndGetHandler();
    vi.mocked(listMcpTools).mockResolvedValue(SAMPLE_TOOLS);
    await handler({ type: 'mcp:listTools', id: 'fix-o1', workspaceId: 'ws-mcp', mcpName: 'github' });
    expect(getMcpConfig).toHaveBeenCalledWith('github');
    expect(getOrStartMcp).toHaveBeenCalledTimes(1);
    expect(getOrStartMcp).toHaveBeenCalledWith('ws-mcp', MCP_CONFIG);
    expect(listMcpTools).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getOrStartMcp).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(listMcpTools).mock.invocationCallOrder[0],
    );
    expect(sentPayload()).toStrictEqual({ id: 'fix-o1', tools: SAMPLE_TOOLS });
  });

  it('getOrStartMcp 拒绝 → { id, error } 且不调 listMcpTools', async () => {
    const handler = await spawnAndGetHandler();
    vi.mocked(getOrStartMcp).mockRejectedValue(new Error('MCP server 连接失败'));
    await handler({ type: 'mcp:listTools', id: 'fix-o2', workspaceId: 'ws-mcp', mcpName: 'github' });
    expect(listMcpTools).not.toHaveBeenCalled();
    expect(sentPayload()).toStrictEqual({ id: 'fix-o2', error: 'MCP server 连接失败' });
  });

  it('MCP 未注册（getMcpConfig 返回 null）→ { id, error } 且不起进程', async () => {
    const handler = await spawnAndGetHandler();
    vi.mocked(getMcpConfig).mockReturnValue(null);
    await handler({ type: 'mcp:listTools', id: 'fix-o3', workspaceId: 'ws-mcp', mcpName: 'nope' });
    expect(getOrStartMcp).not.toHaveBeenCalled();
    expect(listMcpTools).not.toHaveBeenCalled();
    expect(sentPayload()).toStrictEqual({ id: 'fix-o3', error: 'MCP nope 未注册' });
  });

  it('死通道防御（catch 路径）：send 抛 ERR_IPC_CHANNEL_CLOSED 被吞，handler 正常 resolve', async () => {
    const handler = await spawnAndGetHandler();
    vi.mocked(listMcpTools).mockRejectedValue(new Error('MCP github 未启动'));
    captured.send.mockImplementation(() => {
      throw new Error('ERR_IPC_CHANNEL_CLOSED');
    });
    await expect(
      handler({ type: 'mcp:listTools', id: 'fix-d1', workspaceId: 'ws-mcp', mcpName: 'github' }),
    ).resolves.toBeUndefined();
  });

  it('死通道防御（成功路径）：await 期间子进程死亡 → send 抛错同样被吞', async () => {
    const handler = await spawnAndGetHandler();
    vi.mocked(listMcpTools).mockResolvedValue(SAMPLE_TOOLS);
    captured.send.mockImplementation(() => {
      throw new Error('ERR_IPC_CHANNEL_CLOSED');
    });
    await expect(
      handler({ type: 'mcp:listTools', id: 'fix-d2', workspaceId: 'ws-mcp', mcpName: 'github' }),
    ).resolves.toBeUndefined();
    // callTool 分支同构竞态
    vi.mocked(callMcpTool).mockResolvedValue('ok');
    await expect(
      handler({ type: 'mcp:callTool', id: 'fix-d3', workspaceId: 'ws-mcp', mcpName: 'github', toolName: 't', args: {} }),
    ).resolves.toBeUndefined();
  });

  it('非 Error 抛出物（string rejection）→ error 收敛为字符串而非 undefined', async () => {
    const handler = await spawnAndGetHandler();
    vi.mocked(callMcpTool).mockRejectedValue('boom');
    await handler({
      type: 'mcp:callTool',
      id: 'fix-n1',
      workspaceId: 'ws-mcp',
      mcpName: 'github',
      toolName: 't',
      args: {},
    });
    expect(sentPayload()).toStrictEqual({ id: 'fix-n1', error: 'boom' });
  });
});
