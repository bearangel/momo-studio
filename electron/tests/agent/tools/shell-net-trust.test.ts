// electron/tests/agent/tools/shell-net-trust.test.ts
//
// bash 工具网络信任门钩子测试（spec 2026-09-13 §5，方案 A 阻塞式）：
//   - spawn 前经 IPC 桥问主进程有效策略（requestEffectiveNetwork），并按结果
//     驱动 profile（ask → net-off spawn；granted/allow → net-on spawn）
//   - 触发条件矩阵：awaitingAsk + wrapped net-off tag → 走阻塞等待；allow /
//     无 awaitingAsk → 不触发等待；桥 effective 故障 → 回退设置三态推导
//   - 结果追加提示断言：granted 在失败结果尾部追加「已获批准可重试」；
//     denied / not-triggered 原样返回；wait 桥故障原样返回（不挂死）
// 确定性策略：vi.mock net-trust-bridge（业务边界外的 IPC 桥）+ vi.mock
// node:child_process 的 spawn（进程边界——容器无 bwrap 时也能锁 wrapped 分支）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

const { effectiveMock, waitMock, spawnMock } = vi.hoisted(() => ({
  effectiveMock: vi.fn(),
  waitMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('../../../src/main/agent/tools/net-trust-bridge', () => ({
  requestEffectiveNetwork: effectiveMock,
  requestNetworkTrustWait: waitMock,
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
  waitMock.mockReset();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => mkFakeChild());
  // bwrap 可用 + strict + ask：resolveShellSpawn 走 wrapped 分支（net-off）
  __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'ask' });
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

describe('bash 网络信任门：spawn 前有效策略（spec §5 effective 接线）', () => {
  it('effective 桥以 ctx.streamSessionId 查询（跨模块 ID 单点透传）', async () => {
    effectiveMock.mockResolvedValue({ netOn: false, awaitingAsk: false });
    const tools = new ShellTools();
    const p = tools.execute('bash', { command: 'echo hi' }, ctx);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    expect(effectiveMock).toHaveBeenCalledWith('ssn-net-1');
    (spawnMock.mock.results[0]!.value as ReturnType<typeof mkFakeChild>).emitClose(0);
    await p;
  });

  it('awaitingAsk=false（如 grant 已在场）→ spawn net-on + 不走等待', async () => {
    effectiveMock.mockResolvedValue({ netOn: true, awaitingAsk: false });
    const result = await runBashToCompletion();
    expect(lastSpawnArgs()).not.toContain('--unshare-net');
    expect(result).toContain('sandbox: bwrap/net-on');
    expect(waitMock).not.toHaveBeenCalled();
  });

  it('effective 桥故障（非 fork 环境 / 超时）→ 回退设置三态推导（ask → net-off）+ 主路径不挂死', async () => {
    effectiveMock.mockRejectedValue(new Error('process.send 缺失'));
    const result = await runBashToCompletion();
    expect(lastSpawnArgs()).toContain('--unshare-net');
    expect(result).toContain('sandbox: bwrap/net-off');
    expect(result).toContain('Could not resolve host');
    expect(waitMock).not.toHaveBeenCalled();
  });
});

describe('bash 网络信任门：命令完成阻塞询问（spec §5 触发条件 + 结果追加提示）', () => {
  it('ask 无 grant + net-off + 签名 → 走等待；granted → 结果尾追加批准提示（不自动重跑）', async () => {
    effectiveMock.mockResolvedValue({ netOn: false, awaitingAsk: true });
    waitMock.mockResolvedValue('granted');
    const result = await runBashToCompletion();
    expect(lastSpawnArgs()).toContain('--unshare-net');
    expect(waitMock).toHaveBeenCalledTimes(1);
    const waited = waitMock.mock.calls[0]!;
    expect(waited[0]).toBe('ssn-net-1');
    expect(waited[1]).toContain('sandbox: bwrap/net-off');
    expect(waited[1]).toContain('Could not resolve host');
    expect(result).toContain('沙箱网络已获用户批准');
    expect(result).toContain('可重试');
    // 失败事实保留（不吞错误输出——LLM 可见原始 stderr 自行重试）
    expect(result).toContain('Could not resolve host');
  });

  it('denied → 失败结果原样返回（无批准提示；LLM 自诊）', async () => {
    effectiveMock.mockResolvedValue({ netOn: false, awaitingAsk: true });
    waitMock.mockResolvedValue('denied');
    const result = await runBashToCompletion();
    expect(waitMock).toHaveBeenCalledTimes(1);
    expect(result).not.toContain('沙箱网络已获用户批准');
    expect(result).toContain('Could not resolve host');
  });

  it('not-triggered（主进程复判未命中，如输出无签名）→ 原样返回', async () => {
    effectiveMock.mockResolvedValue({ netOn: false, awaitingAsk: true });
    waitMock.mockResolvedValue('not-triggered');
    const result = await runBashToCompletion();
    expect(result).not.toContain('沙箱网络已获用户批准');
  });

  it('wait 桥故障 → 原样返回（信任门故障不挂死命令结果）', async () => {
    effectiveMock.mockResolvedValue({ netOn: false, awaitingAsk: true });
    waitMock.mockRejectedValue(new Error('IPC 无响应'));
    const result = await runBashToCompletion();
    expect(result).toContain('Could not resolve host');
    expect(result).not.toContain('沙箱网络已获用户批准');
  });

  it('ask 无 grant 但 spawn 为 net-on（策略翻转竞态）→ 不走等待', async () => {
    effectiveMock.mockResolvedValue({ netOn: true, awaitingAsk: true });
    const result = await runBashToCompletion();
    expect(result).toContain('sandbox: bwrap/net-on');
    expect(waitMock).not.toHaveBeenCalled();
  });
});

describe('bash 网络信任门：非 wrapped 路径不触发（触发条件矩阵）', () => {
  it('permissive 降级 plain（unsandboxed tag）→ 即使 awaitingAsk 也不等待', async () => {
    __setSandboxSettingsForTest({ mode: 'permissive', networkPolicy: 'ask' });
    __setSandboxStateForTest({
      platform: 'linux', sandboxTool: null, toolVersion: null,
      available: false, unavailableReason: 'bwrap 未安装', windowsShell: null, executionPolicy: null, probedAt: 0,
    });
    effectiveMock.mockResolvedValue({ netOn: false, awaitingAsk: true });
    const result = await runBashToCompletion();
    expect(result).toContain('sandbox: unsandboxed:');
    expect(waitMock).not.toHaveBeenCalled();
  });
});
