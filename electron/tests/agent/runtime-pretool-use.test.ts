// electron/tests/agent/runtime-pretool-use.test.ts
//
// doExecuteTool 的 preToolUse 拦截锁（spec §5.2 顺序：插件 waterfall → 内置
// 权限 → 执行）：deny 抛错不执行 / rewrite 后工具收新 args / null 直通 /
// 既有权限闸顺序不变（deny 先于 assertToolAllowed——deny 的错误文案区分）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { WorkspaceFS } from '../../src/main/files/workspace-fs';
import { buildToolRegistry } from '../../src/main/agent/tools';
import { doExecuteTool, __setPreToolUseHookForTest, type RuntimeContext } from '../../src/main/agent/runtime-entry';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';
import { __setSandboxStateForTest } from '../../src/main/sandbox/probe';
import { __setSandboxSettingsForTest } from '../../src/main/sandbox/settings';

let tmpDir: string;
let ctx: RuntimeContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pretool-'));
  process.env.AP_USER_DATA_DIR = tmpDir; // 隔离 DB（journal 账本会开库——不可碰真实库）
  __setSandboxStateForTest({ available: true, tool: 'none' } as never);
  __setSandboxSettingsForTest({ mode: 'permissive', networkPolicy: 'deny' });
  const toolCtxBase = {
    wsFs: new WorkspaceFS(tmpDir),
    workspaceId: 'ws1',
    workspaceDir: tmpDir,
    skillRegistry: {} as RuntimeContext['skillRegistry'],
    streamSessionId: 's',
    roomId: 'r',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: '',
  };
  ctx = {
    ...toolCtxBase,
    toolModules: buildToolRegistry(toolCtxBase),
  } as unknown as RuntimeContext;
});

afterEach(() => {
  __setPreToolUseHookForTest(null);
  __setSandboxStateForTest({ available: true, tool: 'none' } as never);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function config(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    agentAssignmentId: 'i',
    agentUserId: 'u',
    systemPrompt: 's',
    modelName: 'm',
    llmApiKey: 'k',
    workspaceDir: tmpDir,
    workspaceId: 'ws1',
    role: 'standalone',
    subAgents: [],
    skills: [],
    mcpNames: [],
    allowedTools: [],
    deniedTools: [],
    pluginHooks: true,
    ...over,
  } as RuntimeConfig;
}

describe('doExecuteTool preToolUse 拦截', () => {
  it('hook 返回 deny → 抛中文错误且工具不执行', async () => {
    __setPreHookForTest(async () => ({ action: 'deny', reason: '保护分支' }));
    await expect(
      doExecuteTool({ id: 'c1', name: 'exists', arguments: { path: 'a.txt' } }, ctx, config()),
    ).rejects.toThrow(/插件钩子拒绝.*保护分支/);
    expect(fs.existsSync(path.join(tmpDir, 'a.txt'))).toBe(false);
  });

  it('hook 返回 rewrite → 工具收到改写后 args（写文件到改写路径）', async () => {
    __setPreHookForTest(async () => ({ action: 'rewrite', args: { path: 'rewritten.txt', content: 'hi' } }));
    const out = await doExecuteTool(
      { id: 'c1', name: 'write_file', arguments: { path: 'original.txt', content: 'hi' } },
      ctx,
      config(),
    );
    expect(out).toContain('rewritten.txt');
    expect(fs.existsSync(path.join(tmpDir, 'rewritten.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'original.txt'))).toBe(false);
  });

  it('hook 返回 null → 直通（既有行为不变）', async () => {
    __setPreHookForTest(async () => null);
    const out = await doExecuteTool(
      { id: 'c1', name: 'exists', arguments: { path: 'a.txt' } },
      ctx,
      config(),
    );
    expect(out).toContain('不存在');
  });

  it('hook deny 先于内置权限闸（deny 文案区别于 deniedTools 文案）', async () => {
    __setPreHookForTest(async () => ({ action: 'deny', reason: 'xx' }));
    await expect(
      doExecuteTool(
        { id: 'c1', name: 'exists', arguments: {} },
        ctx,
        config({ deniedTools: ['exists'] }),
      ),
    ).rejects.toThrow(/插件钩子拒绝/);
  });
});

/** 测试注入 helper——避免测试文件直接触到模块内部变量 */
function __setPreHookForTest(fn: (() => Promise<{ action: string; reason?: string; args?: Record<string, unknown> } | null>) | null): void {
  __setPreToolUseHookForTest(fn as never);
}

describe('I1：effectiveArgs 终值透传', () => {
  it('rewrite 后 decisionSink.effectiveArgs 为改写值（审计与 postToolUse 的取值源）', async () => {
    __setPreHookForTest(async () => ({ action: 'rewrite', args: { path: 'b.txt', content: 'x' } }));
    const sink: { decision: unknown; effectiveArgs: Record<string, unknown> | null } = {
      decision: null,
      effectiveArgs: null,
    };
    await doExecuteTool(
      { id: 'c1', name: 'write_file', arguments: { path: 'a.txt', content: 'x' } },
      ctx,
      config(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sink as never,
    );
    expect(sink.effectiveArgs).toEqual({ path: 'b.txt', content: 'x' });
  });

  it('无 rewrite 时 effectiveArgs 保持 null（审计回退原始 args）', async () => {
    __setPreHookForTest(async () => null);
    const sink: { decision: unknown; effectiveArgs: Record<string, unknown> | null } = {
      decision: null,
      effectiveArgs: null,
    };
    await doExecuteTool(
      { id: 'c1', name: 'exists', arguments: { path: 'z.txt' } },
      ctx,
      config(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sink as never,
    );
    expect(sink.effectiveArgs).toBeNull();
  });
});
