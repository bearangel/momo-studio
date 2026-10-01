// electron/tests/lsp/ipc.test.ts
// 路由契约：envelope 校验 / 扩展名路由 / reqId 回带 / 错误路径 ok:false /
// path 越界拒绝 / lsp:status·redetect invoke。
// mock 边界：manager（ensureLspManager / fileUriToPath）、workspace/crud
// （getWorkspace）、detect（面板 invoke 数据源）全部桩化——本文件只锁
// 路由协议形状，不触真实 server / DB。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';
import { routeLspOp, registerLspPanelIpc } from '../../src/main/lsp/ipc';
import * as manager from '../../src/main/lsp/manager';
import * as detect from '../../src/main/lsp/detect';
import * as workspaceCrud from '../../src/main/workspace/crud';

// 仓库标准 vi.mock('electron') 模式：捕获 ipcMain.handle 注册表
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../src/main/lsp/manager', () => ({
  ensureLspManager: vi.fn(),
  getLspRunState: vi.fn(() => 'stopped'),
  // ipc.ts 从 manager 域复用该 helper——mock 保持与真实实现同语义（3 行同体）
  fileUriToPath: (uri: string) =>
    uri.startsWith('file://') ? decodeURIComponent(uri.slice('file://'.length)) : uri,
}));
vi.mock('../../src/main/lsp/detect', () => ({
  detectWorkspaceLanguages: vi.fn(() => [{ languageId: 'typescript' }]),
  redetectWorkspaceLanguages: vi.fn(() => [{ languageId: 'go' }]),
}));
vi.mock('../../src/main/workspace/crud', () => ({
  getWorkspace: vi.fn(() => ({ directoryPath: '/tmp/ws-x' })),
}));

function fakeChild(): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('routeLspOp', () => {
  it('合法 diagnostics op：扩展名路由 typescript，结果格式化回发', async () => {
    const child = fakeChild();
    vi.mocked(manager.ensureLspManager).mockResolvedValue({
      getDiagnostics: vi.fn().mockResolvedValue([
        { severity: 1, message: '类型错误', range: { start: { line: 0, character: 6 } } },
      ]),
      findReferences: vi.fn(),
    } as unknown as manager.LspManager);
    await routeLspOp(child, {
      type: 'lsp:op', requestId: 'r1',
      op: { kind: 'diagnostics', workspaceId: 'ws-x', path: 'src/a.ts', content: 'const x: number = "s";' },
    });
    const reply = child.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(reply.type).toBe('lsp:op-result');
    expect(reply.requestId).toBe('r1');
    expect(reply.ok).toBe(true);
    expect(String(reply.result)).toContain('类型错误');
    // ensureLspManager(workspaceId, workspaceDir, spec)——目录主进程自查、语言在 spec.languageId（第 3 参）
    expect(vi.mocked(manager.ensureLspManager).mock.calls[0]![0]).toBe('ws-x');
    expect(vi.mocked(manager.ensureLspManager).mock.calls[0]![1]).toBe('/tmp/ws-x');
    expect(vi.mocked(manager.ensureLspManager).mock.calls[0]![2].languageId).toBe('typescript');
    // 传给 manager 的 absPath 已按 workspace 目录 resolve
    const mgr = vi.mocked(manager.ensureLspManager).mock.results[0]!.value as unknown as {
      getDiagnostics: ReturnType<typeof vi.fn>;
    };
    expect(mgr.getDiagnostics).toHaveBeenCalledWith('/tmp/ws-x/src/a.ts', 'const x: number = "s";');
  });

  it('合法 references op：1-based 行转 0-based，结果相对路径格式化回发', async () => {
    const child = fakeChild();
    vi.mocked(manager.ensureLspManager).mockResolvedValue({
      getDiagnostics: vi.fn(),
      findReferences: vi.fn().mockResolvedValue([
        { uri: 'file:///tmp/ws-x/src/a.ts', range: { start: { line: 3, character: 7 } } },
      ]),
    } as unknown as manager.LspManager);
    await routeLspOp(child, {
      type: 'lsp:op', requestId: 'r5',
      op: { kind: 'references', workspaceId: 'ws-x', path: 'src/a.ts', line: 4, character: 8 },
    });
    const reply = child.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(reply.requestId).toBe('r5');
    expect(reply.ok).toBe(true);
    // 0-based (3,7) → 展示 1-based 4:8；URI → 相对 workspace 路径
    expect(String(reply.result)).toContain('src/a.ts:4:8');
    const mgr = vi.mocked(manager.ensureLspManager).mock.results[0]!.value as unknown as {
      findReferences: ReturnType<typeof vi.fn>;
    };
    expect(mgr.findReferences).toHaveBeenCalledWith('/tmp/ws-x/src/a.ts', 3, 8);
  });

  it('未知扩展名 → ok:false 中文错误', async () => {
    const child = fakeChild();
    await routeLspOp(child, {
      type: 'lsp:op', requestId: 'r2',
      op: { kind: 'diagnostics', workspaceId: 'ws-x', path: 'doc.pdf', content: '' },
    });
    const reply = child.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toMatch(/不支持的语言|无法识别/);
  });

  it('manager 抛错 → ok:false 错误文案透传', async () => {
    const child = fakeChild();
    vi.mocked(manager.ensureLspManager).mockRejectedValue(new Error('语言服务 Go 未安装——go install ...'));
    await routeLspOp(child, {
      type: 'lsp:op', requestId: 'r3',
      op: { kind: 'references', workspaceId: 'ws-x', path: 'main.go', line: 1, character: 0 },
    });
    const reply = child.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toContain('未安装');
  });

  it('非法 envelope（缺 requestId / 未知 kind / op 为 null / 字段类型错）静默忽略不崩', async () => {
    const child = fakeChild();
    await routeLspOp(child, { type: 'lsp:op' });
    await routeLspOp(child, { type: 'lsp:op', requestId: 'r4', op: { kind: 'zzz' } });
    await routeLspOp(child, { type: 'lsp:op', requestId: 'r4b', op: null });
    await routeLspOp(child, {
      type: 'lsp:op', requestId: 'r4c',
      // workspaceId 非字符串：envelope 无效应静默丢弃（无法构造有意义的回执路由）
      op: { kind: 'diagnostics', workspaceId: 42, path: 'a.ts' },
    });
    expect(child.send).not.toHaveBeenCalled();
    expect(vi.mocked(manager.ensureLspManager)).not.toHaveBeenCalled();
  });

  it('path 越界（../ 逃逸 / 同级目录名前缀）→ ok:false 且不触 manager', async () => {
    const child = fakeChild();
    await routeLspOp(child, {
      type: 'lsp:op', requestId: 'r6',
      op: { kind: 'diagnostics', workspaceId: 'ws-x', path: '../../etc/evil.ts', content: '' },
    });
    let reply = child.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toMatch(/越界/);
    // 同级目录前缀攻击：/tmp/ws-x-evil 不在 /tmp/ws-x/ 内——不得因字符串
    // 前缀恰好匹配 directoryPath 而误过（必须拼 path.sep 再比较）
    await routeLspOp(child, {
      type: 'lsp:op', requestId: 'r7',
      op: { kind: 'diagnostics', workspaceId: 'ws-x', path: '/tmp/ws-x-evil/a.ts', content: '' },
    });
    reply = child.send.mock.calls[1]![0] as Record<string, unknown>;
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toMatch(/越界/);
    expect(vi.mocked(manager.ensureLspManager)).not.toHaveBeenCalled();
  });

  it('workspace 不存在 → ok:false 中文错误', async () => {
    const child = fakeChild();
    vi.mocked(workspaceCrud.getWorkspace).mockReturnValueOnce(null);
    await routeLspOp(child, {
      type: 'lsp:op', requestId: 'r8',
      op: { kind: 'diagnostics', workspaceId: 'ws-gone', path: 'src/a.ts', content: '' },
    });
    const reply = child.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toMatch(/工作区/);
  });
});

