// electron/tests/sandbox/ipc.handlers.test.ts
//
// sandbox 命名空间 4 通道（getState / reprobe / installBwrap / dismissPrompt）测试。
// ipcMain.handle mock 形态照抄 tests/files/ipc.handlers.test.ts（vi.hoisted + Map 捕获）；
// db fixture 复用 tests/sandbox/settings.test.ts 模式（AP_USER_DATA_DIR 临时目录 + runMigrations）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// vi.mock 会被提升到所有 import 之前；被工厂引用的 mock 必须用 vi.hoisted 提前声明。
const { ipcHandlers, reprobeMock, detectPkgMock } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  reprobeMock: vi.fn(),
  detectPkgMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// reprobeSandbox 打桩：本文件只验证 IPC 接线（真实探测逻辑由 probe.test.ts 覆盖）。
// 保留 actual 的 getSandboxState / __setSandboxStateForTest——buildInfo 消费真实单例缓存。
vi.mock('../../src/main/sandbox/probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/sandbox/probe')>();
  return { ...actual, reprobeSandbox: reprobeMock };
});

// detectPackageManager 打桩：容器/CI 上包管理器不确定，mock 保证 installCommand 断言确定性。
// probe.ts 也 import 本模块（detectWindowsShell / getExecutionPolicy），一并补占位避免缺导出。
vi.mock('../../src/main/sandbox/windows', () => ({
  detectPackageManager: detectPkgMock,
  detectWindowsShell: vi.fn(),
  getExecutionPolicy: vi.fn(),
}));

import {
  registerSandboxIpc,
  installBwrapViaPkexec,
  type SandboxInfo,
} from '../../src/main/sandbox/ipc.handlers';
import {
  __setSandboxStateForTest,
  type SandboxProbeState,
} from '../../src/main/sandbox/probe';
import { __setSandboxSettingsForTest } from '../../src/main/sandbox/settings';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

const tmpRoot = path.join(os.tmpdir(), `ap-sandbox-ipc-test-${Date.now()}`);

const KV_BWRAP = 'sandbox_bwrap_prompt_dismissed';
const KV_WINPOLICY = 'sandbox_win_policy_prompt_dismissed';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  ipcHandlers.clear();
  reprobeMock.mockReset();
  detectPkgMock.mockReset();
  // 默认按 apt 环境；需要 manager=null 等场景的用例自行覆盖
  detectPkgMock.mockReturnValue({ manager: 'apt', installCommand: 'sudo apt install bubblewrap' });
  __setSandboxStateForTest(null);
  __setSandboxSettingsForTest(null);
  registerSandboxIpc();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 直接写 kv_store（模拟旧库/其他写入方） */
