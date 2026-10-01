// electron/tests/lsp/ipc.test.ts
// 路由契约：envelope 校验 / 扩展名路由 / reqId 回带 / 错误路径 ok:false /
// path 越界拒绝 / lsp:status·redetect invoke。
// mock 边界：manager（ensureLspManager / fileUriToPath）、workspace/crud
// （getWorkspace）、detect（面板 invoke 数据源）全部桩化——本文件只锁
// 路由协议形状，不触真实 server / DB。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ipcMain } from 'electron';
import { routeLspOp, registerLspPanelIpc } from '../../src/main/lsp/ipc';
import { OUTPUT_LIMITS } from '../../src/main/agent/tools/shared/output-truncate';
import * as manager from '../../src/main/lsp/manager';
import * as detect from '../../src/main/lsp/detect';
import * as workspaceCrud from '../../src/main/workspace/crud';
import type { Workspace } from '../../src/main/workspace/types';

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

/** 完整 Workspace 形状基座（getWorkspace 类型收窄——仅 directoryPath 参与路由） */
const baseWorkspace: Workspace = {
  id: 'ws-x',
  name: 'ws-x',
  description: '',
  directoryPath: '/tmp/ws-x',
  gitInitialized: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  ownerId: 'u1',
  iconEmoji: '',
  defaultAgentInstanceId: null,
};

beforeEach(() => { vi.clearAllMocks(); });

