// electron/tests/agent/tools/officepro/runtime-wiring.test.ts
//
// office-pro 生产接线回归锁（execSandboxed / recordFileChange 注入）。
//
// 背景（2026-11-03 验收发现）：Task 2 落地了 execSandboxed 与 ToolContext
// 可选成员，但 runtime-entry 的 toolCtx 装配点漏注入——单测全绿（测试自己
// mock 了 ctx），生产 run_js 抛「宿主未注入 execSandboxed」。本测试对生产
// 装配点断言（头注思路照抄 shell-sandbox-wiring.test.ts）：走真实
// doExecuteTool 路由（runtime-entry toolCtx 装配 → executeToolModule），
// 不 mock ToolContext。若有人删掉装配处的注入：
//   - 用例 1/2 变红：捕获 ctx 上成员不再是函数 / run_js 门禁抛「宿主未注入」；
//   - 用例 4 变红：run_js 返回文本不再含「已记账」。
// 接线断言层级说明：toolCtx 是 doExecuteTool 内的局部对象，不可直接 import，
// 故经「探针工具模块」捕获生产组装的真实实例（等价于断言装配工厂产物）。
// vendor 用假件（fixtures.makeFakeVendor，不依赖 npm install）；沙箱状态钉
// permissive + 不可用（plain 直跑，spawn 真实 node）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceFS } from '../../../../src/main/files/workspace-fs';
import { doExecuteTool, type RuntimeContext } from '../../../../src/main/agent/runtime-entry';
import type { ToolContext, ToolModule } from '../../../../src/main/agent/tools/types';
import type { LLMToolCall } from '../../../../src/main/agent/llm-provider';
import type { RuntimeConfig, PluginToolRef } from '../../../../src/main/agent/runtime-config';
import { loadPluginToolModules } from '../../../../src/main/agent/tools/plugin-tools';
import { __setSandboxStateForTest } from '../../../../src/main/sandbox/probe';
import { __setSandboxSettingsForTest } from '../../../../src/main/sandbox/settings';
import { PLUGIN_ROOT, makeFakeVendor } from './fixtures';

let tmpDir: string;
let wsDir: string;
let ctx: RuntimeContext;
let capturedCtx: ToolContext | null;

/** 构造 LLMToolCall（id/name/arguments 三段） */
function call(name: string, args: Record<string, unknown>): LLMToolCall {
  return { id: `call-${randomUUID()}`, name, arguments: args };
}

/** 最小 RuntimeConfig——assertToolAllowed 仅读 allowedTools/deniedTools */
function makeConfig(): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-bot',
    agentUserId: '@bot:localhost',
    systemPrompt: '',
    modelName: 'test',
    llmApiKey: 'k',
    workspaceDir: wsDir,
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

/** 探针工具模块：经生产路由捕获 runtime-entry 组装的 ToolContext 实例 */
function probeModule(): ToolModule {
  return {
    getDefs: () => [],
    getCatalog: () => [],
    handles: (name) => name === 'probe_ctx',
    execute: async (_name, _args, toolCtx) => {
      capturedCtx = toolCtx;
      return 'probed';
    },
  };
}

/** 临时插件根（bootstrap/tools 复制 + 假 vendor）→ 真 run_js 插件模块 */
function loadRunJsModule(): ToolModule {
  const testPluginRoot = path.join(tmpDir, 'office-pro');
  fs.mkdirSync(path.join(testPluginRoot, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(testPluginRoot, 'bootstrap'), { recursive: true });
  fs.copyFileSync(path.join(PLUGIN_ROOT, 'bootstrap/run.js'), path.join(testPluginRoot, 'bootstrap/run.js'));
  fs.copyFileSync(path.join(PLUGIN_ROOT, 'tools/run_js.js'), path.join(testPluginRoot, 'tools/run_js.js'));
  makeFakeVendor(path.join(testPluginRoot, 'vendor'));
  const ref: PluginToolRef = {
    pluginId: 'office-pro',
    rootDir: testPluginRoot,
    modulePaths: [path.join(testPluginRoot, 'tools/run_js.js')],
    dataDir: path.join(tmpDir, 'data'),
    config: {},
  };
  const { modules, failures } = loadPluginToolModules([ref], vi.fn());
  expect(failures).toHaveLength(0);
  return modules[0]!;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-officepro-wiring-'));
  wsDir = path.join(tmpDir, 'ws');
  fs.mkdirSync(wsDir, { recursive: true });
  capturedCtx = null;
  const wsFs = new WorkspaceFS(wsDir);
  const skillRegistry = { list: () => [] } as never;
  const sendStreamChunk = () => {};
  ctx = {
    wsFs,
    skillRegistry,
    tools: [],
    systemPrompt: '',
    workspaceId: 'ws',
    workspaceDir: wsDir,
    roomId: '!r',
    streamSessionId: `ssn-${randomUUID()}`,
    sendStreamChunk,
    creatorUserId: 'test-user',
    toolModules: [probeModule(), loadRunJsModule()],
  };
  __setSandboxSettingsForTest({ mode: 'permissive', networkPolicy: 'deny' });
  __setSandboxStateForTest({
    platform: process.platform, sandboxTool: null, toolVersion: null,
    available: false, unavailableReason: '单测钉 plain', windowsShell: null,
    executionPolicy: null, probedAt: 0,
  });
});

afterEach(() => {
  __setSandboxSettingsForTest(null);
  __setSandboxStateForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('office-pro 生产接线（runtime-entry toolCtx 装配，真实路由）', () => {
  it('装配点已注入：ctx.execSandboxed / ctx.recordFileChange 均为函数', async () => {
    await doExecuteTool(call('probe_ctx', {}), ctx, makeConfig());
    expect(capturedCtx).not.toBeNull();
    expect(typeof capturedCtx!.execSandboxed).toBe('function');
    expect(typeof capturedCtx!.recordFileChange).toBe('function');
  });

  it('execSandboxed 真实可执行：直调 node -e 输出 wired、退出码 0', async () => {
    await doExecuteTool(call('probe_ctx', {}), ctx, makeConfig());
    const res = await capturedCtx!.execSandboxed!({
      argv: [process.execPath, '-e', "console.log('wired')"],
      cwd: wsDir,
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('wired');
  });

  it('recordFileChange 直调不抛（测试无 journal store → 降级跳过记账）', async () => {
    await doExecuteTool(call('probe_ctx', {}), ctx, makeConfig());
    fs.writeFileSync(path.join(wsDir, 'probe.txt'), 'x');
    expect(() =>
      capturedCtx!.recordFileChange!('plugin:office-pro/run_js', 'probe.txt', 'create', null, Buffer.from('x')),
    ).not.toThrow();
  });

  it('端到端：真实路由跑 run_js（接线缺失则此处抛「宿主未注入 execSandboxed」）', async () => {
    const result = await doExecuteTool(
      call('plugin:office-pro/run_js', {
        script: `require('fs').writeFileSync('wired.txt', 'ok'); console.log('wired');`,
        outputs: ['wired.txt'],
        timeout_ms: 30_000,
      }),
      ctx,
      makeConfig(),
    );
    expect(result).toContain('退出码=0');
    expect(result).toContain('wired');
    // 「已记账」标记仅在 ctx.recordFileChange 为函数时出现（run_js 记账行拼接逻辑）
    expect(result).toContain('wired.txt: create 已记账');
    expect(fs.existsSync(path.join(wsDir, 'wired.txt'))).toBe(true);
  });
});
