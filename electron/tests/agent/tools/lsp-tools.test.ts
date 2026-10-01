// electron/tests/agent/tools/lsp-tools.test.ts
// 薄客户端契约（Task 5 重写）：门控（快照空 → create null / 非空 → 实例）；
// 非 fork 环境 execute 立即 reject（process.send 缺失——browser-ipc-bridge 同款铁律）；
// 缺省兼容（AGENT_CONFIG 无 lspLanguages）。
// 旧真实 typescript-language-server 用例已由 tests/lsp/manager.test.ts 冒烟承接。
import { describe, it, expect, vi } from 'vitest';
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