describe('routeLspOp', () => {
  it('合法 diagnostics op：扩展名路由 typescript，结果格式化回发（code 透传 + severity 4 hint 单独映射）', async () => {
    const child = fakeChild();
    vi.mocked(manager.ensureLspManager).mockResolvedValue({
      getDiagnostics: vi.fn().mockResolvedValue([
        { severity: 1, code: 'TS2322', message: '类型错误', range: { start: { line: 0, character: 6 } } },
        { severity: 4, message: '提示', range: { start: { line: 1, character: 0 } } },
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
    const result = String(reply.result);
    // 格式保真：severity 后附 ` <code>`（有 code 时）；hint 不折叠为 info
    expect(result).toContain('类型错误');
    expect(result).toContain('error TS2322: 类型错误');
    expect(result).toContain('hint: 提示');
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

  it('OUTPUT_LIMITS 裁定契约锁：lsp_diagnostics=100 / lsp_references=64', () => {
    // 数值来自 Task 7 控制器裁定（与 50/50 历史先例不同）——改动此处须有新裁定
    expect(OUTPUT_LIMITS.lsp_diagnostics).toBe(100);
    expect(OUTPUT_LIMITS.lsp_references).toBe(64);
  });

  it('diagnostics 超限输出被截断：150 条 → 行数 ≤ 上限 + 截断提示（防 LLM 上下文膨胀）', async () => {
    const child = fakeChild();
    const many = Array.from({ length: 150 }, (_, i) => ({
      severity: 1,
      message: `类型错误${i}`,
      range: { start: { line: i, character: 0 } },
    }));
    vi.mocked(manager.ensureLspManager).mockResolvedValue({
      getDiagnostics: vi.fn().mockResolvedValue(many),
      findReferences: vi.fn(),
    } as unknown as manager.LspManager);
    await routeLspOp(child, {
      type: 'lsp:op', requestId: 'r-trunc1',
      op: { kind: 'diagnostics', workspaceId: 'ws-x', path: 'src/a.ts', content: '' },
    });
    const reply = child.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(reply.ok).toBe(true);
    const result = String(reply.result);
    const lines = result.split('\n');
    // 上限行 + 1 空行 + 1 提示行（truncateArray 尾部形状）
    expect(lines.length).toBeLessThanOrEqual(OUTPUT_LIMITS.lsp_diagnostics + 2);
    expect(result).toContain(`还有 ${150 - OUTPUT_LIMITS.lsp_diagnostics} 条未显示`);
    // 边界精确性：保留 [0, limit)，丢弃 [limit, …)
    expect(result).toContain(`类型错误${OUTPUT_LIMITS.lsp_diagnostics - 1}`);
    expect(result).not.toContain(`类型错误${OUTPUT_LIMITS.lsp_diagnostics}`);
  });

  it('references 超限输出被截断：150 条 → 行数 ≤ 上限 + 截断提示', async () => {
    const child = fakeChild();
    const many = Array.from({ length: 150 }, (_, i) => ({
      uri: `file:///tmp/ws-x/src/mod${i}.ts`,
      range: { start: { line: i, character: 0 } },
    }));
    vi.mocked(manager.ensureLspManager).mockResolvedValue({
      getDiagnostics: vi.fn(),
      findReferences: vi.fn().mockResolvedValue(many),
    } as unknown as manager.LspManager);
    await routeLspOp(child, {
      type: 'lsp:op', requestId: 'r-trunc2',
      op: { kind: 'references', workspaceId: 'ws-x', path: 'src/a.ts', line: 1, character: 0 },
    });
    const reply = child.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(reply.ok).toBe(true);
    const result = String(reply.result);
    expect(result.split('\n').length).toBeLessThanOrEqual(OUTPUT_LIMITS.lsp_references + 2);
    expect(result).toContain(`还有 ${150 - OUTPUT_LIMITS.lsp_references} 条未显示`);
    expect(result).toContain(`mod${OUTPUT_LIMITS.lsp_references - 1}.ts`);
    expect(result).not.toContain(`mod${OUTPUT_LIMITS.lsp_references}.ts`);
  });

  it('恰好等于上限 → 全量输出无截断提示（边界语义锁）', async () => {
    const child = fakeChild();
    const exact = Array.from({ length: OUTPUT_LIMITS.lsp_diagnostics }, (_, i) => ({
      severity: 2,
      message: `警告${i}`,
      range: { start: { line: i, character: 0 } },
    }));
    vi.mocked(manager.ensureLspManager).mockResolvedValue({
      getDiagnostics: vi.fn().mockResolvedValue(exact),
      findReferences: vi.fn(),
    } as unknown as manager.LspManager);
    await routeLspOp(child, {
      type: 'lsp:op', requestId: 'r-trunc3',
      op: { kind: 'diagnostics', workspaceId: 'ws-x', path: 'src/a.ts', content: '' },
    });
    const reply = child.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(reply.ok).toBe(true);
    const result = String(reply.result);
    expect(result.split('\n').length).toBe(OUTPUT_LIMITS.lsp_diagnostics);
    expect(result).not.toMatch(/未显示/);
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

  it('references 路径不存在（manager 内 readFile ENOENT）→ ok:false 中文「文件不存在」相对路径（F2 单点收口）', async () => {
    const child = fakeChild();
    // 仿真真实 Node fs 错误形状：Error + code=ENOENT（裸文案含英文与绝对路径）
    const enoent = Object.assign(
      new Error("ENOENT: no such file or directory, open '/tmp/ws-x/missing.go'"),
      { code: 'ENOENT' },
    );
    vi.mocked(manager.ensureLspManager).mockResolvedValue({
      getDiagnostics: vi.fn(),
      findReferences: vi.fn().mockRejectedValue(enoent),
    } as unknown as manager.LspManager);
    await routeLspOp(child, {
      type: 'lsp:op', requestId: 'r-enoent',
      op: { kind: 'references', workspaceId: 'ws-x', path: 'missing.go', line: 1, character: 0 },
    });
    const reply = child.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(reply.ok).toBe(false);
    // 精确匹配：无 ENOENT 英文裸文案、无绝对路径泄露
    expect(String(reply.error)).toBe('文件不存在: missing.go');
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

  it('workspace 内 symlink 指向外部 → ok:false 且不触 manager（realpath 锚定）', async () => {
    // 真实临时目录（fs 不 mock）：字符串边界通过（link.ts 在 ws 内），但 realpath
    // 锚定后落在 realRoot 之外——isInsideDir 纯字符串运算不含 symlink 防线，
    // 本用例锁 ipc.ts 的逐级 realpath 补层
    const child = fakeChild();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-lsp-ipc-symlink-'));
    const wsDir = path.join(root, 'ws');
    fs.mkdirSync(wsDir);
    fs.writeFileSync(path.join(root, 'outside.ts'), 'export const x = 1;');
    fs.symlinkSync(path.join(root, 'outside.ts'), path.join(wsDir, 'link.ts'));
    vi.mocked(workspaceCrud.getWorkspace).mockReturnValueOnce({
      ...baseWorkspace,
      directoryPath: wsDir,
    });
    try {
      await routeLspOp(child, {
        type: 'lsp:op', requestId: 'r9',
        op: { kind: 'diagnostics', workspaceId: 'ws-sym', path: 'link.ts', content: '' },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    const reply = child.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toMatch(/越界/);
    expect(vi.mocked(manager.ensureLspManager)).not.toHaveBeenCalled();
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
    // running 列已被 handler 覆写（缺省 mock 'stopped'）——不再是 detect 缓存值形状
    expect(statusHandler(undefined, 'ws-x')).toEqual([{ languageId: 'typescript', running: 'stopped' }]);
    // 目录必须来自主进程自查（getWorkspace），不是 renderer 传入
    expect(detect.detectWorkspaceLanguages).toHaveBeenCalledWith('ws-x', '/tmp/ws-x');

    const redetectHandler = handle.mock.calls.find((c) => c[0] === 'lsp:redetect')![1] as unknown as (
      event: unknown,
      workspaceId: string,
    ) => unknown;
    expect(redetectHandler(undefined, 'ws-x')).toEqual([{ languageId: 'go', running: 'stopped' }]);
    expect(detect.redetectWorkspaceLanguages).toHaveBeenCalledWith('ws-x', '/tmp/ws-x');
  });

  it('running 列以 getLspRunState 实时三态覆写（不冻结在 detect 缓存值）', () => {
    // F3 回归锁：detect 结果按 workspace 缓存，server 生命周期变化若只反映在
    // 缓存外，面板 running 列会滞后——handler 返回前必须以纯内存查询覆写
    vi.mocked(manager.getLspRunState).mockReturnValue('running');
    try {
      registerLspPanelIpc();
      const handle = vi.mocked(ipcMain.handle);
      const statusHandler = handle.mock.calls.find((c) => c[0] === 'lsp:status')![1] as unknown as (
        event: unknown,
        workspaceId: string,
      ) => unknown;
      expect(statusHandler(undefined, 'ws-x')).toEqual([{ languageId: 'typescript', running: 'running' }]);

      const redetectHandler = handle.mock.calls.find((c) => c[0] === 'lsp:redetect')![1] as unknown as (
        event: unknown,
        workspaceId: string,
      ) => unknown;
      expect(redetectHandler(undefined, 'ws-x')).toEqual([{ languageId: 'go', running: 'running' }]);
      // 覆写来源确系 getLspRunState（wsId + languageId 实时查询）
      expect(vi.mocked(manager.getLspRunState)).toHaveBeenCalledWith('ws-x', 'typescript');
      expect(vi.mocked(manager.getLspRunState)).toHaveBeenCalledWith('ws-x', 'go');
    } finally {
      // mockReturnValue 属实现级状态，clearAllMocks 不复位——显式还原防泄漏到后续用例
      vi.mocked(manager.getLspRunState).mockReturnValue('stopped');
    }
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