describe('registerLspPanelIpc', () => {
  it('注册 lsp:status / lsp:redetect；handler 以 workspaceId 自查目录调 detect', () => {
    registerLspPanelIpc();
    const handle = vi.mocked(ipcMain.handle);
    const channels = handle.mock.calls.map((c) => c[0]);
    expect(channels).toContain('lsp:status');
    expect(channels).toContain('lsp:redetect');

    const statusHandler = handle.mock.calls.find((c) => c[0] === 'lsp:status')![1] as unknown as (
      event: unknown,
      workspaceId: string,
    ) => unknown;
    expect(statusHandler(undefined, 'ws-x')).toEqual([{ languageId: 'typescript' }]);
    // 目录必须来自主进程自查（getWorkspace），不是 renderer 传入
    expect(detect.detectWorkspaceLanguages).toHaveBeenCalledWith('ws-x', '/tmp/ws-x');

    const redetectHandler = handle.mock.calls.find((c) => c[0] === 'lsp:redetect')![1] as unknown as (
      event: unknown,
      workspaceId: string,
    ) => unknown;
    expect(redetectHandler(undefined, 'ws-x')).toEqual([{ languageId: 'go' }]);
    expect(detect.redetectWorkspaceLanguages).toHaveBeenCalledWith('ws-x', '/tmp/ws-x');
  });

  it('workspace 不存在 → handler 抛中文错误（renderer 收到 rejection）', () => {
    registerLspPanelIpc();
    vi.mocked(workspaceCrud.getWorkspace).mockReturnValueOnce(null);
    const handle = vi.mocked(ipcMain.handle);
    const statusHandler = handle.mock.calls.find((c) => c[0] === 'lsp:status')![1] as unknown as (
      event: unknown,
      workspaceId: string,
    ) => unknown;
    expect(() => statusHandler(undefined, 'ws-gone')).toThrow(/工作区/);
  });
});
