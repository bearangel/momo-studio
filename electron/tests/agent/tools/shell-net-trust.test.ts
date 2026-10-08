// electron/tests/agent/tools/shell-net-trust.test.ts
//
// bash 工具网络策略查询接线测试（2026-09-13 修订 B 双态化）：
//   - spawn 前经 IPC 桥问主进程有效网络态（requestEffectiveNetwork），并按
//     结果驱动 profile（netOn=false → net-off spawn；netOn=true → net-on spawn）
//   - 查询桥故障（非 fork 环境 / 超时）→ 回退设置双态推导（deny → net-off）
//   - bash 结果原样返回（ask 时代的阻塞询问/批准提示追加已下线——网络失败
//     文本不经任何改写透传给 LLM）
// v2.5 工具链机制整体移除（2026-10-04）：effective payload 仅 {netOn, extraDirs}
// 两字段，toolchainOn 整字段下线——下游测试替身形状相应精简。
//
// 平台自适应（2026-10-01）：resolveShellSpawn 按真实 process.platform 分派
// wrapped 分支——本文件原只注入 linux/bwrap 状态（macOS 主机上全红：plan
// blocked，spawn 永不发生）。现按宿主平台选择注入状态：linux → bwrap
//（--unshare-net 标记网络关），darwin → seatbelt（spawn 时即时读 profile，
// (allow network*) 缺失标记网络关）——两平台同一套接线语义各自锁定。
//
// 确定性策略：vi.mock net-trust-bridge（业务边界外的 IPC 桥）+ vi.mock
// node:child_process 的 spawn（进程边界——无 bwrap/sandbox-exec 也能锁 wrapped 分支）。
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

/** 宿主平台是否 darwin（决定 wrapped 分支与断言形态——见文件头注释） */
const IS_DARWIN = process.platform === 'darwin';
/** 当前平台 wrapped 分支名（结果 sandbox tag 前缀） */
const WRAPPED = IS_DARWIN ? 'seatbelt' : 'bwrap';

/** 测试用 settings 构造器：v2.5 起 SandboxSettings 仅含 mode/networkPolicy */
function settings(mode: 'strict' | 'permissive', networkPolicy: 'deny' | 'allow') {
  return { mode, networkPolicy };
}

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

/** darwin seatbelt：spawn 时即时读 profile 内容（close 回调会 unlink 清理，事后读不到） */
let lastProfile: string | null = null;

/** 断言本次 spawn 的网络态：linux=bwrap args 的 --unshare-net；darwin=profile 的 (allow network*) */
function expectNet(expected: 'on' | 'off'): void {
  if (IS_DARWIN) {
    expect(lastProfile?.includes('(allow network*)')).toBe(expected === 'on');
  } else {
    expect(lastSpawnArgs().includes('--unshare-net')).toBe(expected === 'off');
  }
}

let tmpDir: string;
let ctx: ToolContext;

beforeEach(() => {
  effectiveMock.mockReset();
  spawnMock.mockReset();
  lastProfile = null;
  spawnMock.mockImplementation((_shell: string, args: string[]) => {
    // seatbelt spawn 形态 ['-f', profilePath, ...]：spawn 时点读 profile 留证
    if (Array.isArray(args) && args[0] === '-f' && typeof args[1] === 'string') {
      try { lastProfile = fs.readFileSync(args[1], 'utf-8'); } catch { lastProfile = null; }
    }
    return mkFakeChild();
  });
  // 按宿主平台注入可用沙箱状态 + strict + deny：resolveShellSpawn 走 wrapped 分支（net-off）
  __setSandboxSettingsForTest(settings('strict', 'deny'));
  __setSandboxStateForTest(IS_DARWIN
    ? {
      platform: 'darwin', sandboxTool: 'seatbelt', toolVersion: 'sandbox-exec',
      available: true, unavailableReason: null, windowsShell: null, executionPolicy: null, probedAt: 0,
    }
    : {
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

describe('bash 网络态查询：spawn 前接线（修订 B + v2.5 两字段 payload）', () => {
  it('effective 桥以 ctx.streamSessionId + ctx.workspaceId 查询（跨模块 ID 单点透传；grant 键控）', async () => {
    effectiveMock.mockResolvedValue({ netOn: false, extraDirs: [] });
    const tools = new ShellTools();
    const p = tools.execute('bash', { command: 'echo hi' }, ctx);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    expect(effectiveMock).toHaveBeenCalledWith('ssn-net-1', 'ws');
    (spawnMock.mock.results[0]!.value as ReturnType<typeof mkFakeChild>).emitClose(0);
    await p;
  });

  it('netOn=true → spawn net-on（无 --unshare-net）+ 结果 tag net-on', async () => {
    effectiveMock.mockResolvedValue({ netOn: true, extraDirs: [] });
    const result = await runBashToCompletion();
    expectNet('on');
    expect(result).toContain(`sandbox: ${WRAPPED}/net-on`);
  });

  it('netOn=false → spawn net-off + 失败结果原样返回（含原始 stderr，无任何追加提示）', async () => {
    effectiveMock.mockResolvedValue({ netOn: false, extraDirs: [] });
    const result = await runBashToCompletion();
    expectNet('off');
    expect(result).toContain(`sandbox: ${WRAPPED}/net-off`);
    expect(result).toContain('Could not resolve host');
    // 修订 B：ask 时代的「已获批准可重试」追加提示已下线——结果不再有任何后缀
    expect(result).not.toContain('沙箱网络已获用户批准');
    expect(result.endsWith('Could not resolve host: example.com')).toBe(true);
  });

  it('effective 桥故障（非 fork 环境 / 超时）→ 回退设置双态推导（deny → net-off）+ 主路径不挂死', async () => {
    effectiveMock.mockRejectedValue(new Error('process.send 缺失'));
    const result = await runBashToCompletion();
    expectNet('off');
    expect(result).toContain(`sandbox: ${WRAPPED}/net-off`);
    expect(result).toContain('Could not resolve host');
  });

  it('effective 桥故障但设置 allow → 回退推导 net-on（回退读设置非硬编码）', async () => {
    __setSandboxSettingsForTest(settings('strict', 'allow'));
    effectiveMock.mockRejectedValue(new Error('IPC 无响应'));
    const result = await runBashToCompletion();
    expectNet('on');
    expect(result).toContain(`sandbox: ${WRAPPED}/net-on`);
  });

  it('payload 形状锁：effective 桥返回 {netOn, extraDirs} 两键（v2.5 toolchainOn 字段防复活）', async () => {
    // mock 返回值含 toolchainOn 是契约违例——断言 mock 输入被消费者忽略：
    // spawn 仍按 netOn 驱动、extraDirs 路径不受 toolchainOn 字段污染
    effectiveMock.mockResolvedValue({ netOn: false, toolchainOn: false, extraDirs: [] });
    const result = await runBashToCompletion();
    expectNet('off');
    expect(result).toContain(`sandbox: ${WRAPPED}/net-off`);
  });
});