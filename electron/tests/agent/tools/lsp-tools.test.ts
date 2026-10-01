// electron/tests/agent/tools/lsp-tools.test.ts
// 薄客户端契约（Task 5 重写）：门控（快照空 → create null / 非空 → 实例）；
// 非 fork 环境 execute 立即 reject（process.send 缺失——browser-ipc-bridge 同款铁律）；
// 缺省兼容（AGENT_CONFIG 无 lspLanguages）。
// 旧真实 typescript-language-server 用例已由 tests/lsp/manager.test.ts 冒烟承接。
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LspTools } from '../../../src/main/agent/tools/lsp-tools';
import {
  handleLspOpResult,
  __testRegisterPending,
  LSP_OP_BRIDGE_TIMEOUT_MS,
} from '../../../src/main/agent/tools/lsp-ipc-bridge';
import type { ToolContext } from '../../../src/main/agent/tools/types';

function ctxWith(lspLanguages?: string[]): ToolContext {
  return {
    workspaceId: 'ws-t', workspaceDir: '/tmp/ws-t',
    wsFs: { assertInWorkspace: (p: string) => `/tmp/ws-t/${p}` } as ToolContext['wsFs'],
    skillRegistry: {} as ToolContext['skillRegistry'],
    streamSessionId: 's', roomId: 'r', sendStreamChunk: () => {},
    permissionConfig: { allowedTools: [], deniedTools: [] }, creatorUserId: 'u',
    ...(lspLanguages !== undefined ? { lspLanguages } : {}),
  } as ToolContext;
}

describe('LspTools.create 门控', () => {
  it('快照非空 → 实例；空数组 / 缺省 → null（缺省兼容铁律）', () => {
    expect(LspTools.create(ctxWith(['typescript']))).not.toBeNull();
    expect(LspTools.create(ctxWith([]))).toBeNull();
    expect(LspTools.create(ctxWith(undefined))).toBeNull();
  });
});

describe('execute 非 fork 环境', () => {
  it('process.send 缺失 → 立即 reject 中文文案（不挂等超时；references 路径不读文件，直达 sendLspOp）', async () => {
    const tools = LspTools.create(ctxWith(['typescript']))!;
    await expect(
      tools.execute('lsp_find_references', { path: 'a.ts', line: 1, character: 0 }, ctxWith(['typescript'])),
    ).rejects.toThrow(/LSP IPC 不可用/);
  });
});

describe('execute path 参数与文件存在性校验（F2 回归锁）', () => {
  it('path 缺失 / 非字符串 / 空串 → 中文「参数缺失」文案（空串不得经 assertInWorkspace 解析成根目录后 EISDIR）', async () => {
    const tools = LspTools.create(ctxWith(['typescript']))!;
    const ctx = ctxWith(['typescript']);
    await expect(tools.execute('lsp_diagnostics', {}, ctx)).rejects.toThrow('参数 "path" 缺失');
    await expect(tools.execute('lsp_diagnostics', { path: '' }, ctx)).rejects.toThrow('参数 "path" 缺失');
    await expect(tools.execute('lsp_find_references', {}, ctx)).rejects.toThrow('参数 "path" 缺失');
    await expect(tools.execute('lsp_find_references', { path: 42 }, ctx)).rejects.toThrow('参数 "path" 缺失');
  });

  it('path 指向不存在的文件 → 中文「文件不存在」相对路径文案（不泄露 ENOENT 裸文案与绝对路径）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-lsp-tools-enoent-'));
    const ctx = {
      ...ctxWith(['typescript']),
      // 真 tmp 目录基座：readFile 走真实 fs（ENOENT 路径可控）
      wsFs: { assertInWorkspace: (p: string) => path.join(root, p) } as ToolContext['wsFs'],
    } as ToolContext;
    const tools = LspTools.create(ctxWith(['typescript']))!;
    try {
      const err = await tools.execute('lsp_diagnostics', { path: 'missing.ts' }, ctx).then(
        () => null,
        (e: unknown) => e as Error,
      );
      // 精确匹配：既无 ENOENT 英文裸文案，也无绝对路径泄露
      expect(err?.message).toBe('文件不存在: missing.ts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('handleLspOpResult', () => {
  it('requestId 匹配 resolve；未知 ID 静默忽略', async () => {
    // 经 execute 发不出（无 process.send）——直接测 result 分发的 pending 语义：
    // 构造一个在途请求（经内部导出的测试钩子注册），再喂 result。
    // 钩子必须静态 import：动态 import 会得到另一个模块实例（pending 表分裂，
    // requestId 永不命中——实测踩坑记录）
    const reg = vi.fn();
    const id = await __testRegisterPending(reg, (e: Error) => void e);
    handleLspOpResult({ type: 'lsp:op-result', requestId: id, ok: true, result: '✓ ok' });
    await new Promise((r) => setTimeout(r, 10));
    expect(reg).toHaveBeenCalledWith('✓ ok');
    handleLspOpResult({ type: 'lsp:op-result', requestId: 'unknown-id', ok: true, result: 'x' }); // 不崩
  });
});

describe('桥超时常量', () => {
  it('LSP_OP_BRIDGE_TIMEOUT_MS ≥ 120s（冷启动 30s+ 不得被误杀——Review Focus 3）', () => {
    expect(LSP_OP_BRIDGE_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });
});
