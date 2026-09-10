// electron/tests/agent/tools/shell-sandbox-wiring.test.ts
// v2.4 OS 沙箱生产接线回归锁。
//
// 背景（v2.3 spec#1 C1 教训）：单测手动注入依赖、生产组装路径未接线时，
//   单测全绿但生产 no-op。本测试对生产路由入口断言——若有人把 ShellTools.execute
//   里的 resolveShellSpawn 调用删掉（回到平台硬编码 /bin/bash）：
//   - 用例 1 变红：结果不再含 `sandbox:` 行（tag 由 resolveShellSpawn 产出）；
//   - 用例 2 变红：strict + 不可用不再在 spawn 前抛错。
//
// 走真实 doExecuteTool 路由（注册中心 → ShellTools），真实临时 workspace +
// 真实 WorkspaceFS，不 mock 任何工具（模式照抄 read-tracker-wiring.test.ts）。
// 仅经测试钩子注入沙箱设置/探测状态（对应生产「设置页 + boot 探测」两个输入源）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import { buildToolRegistry } from '../../../src/main/agent/tools';
import type { LLMToolCall } from '../../../src/main/agent/llm-provider';
import type { RuntimeConfig } from '../../../src/main/agent/runtime-config';
import { doExecuteTool, type RuntimeContext } from '../../../src/main/agent/runtime-entry';
import { __setSandboxStateForTest } from '../../../src/main/sandbox/probe';
import { __setSandboxSettingsForTest } from '../../../src/main/sandbox/settings';

let tmpDir: string;
let ctx: RuntimeContext;

/** 构造 LLMToolCall（id/name/arguments 三段） */
function call(name: string, args: Record<string, unknown>): LLMToolCall {
  return { id: `call-${randomUUID()}`, name, arguments: args };
}

/** 构造最小 RuntimeConfig——assertToolAllowed 仅读 allowedTools/deniedTools */
function makeConfig(): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-bot',
    agentUserId: '@bot:localhost',
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
    isLeader: false,
    devMode: false,
    maxToolCalls: 10,
    contextWindow: 0,
    outputTokens: 0,
  };
}

/** 经生产路由执行 bash：doExecuteTool → 注册中心 → ShellTools.execute */
function executeBashViaRealRoute(command: string): Promise<string> {
  return doExecuteTool(call('bash', { command }), ctx, makeConfig());
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-v24-sandbox-wiring-'));
  const wsFs = new WorkspaceFS(tmpDir);
  const skillRegistry = { list: () => [] } as never;
  const sendStreamChunk = () => {};
  const sharedToolCtxFields = {
    wsFs,
    workspaceId: 'ws',
    workspaceDir: tmpDir,
    skillRegistry,
    streamSessionId: `ssn-${randomUUID()}`,
    roomId: '!r',
    sendStreamChunk,
    permissionConfig: { allowedTools: [] as string[], deniedTools: [] as string[] },
    creatorUserId: 'test-user',
  };
  ctx = {
    wsFs,
    skillRegistry,
    tools: [],
    systemPrompt: '',
    workspaceId: 'ws',
    workspaceDir: tmpDir,
    roomId: '!r',
    streamSessionId: sharedToolCtxFields.streamSessionId,
    sendStreamChunk,
    creatorUserId: 'test-user',
    toolModules: buildToolRegistry(sharedToolCtxFields),
  };
  // permissive + 沙箱不可用（bwrap 未安装）→ resolveShellSpawn 应降级 plain 直跑
  __setSandboxSettingsForTest({ mode: 'permissive', networkEnabled: false });
  __setSandboxStateForTest({
    platform: 'linux', sandboxTool: null, toolVersion: null,
    available: false, unavailableReason: 'bwrap 未安装', windowsShell: null,
    executionPolicy: null, probedAt: 0,
  });
});

afterEach(() => {
  __setSandboxSettingsForTest(null);
  __setSandboxStateForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('bash 工具沙箱接线（真实路由）', () => {
  it('permissive + 不可用 → 命令真实执行 + 结果含 unsandboxed 标记', async () => {
    const result = await executeBashViaRealRoute('echo hello');
    expect(result).toContain('exit_code: 0');
    expect(result).toContain('sandbox: unsandboxed:bwrap 未安装');
    expect(result).toContain('hello');
  });

  it('strict + 不可用 → 抛错含安装指引（不 spawn）', async () => {
    __setSandboxSettingsForTest({ mode: 'strict', networkEnabled: false });
    await expect(executeBashViaRealRoute('echo hello')).rejects.toThrow('bubblewrap');
  });
});
