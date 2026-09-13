// electron/tests/agent/tools/shell-net-trust.test.ts
//
// bash 工具网络策略查询接线测试（2026-09-13 修订 B 双态化）：
//   - spawn 前经 IPC 桥问主进程有效网络态（requestEffectiveNetwork），并按
//     结果驱动 profile（netOn=false → net-off spawn；netOn=true → net-on spawn）
//   - 查询桥故障（非 fork 环境 / 超时）→ 回退设置双态推导（deny → net-off）
//   - bash 结果原样返回（ask 时代的阻塞询问/批准提示追加已下线——网络失败
//     文本不经任何改写透传给 LLM）
// 确定性策略：vi.mock net-trust-bridge（业务边界外的 IPC 桥）+ vi.mock
// node:child_process 的 spawn（进程边界——容器无 bwrap 时也能锁 wrapped 分支）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

const { effectiveMock, spawnMock } = vi.hoisted(() => ({
  effectiveMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('../../../src/main/agent/tools/net-trust-bridge', () => ({
  requestEffectiveNetwork: effectiveMock,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { ShellTools } from '../../../src/main/agent/tools/shell-tools';
import { __setSandboxStateForTest } from '../../../src/main/sandbox/probe';
import { __setSandboxSettingsForTest } from '../../../src/main/sandbox/settings';
import type { ToolContext } from '../../../src/main/agent/tools/types';

/** 构造 fake 子进程：capture spawn 后由测试驱动 close（带 stderr 网络 failure 签名） */
function mkFakeChild(): ChildProcess & { emitClose: (code: number) => void } {
  const child = new EventEmitter() as unknown as ChildProcess & { emitClose: (code: number) => void };
  const stdout = new EventEmitter() as EventEmitter & { on?: unknown };
  const stderr = new EventEmitter() as EventEmitter & { on?: unknown };
  Object.assign(child, {
    pid: 424242,
    stdout,
    stderr,
    kill: vi.fn(),
  });
  child.emitClose = (code: number) => {
    stderr.emit('data', Buffer.from('curl: (6) Could not resolve host: example.com'));
    child.emit('close', code);
  };
  return child;
}

function lastSpawnArgs(): string[] {
  const call = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
  return (call?.[1] ?? []) as string[];
}

let tmpDir: string;
let ctx: ToolContext;

beforeEach(() => {
  effectiveMock.mockReset();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => mkFakeChild());
  // bwrap 可用 + strict + deny：resolveShellSpawn 走 wrapped 分支（net-off）
  __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'deny' });
  __setSandboxStateForTest({
    platform: 'linux', sandboxTool: 'bwrap', toolVersion: 'bubblewrap 0.10',
    available: true, unavailableReason: null, windowsShell: null, executionPolicy: null, probedAt: 0,
  });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-shell-net-trust-'));
  ctx = {
    wsFs: {} as ToolContext['wsFs'],
    workspaceId: 'ws',
    workspaceDir: tmpDir,
    skillRegistry: {} as ToolContext['skillRegistry'],
    streamSessionId: 'ssn-net-1',
    roomId: 'r',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: '',
  };
});

afterEach(() => {
  __setSandboxSettingsForTest(null);
  __setSandboxStateForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 执行 bash 并驱动 fake 子进程收尾（close code 1 + 网络失败签名 stderr） */
async function runBashToCompletion(): Promise<string> {
  const tools = new ShellTools();
  const p = tools.execute('bash', { command: 'curl https://example.com' }, ctx);
  // execute 内部先 await effective 桥（微任务两跳）再 spawn
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
  const child = spawnMock.mock.results[0]!.value as ReturnType<typeof mkFakeChild>;
  child.emitClose(1);
  return p;
}

describe('bash 网络态查询：spawn 前接线（修订 B）', () => {
  it('effective 桥以 ctx.streamSessionId 查询（跨模块 ID 单点透传）', async () => {
    effectiveMock.mockResolvedValue({ netOn: false });
    const tools = new ShellTools();
    const p = tools.execute('bash', { command: 'echo hi' }, ctx);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    expect(effectiveMock).toHaveBeenCalledWith('ssn-net-1');
    (spawnMock.mock.results[0]!.value as ReturnType<typeof mkFakeChild>).emitClose(0);
    await p;
  });

  it('netOn=true → spawn net-on（无 --unshare-net）+ 结果 tag net-on', async () => {
    effectiveMock.mockResolvedValue({ netOn: true });
    const result = await runBashToCompletion();
    expect(lastSpawnArgs()).not.toContain('--unshare-net');
    expect(result).toContain('sandbox: bwrap/net-on');
  });

  it('netOn=false → spawn net-off + 失败结果原样返回（含原始 stderr，无任何追加提示）', async () => {
    effectiveMock.mockResolvedValue({ netOn: false });
    const result = await runBashToCompletion();
    expect(lastSpawnArgs()).toContain('--unshare-net');
    expect(result).toContain('sandbox: bwrap/net-off');
    expect(result).toContain('Could not resolve host');
    // 修订 B：ask 时代的「已获批准可重试」追加提示已下线——结果不再有任何后缀
    expect(result).not.toContain('沙箱网络已获用户批准');
    expect(result.endsWith('Could not resolve host: example.com')).toBe(true);
  });

  it('effective 桥故障（非 fork 环境 / 超时）→ 回退设置双态推导（deny → net-off）+ 主路径不挂死', async () => {
    effectiveMock.mockRejectedValue(new Error('process.send 缺失'));
    const result = await runBashToCompletion();
    expect(lastSpawnArgs()).toContain('--unshare-net');
    expect(result).toContain('sandbox: bwrap/net-off');
    expect(result).toContain('Could not resolve host');
  });

  it('effective 桥故障但设置 allow → 回退推导 net-on（回退读设置非硬编码）', async () => {
    __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'allow' });
    effectiveMock.mockRejectedValue(new Error('IPC 无响应'));
    const result = await runBashToCompletion();
    expect(lastSpawnArgs()).not.toContain('--unshare-net');
    expect(result).toContain('sandbox: bwrap/net-on');
  });
});
