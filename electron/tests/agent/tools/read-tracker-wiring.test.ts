// electron/tests/agent/tools/read-tracker-wiring.test.ts
// v2.3 Read-before-Edit 生产接线回归锁（终审 C1）。
//
// 背景：runtime-entry 的 doExecuteTool 内联组装 toolCtx 时漏注入 readTracker，
//   file-tools 的可选链（ctx.readTracker?.）静默失效 → 守门在生产 no-op。
//   单测全部直接 new FileTools() + 手工注入 tracker，从未覆盖生产组装路径，故长期未暴露。
//
// 本测试对生产路由入口 doExecuteTool 断言（ctx 组装是内联代码，doExecuteTool 是
//   最小可达 seam；沿用 runtime-entry-routing.test.ts 的直接 import 模式）：
//   真实 buildToolRegistry + 真实 WorkspaceFS + 真实临时 workspace，不 mock 任何工具。
//   若有人删掉 toolCtx 的 readTracker 字段 → 可选链失效 → 未读 edit_file 直接成功
//   → 下述「未读被拒」用例变红。守门真实生效（而非一律拒绝）由「read 后通过」用例锁定。

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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-v23-wiring-'));
  const wsFs = new WorkspaceFS(tmpDir);
  // runtime-entry 模块级 readTracker 是跨测试共享的单例——streamSessionId 每测唯一，
  // 隔离 tracker 状态（真实生产语义：一任务一进程一 session）
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
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('ReadTracker 生产接线回归锁（doExecuteTool ctx 组装，终审 C1）', () => {
  it('未 read_file 直接 edit_file：经生产路由被守门拒绝（删 readTracker 字段本用例变红）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const x = 1;');
    await expect(
      doExecuteTool(call('edit_file', { path: 'a.ts', oldString: 'const x = 1;', newString: 'const x = 2;' }), ctx, makeConfig()),
    ).rejects.toThrow(/未读取/);
    // 原文件未被改动
    expect(fs.readFileSync(path.join(tmpDir, 'a.ts'), 'utf-8')).toBe('const x = 1;');
  });

  it('read_file 后 edit_file 成功：守门真实判定而非一律拒绝', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const x = 1;');
    await doExecuteTool(call('read_file', { path: 'a.ts' }), ctx, makeConfig());
    const out = await doExecuteTool(
      call('edit_file', { path: 'a.ts', oldString: 'const x = 1;', newString: 'const x = 2;' }),
      ctx,
      makeConfig(),
    );
    expect(out).toContain('已编辑');
    expect(fs.readFileSync(path.join(tmpDir, 'a.ts'), 'utf-8')).toBe('const x = 2;');
  });

  it('write_file 覆盖场景同样被守门：未读抛错，read 后通过', async () => {
    fs.writeFileSync(path.join(tmpDir, 'existing.ts'), 'old');
    await expect(
      doExecuteTool(call('write_file', { path: 'existing.ts', content: 'new' }), ctx, makeConfig()),
    ).rejects.toThrow(/未读取/);
    await doExecuteTool(call('read_file', { path: 'existing.ts' }), ctx, makeConfig());
    await expect(
      doExecuteTool(call('write_file', { path: 'existing.ts', content: 'new' }), ctx, makeConfig()),
    ).resolves.toContain('已写入');
  });

  it('abs path 键归一（review M4）：read_file("./a.ts") 标记后 edit_file("a.ts") 守门通过', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const x = 1;');
    await doExecuteTool(call('read_file', { path: './a.ts' }), ctx, makeConfig());
    await expect(
      doExecuteTool(call('edit_file', { path: 'a.ts', oldString: 'const x = 1;', newString: 'const x = 2;' }), ctx, makeConfig()),
    ).resolves.toContain('已编辑');
  });
});