function setKv(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

function readKv(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function mkRunner(result: { code: number | null; stdout: string; stderr: string }) {
  return vi.fn().mockResolvedValue(result);
}

describe('sandbox/ipc.handlers 通道注册', () => {
  it('注册 sandbox:getState / reprobe / installBwrap / dismissPrompt 四通道', () => {
    expect(ipcHandlers.has('sandbox:getState')).toBe(true);
    expect(ipcHandlers.has('sandbox:reprobe')).toBe(true);
    expect(ipcHandlers.has('sandbox:installBwrap')).toBe(true);
    expect(ipcHandlers.has('sandbox:dismissPrompt')).toBe(true);
  });
});

describe('sandbox:getState', () => {
  it('默认 settings（strict/off）+ 探测状态 null + 提示卡均未关闭', async () => {
    detectPkgMock.mockReturnValue({ manager: 'apt', installCommand: 'sudo apt install bubblewrap' });
    const handler = ipcHandlers.get('sandbox:getState')!;

    const info = (await handler()) as SandboxInfo;

    expect(info.settings).toEqual({ mode: 'strict', networkEnabled: false });
    expect(info.state).toBeNull();
    expect(info.installCommand).toBe('sudo apt install bubblewrap');
    expect(info.bwrapPromptDismissed).toBe(false);
    expect(info.winPolicyPromptDismissed).toBe(false);
  });

  it('kv 提示卡 flag 读取：winPolicy=1 → 仅 winPolicyPromptDismissed=true', async () => {
    detectPkgMock.mockReturnValue({ manager: null, installCommand: null });
    setKv(KV_WINPOLICY, '1');

    const info = (await ipcHandlers.get('sandbox:getState')!()) as SandboxInfo;

    expect(info.winPolicyPromptDismissed).toBe(true);
    expect(info.bwrapPromptDismissed).toBe(false);
    // manager=null 时 installCommand 结构完整返回 null
    expect(info.installCommand).toBeNull();
  });

  it('探测状态单例反映到 state 字段', async () => {
    const st: SandboxProbeState = {
      platform: 'linux',
      sandboxTool: 'bwrap',
      toolVersion: 'bubblewrap 0.10.0',
      available: true,
      unavailableReason: null,
      windowsShell: null,
      executionPolicy: null,
      probedAt: 42,
    };
    __setSandboxStateForTest(st);

    const info = (await ipcHandlers.get('sandbox:getState')!()) as SandboxInfo;

    expect(info.state).toEqual(st);
  });
});

describe('sandbox:dismissPrompt', () => {
  it("dismissPrompt('bwrap') 写 kv='1'，getState 反映 true（winPolicy 不受影响）", async () => {
    const dismiss = ipcHandlers.get('sandbox:dismissPrompt')!;
    await dismiss({}, 'bwrap');

    expect(readKv(KV_BWRAP)).toBe('1');
    const info = (await ipcHandlers.get('sandbox:getState')!()) as SandboxInfo;
    expect(info.bwrapPromptDismissed).toBe(true);
    expect(info.winPolicyPromptDismissed).toBe(false);
  });

  it("dismissPrompt('winPolicy') 写独立 key；重复调用幂等（upsert 不报错）", async () => {
    const dismiss = ipcHandlers.get('sandbox:dismissPrompt')!;
    await dismiss({}, 'winPolicy');
    await dismiss({}, 'winPolicy');

    expect(readKv(KV_WINPOLICY)).toBe('1');
    expect(readKv(KV_BWRAP)).toBeNull();
  });
});

describe('installBwrapViaPkexec', () => {
  it('fake runner 注入 → pkexec apt-get install -y bubblewrap 被调用，code 0 → ok:true', async () => {
    detectPkgMock.mockReturnValue({ manager: 'apt', installCommand: 'sudo apt install bubblewrap' });
    const runner = mkRunner({ code: 0, stdout: 'Setting up bubblewrap', stderr: '' });

    const r = await installBwrapViaPkexec(runner);

    expect(runner).toHaveBeenCalledWith('pkexec', ['apt-get', 'install', '-y', 'bubblewrap']);
    expect(r.ok).toBe(true);
  });

  it('pkexec 缺失（runner 返回 ENOENT，code null）→ ok:false，output 含 pkexec', async () => {
    detectPkgMock.mockReturnValue({ manager: 'apt', installCommand: 'sudo apt install bubblewrap' });
    const runner = mkRunner({ code: null, stdout: '', stderr: 'spawn pkexec ENOENT' });

    const r = await installBwrapViaPkexec(runner);

    expect(r.ok).toBe(false);
    expect(r.output).toContain('pkexec');
  });

  it('未识别包管理器（manager=null）→ ok:false 且不调 runner（错误路径）', async () => {
    detectPkgMock.mockReturnValue({ manager: null, installCommand: null });
    const runner = mkRunner({ code: 0, stdout: '', stderr: '' });

    const r = await installBwrapViaPkexec(runner);

    expect(r.ok).toBe(false);
    expect(r.output).toContain('未识别');
    expect(runner).not.toHaveBeenCalled();
  });

  it('dnf / pacman / zypper 分支的 pkexec 安装参数映射', async () => {
    const runner = mkRunner({ code: 0, stdout: '', stderr: '' });

    detectPkgMock.mockReturnValue({ manager: 'dnf', installCommand: 'sudo dnf install bubblewrap' });
    await installBwrapViaPkexec(runner);
    expect(runner).toHaveBeenLastCalledWith('pkexec', ['dnf', 'install', '-y', 'bubblewrap']);

    detectPkgMock.mockReturnValue({ manager: 'pacman', installCommand: 'sudo pacman -S bubblewrap' });
    await installBwrapViaPkexec(runner);
    expect(runner).toHaveBeenLastCalledWith('pkexec', ['pacman', '-S', '--noconfirm', 'bubblewrap']);

    detectPkgMock.mockReturnValue({ manager: 'zypper', installCommand: 'sudo zypper install bubblewrap' });
    await installBwrapViaPkexec(runner);
    expect(runner).toHaveBeenLastCalledWith('pkexec', ['zypper', '--non-interactive', 'install', 'bubblewrap']);
  });

  it('安装输出为空时兜底文案（ok / fail 两分支）', async () => {
    detectPkgMock.mockReturnValue({ manager: 'apt', installCommand: 'sudo apt install bubblewrap' });

    const ok = await installBwrapViaPkexec(mkRunner({ code: 0, stdout: '', stderr: '' }));
    expect(ok.ok).toBe(true);
    expect(ok.output).toBe('安装成功');

    const fail = await installBwrapViaPkexec(mkRunner({ code: 1, stdout: '', stderr: '' }));
    expect(fail.ok).toBe(false);
    expect(fail.output).toBe('安装失败');
  });
});

describe('sandbox:reprobe', () => {
  it('注入 fake 探测（bwrap 可用）→ 单例更新且返回 info.state.available=true', async () => {
    detectPkgMock.mockReturnValue({ manager: 'apt', installCommand: 'sudo apt install bubblewrap' });
    reprobeMock.mockImplementation(async () => {
      const st: SandboxProbeState = {
        platform: process.platform,
        sandboxTool: 'bwrap',
        toolVersion: 'bubblewrap 0.10.0',
        available: true,
        unavailableReason: null,
        windowsShell: null,
        executionPolicy: null,
        probedAt: Date.now(),
      };
      __setSandboxStateForTest(st);
      return st;
    });

    const info = (await ipcHandlers.get('sandbox:reprobe')!()) as SandboxInfo;

    expect(reprobeMock).toHaveBeenCalledTimes(1);
    expect(info.state?.available).toBe(true);
    expect(info.state?.sandboxTool).toBe('bwrap');
  });
});
