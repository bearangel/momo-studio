// electron/tests/resource/resource-install-ipc.test.ts
//
// M2.4 D1 契约锁：resource:install 的失败上行文案必须是人话——
// 不含 Electron invoke 包装（`Error invoking remote method '…':`）、
// 不含错误类名前缀（`HubCatalogStaleError: `），且原文逐字保留。
//
// 分层（momo-test-rules 第 5 条）：只桩模块边界——hub 安装链（真实下载/记账由
// resource/hub-install-stale.test.ts 等覆盖）与 library 查详情；handler 接线用真实实现。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  app: { getVersion: () => '9.9.9' },
}));

// vi.hoisted：mock 工厂提升后仍能引用（防 TDZ）
const { hubInstallMocks, libraryMocks, staleErrorClass } = vi.hoisted(() => {
  class HubCatalogStaleError extends Error {
    override readonly name = 'HubCatalogStaleError';
  }
  return {
    staleErrorClass: HubCatalogStaleError,
    hubInstallMocks: {
      fetchSmitheryDetail: vi.fn(),
      installSmitheryRemote: vi.fn(),
      uninstallHubMcp: vi.fn(),
      installHubPackage: vi.fn(),
      uninstallHubPackage: vi.fn(),
    },
    libraryMocks: {
      listResources: vi.fn(),
      resolveResourceById: vi.fn(),
    },
  };
});

vi.mock('../../src/main/resource/hub-install', () => ({
  ...hubInstallMocks,
  HubCatalogStaleError: staleErrorClass,
  HUB_INSTALL_PROGRESS_CHANNEL: 'hub:installProgress',
}));

// M2.5 终审 FIX-1：只覆盖 catalog 健康/接入两个同步读取面，其余（hubProvider 等）
// 保留真实实现——handler 只消费这两个判定。
const hubCatalogMocks = vi.hoisted(() => ({ notEnrolled: false, degraded: false }));
vi.mock('../../src/main/resource/hub/momo-hub', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/main/resource/hub/momo-hub')>();
  return {
    ...actual,
    isHubCatalogDegraded: () => hubCatalogMocks.degraded,
    isHubNotEnrolled: () => hubCatalogMocks.notEnrolled,
  };
});

vi.mock('../../src/main/resource/library', () => libraryMocks);

import { ipcMain } from 'electron';
import { registerResourceHandlers } from '../../src/main/resource/ipc.handlers';

const tmpRoot = path.join(os.tmpdir(), `ap-resource-install-ipc-${Date.now()}`);

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  libraryMocks.resolveResourceById.mockResolvedValue(null);
  registerResourceHandlers();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 按通道名取最后一次注册的 handler（注册序不稳定） */
function getHandler(channel: string): (evt: unknown, ...args: unknown[]) => Promise<unknown> {
  const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
  const call = calls.filter((c: unknown[]) => c[0] === channel).at(-1);
  if (!call) throw new Error(`通道 ${channel} 未注册`);
  return call[1] as (evt: unknown, ...args: unknown[]) => Promise<unknown>;
}

/** 调 handler 并取 rejection（断言不依赖 toThrow 的模糊匹配） */
async function rejectionOf(channel: string, id: string): Promise<Error> {
  try {
    await getHandler(channel)({}, id);
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  }
  throw new Error('handler 未 reject');
}

describe('resource:install — 失败文案人话化（M2.4 D1）', () => {
  it('HubCatalogStaleError → 只留 message：无 IPC 包装、无类名前缀、原文逐字在场', async () => {
    const human = '无法确认 momo-hub 上的最新版本（网络不可用），请稍后重试';
    hubInstallMocks.installHubPackage.mockRejectedValue(new staleErrorClass(human));

    const err = await rejectionOf('resource:install', 'hub-skill-brainstorming');

    expect(err.message).toBe(human);
    expect(err.message).not.toContain('Error invoking remote method');
    expect(err.message).not.toContain('HubCatalogStaleError');
    // name 恒 'Error'：Electron 序列化不再追加 `<Name>: ` 段
    expect(err.name).toBe('Error');
  });

  it('未知错误保留原 message（不吞成「未知错误」、不改写）', async () => {
    hubInstallMocks.installHubPackage.mockRejectedValue(new Error('磁盘空间不足，无法解包'));
    const err = await rejectionOf('resource:install', 'hub-skill-brainstorming');
    expect(err.message).toBe('磁盘空间不足，无法解包');
    expect(err.name).toBe('Error');
  });

  it('已带包装/类名前缀的字符串化错误 → 双前缀均剥净（幂等防御）', async () => {
    hubInstallMocks.installHubPackage.mockRejectedValue(
      new Error("Error invoking remote method 'x': HubCatalogStaleError: 请稍后重试"),
    );
    const err = await rejectionOf('resource:install', 'hub-skill-brainstorming');
    expect(err.message).toBe('请稍后重试');
  });

  it('hub 安装成功路径不受影响（回执原样透传，不触发错误归一）', async () => {
    hubInstallMocks.installHubPackage.mockResolvedValue({
      cachePath: '/tmp/x',
      alreadyLatest: true,
      version: '1.0.0',
    });
    const r = (await getHandler('resource:install')({}, 'hub-skill-brainstorming')) as {
      alreadyLatest?: boolean;
    };
    expect(r.alreadyLatest).toBe(true);
  });
});

// M2.5 终审 FIX-1：getCatalogStatus 必须如实透出「hub 未接入」——renderer 播种
// 门控据此区分「目录为空」与「未接入」，杜绝兜底记账行被当成目录证据。
describe('resource:getCatalogStatus — hubNotEnrolled（M2.5 终审 FIX-1）', () => {
  it('未接入 → hubNotEnrolled=true；接入 → false；两者 hub 源均不报降级', async () => {
    const handler = getHandler('resource:getCatalogStatus');

    hubCatalogMocks.notEnrolled = true;
    hubCatalogMocks.degraded = false;
    expect(await handler({})).toEqual({
      degraded: false,
      hubNotEnrolled: true,
      sources: [
        { source: 'marketplace', degraded: false },
        { source: 'hub', degraded: false },
      ],
    });

    hubCatalogMocks.notEnrolled = false;
    expect(await handler({})).toEqual({
      degraded: false,
      hubNotEnrolled: false,
      sources: [
        { source: 'marketplace', degraded: false },
        { source: 'hub', degraded: false },
      ],
    });
  });
});
