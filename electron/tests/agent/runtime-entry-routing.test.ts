// electron/tests/agent/runtime-entry-routing.test.ts
//
// doExecuteTool 工具路由回归测试（v1.5 修复）。
//
// 背景：runtime-entry.doExecuteTool 曾硬编码 read_file/write_file/list_files 三个名字，
//   导致 v1.5 全部 21 个新工具（edit_file/mkdir/rm/mv/exists/grep/glob/bash/git_*/
//   webfetch/todowrite/lsp_*）落到末尾 throw new Error('未知工具: ${name}')，
//   生产 agent 无法调用任何 v1.5 工具。集成测试 tools/integration.test.ts 直接 import
//   注册中心的 executeTool，绕过了 doExecuteTool，故长期未暴露。
//
// 本测试直接对生产路由入口 doExecuteTool 断言，覆盖：
//   1. v1.5 新工具（exists / bash）路由命中注册中心，不抛"未知工具"
//   2. 原 v1.4 文件工具（list_files）迁移后仍正常（向后兼容）
//   3. 未知工具名仍抛"未知工具"
//   4. 工具权限（assertToolAllowed）在路由前仍生效（deniedTools 命中即拒绝）
//
// 可直接 import 说明：runtime-entry 的 main() 由 AGENT_CONFIG 环境变量守护
//   （见文件末尾 if (process.env.AGENT_CONFIG !== undefined)），单测 import 不触发
//   子进程启动；coordinator-trigger.test.ts 已沿用此模式。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { MatrixClient } from 'matrix-js-sdk';
import { WorkspaceFS } from '../../src/main/files/workspace-fs';
import { buildToolRegistry } from '../../src/main/agent/tools';
import type { LLMToolCall } from '../../src/main/agent/llm-provider';
import {
  doExecuteTool,
  type RuntimeConfig,
  type RuntimeContext,
} from '../../src/main/agent/runtime-entry';

// bash 工具不触碰 MatrixClient；这些路径下传桩对象即可。
const client = {} as unknown as MatrixClient;

let tmpDir: string;
let ctx: RuntimeContext;

/** 构造 LLMToolCall（id/name/arguments 三段） */
function call(name: string, args: Record<string, unknown>): LLMToolCall {
  return { id: 'call-1', name, arguments: args };
}

/** 构造最小 RuntimeConfig——assertToolAllowed 仅读 allowedTools/deniedTools */
function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-bot',
    agentUserId: '@bot:localhost',
    teamSessionId: '!team:localhost',
    systemPrompt: '',
    modelName: 'test',
    llmApiKey: 'k',
    workspaceDir: tmpDir,
    workspaceId: 'ws',
    role: 'standalone',
    subAgents: [],
    skills: [],
    mcpNames: [],
    allowedTools: [],
    deniedTools: [],
    isCoordinator: false,
    devMode: false,
    maxToolCalls: 10,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-routing-'));
  const wsFs = new WorkspaceFS(tmpDir);
  // skillRegistry 在本测试的工具路径中不被调用，给最小桩满足类型约束
  const skillRegistry = { list: () => [] } as never;
  const sendStreamChunk = () => {};
  // buildToolRegistry 仅用 workspaceDir 做 LspTools 条件注册判断（tmpDir 无 tsconfig
  // → shouldRegister=false → LSP 不注册，符合预期）；其余字段给最小桩。
  const sharedToolCtxFields = {
    wsFs,
    workspaceId: 'ws',
    workspaceDir: tmpDir,
    skillRegistry,
    streamSessionId: 'ssn',
    roomId: '!r',
    sendStreamChunk,
    permissionConfig: { allowedTools: [] as string[], deniedTools: [] as string[] },
  };
  ctx = {
    wsFs,
    skillRegistry,
    tools: [],
    systemPrompt: '',
    workspaceId: 'ws',
    workspaceDir: tmpDir,
    roomId: '!r',
    streamSessionId: 'ssn',
    sendStreamChunk,
    toolModules: buildToolRegistry(sharedToolCtxFields),
  };
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('doExecuteTool 工具路由（v1.5 注册中心修复回归）', () => {
  it('v1.5 文件工具 exists 命中注册中心，返回"存在"', async () => {
    const out = await doExecuteTool(call('exists', { path: '.' }), ctx, client, makeConfig());
    expect(out).toBe('存在');
  });

  it('v1.5 shell 工具 bash 命中注册中心并执行', async () => {
    const out = await doExecuteTool(
      call('bash', { command: 'echo routing_ok' }),
      ctx,
      client,
      makeConfig(),
    );
    expect(out).toContain('routing_ok');
  });

  it('原 v1.4 工具 list_files 迁移到注册中心后仍正常（向后兼容）', async () => {
    const out = await doExecuteTool(call('list_files', { path: '.' }), ctx, client, makeConfig());
    expect(typeof out).toBe('string');
  });

  it('未知工具名仍抛"未知工具"', async () => {
    await expect(
      doExecuteTool(call('__nonexistent_v1_5_routing_test__', {}), ctx, client, makeConfig()),
    ).rejects.toThrow('未知工具');
  });

  it('工具权限 deniedTools 在路由前生效（命中 bash 即拒绝）', async () => {
    await expect(
      doExecuteTool(call('bash', { command: 'echo x' }), ctx, client, makeConfig({ deniedTools: ['bash'] })),
    ).rejects.toThrow('被禁止使用');
  });
});
