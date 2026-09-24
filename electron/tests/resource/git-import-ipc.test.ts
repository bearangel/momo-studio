// electron/tests/resource/git-import-ipc.test.ts
//
// P2.6 Task 2 契约测试：resource:scanGitRepoSkills / resource:importGitRepoSkills
// 两通道的 IPC 边界——通道注册、参数序（url / importId 透传）、返回体透传、
// import 成功后广播资源目录、异常中文上抛。
//
// 分层职责（momo-test-rules 第 5 条——mock 收窄到模块边界）：
//   - skill/git-import 模块桩化：真实下载/解析/落盘链路由 tests/skill/git-import.test.ts
//     覆盖，本文件只锁「renderer → preload → handler → 服务函数」的对接面
//   - p2p/resource-share 广播 spy：fire-and-forget 广播是 import 通道契约的一部分
//     （与 registerMcp/uploadSkillZip 同语义），不 mock 无法断言
//   - AP_USER_DATA_DIR 指向 tmp：logger（electron-log）落盘隔离；两 handler 不触 DB
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

// git-import 服务桩：可控返回 / 可控抛错（vi.hoisted 共享，防 mock 工厂提升 TDZ）
const { gitImportMocks } = vi.hoisted(() => ({
  gitImportMocks: {
    scanGitRepoSkills: vi.fn(),
    importGitRepoSkills: vi.fn(),
  },
}));
vi.mock('../../src/main/skill/git-import', () => gitImportMocks);

// 广播 spy：import 成功后的唯一外副作用（P2P 未启用时真实实现为静默 no-op，
// 此处桩化才能锁「调用事实」）
const { broadcastCatalog } = vi.hoisted(() => ({ broadcastCatalog: vi.fn() }));
vi.mock('../../src/main/p2p/resource-share', () => ({
  broadcastLocalResourceCatalog: broadcastCatalog,
}));

import { ipcMain } from 'electron';
import { registerResourceHandlers } from '../../src/main/resource/ipc.handlers';

const tmpRoot = path.join(os.tmpdir(), `ap-git-import-ipc-${Date.now()}`);

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  registerResourceHandlers();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 从 ipcMain.handle 注册记录里按通道名取 handler（注册序不稳定，恒取最后一次） */
function getHandler(channel: string): (evt: unknown, ...args: unknown[]) => Promise<unknown> {
  const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
  const call = calls.filter((c: unknown[]) => c[0] === channel).at(-1);
  if (!call) throw new Error(`通道 ${channel} 未注册`);
  return call[1] as (evt: unknown, ...args: unknown[]) => Promise<unknown>;
}

describe('resource:scanGitRepoSkills — 通道契约', () => {
  it('透传 url，返回 {importId, skills} 原样；scan 为只读预览不广播', async () => {
    // importId 形态仿真 randomUUID（Task 3 弹窗以它作 import 凭证回传）
    const stub = {
      importId: '0192f0a0-1234-4000-8000-00000000abcd',
      skills: [
        { slug: 'brainstorming', name: 'Brainstorming', description: '想法变设计' },
        { slug: 'tdd', name: 'TDD', description: '测试驱动' },
      ],
    };
    gitImportMocks.scanGitRepoSkills.mockResolvedValue(stub);

    const result = await getHandler('resource:scanGitRepoSkills')(
      {},
      'https://github.com/obra/superpowers',
    );

    // 参数序：服务函数第一个参数 = renderer 传入的 url（不含 evt）
    expect(gitImportMocks.scanGitRepoSkills).toHaveBeenCalledTimes(1);
    expect(gitImportMocks.scanGitRepoSkills).toHaveBeenCalledWith('https://github.com/obra/superpowers');
    expect(result).toEqual(stub);
    expect(broadcastCatalog).not.toHaveBeenCalled();
  });

  it('服务层中文报错（暂不支持 host）→ handler reject 原样上抛', async () => {
    gitImportMocks.scanGitRepoSkills.mockRejectedValue(
      new Error('暂不支持 gitee.com（当前支持 github.com / gitlab.com）'),
    );
    await expect(
      getHandler('resource:scanGitRepoSkills')({}, 'https://gitee.com/x/y'),
    ).rejects.toThrow(/暂不支持/);
  });
});

describe('resource:importGitRepoSkills — 通道契约', () => {
  it('透传 importId，返回 {imported, failures} 原样，成功后广播目录一次', async () => {
    const stub = {
      imported: [
        { slug: 'brainstorming', name: 'Brainstorming', description: '想法变设计' },
        { slug: 'tdd', name: 'TDD', description: '测试驱动' },
      ],
      failures: [{ slug: 'bad', reason: '非法 slug：bad/..' }],
    };
    gitImportMocks.importGitRepoSkills.mockResolvedValue(stub);

    const result = await getHandler('resource:importGitRepoSkills')({}, '0192f0a0-1234-4000-8000-00000000abcd');

    expect(gitImportMocks.importGitRepoSkills).toHaveBeenCalledTimes(1);
    expect(gitImportMocks.importGitRepoSkills).toHaveBeenCalledWith('0192f0a0-1234-4000-8000-00000000abcd');
    expect(result).toEqual(stub);
    // 有失败条目也属「成功返回」（逐条结果不中断）→ 仍广播
    expect(broadcastCatalog).toHaveBeenCalledTimes(1);
  });

  it('导入抛错（会话失效）→ handler reject 中文透传且不广播', async () => {
    gitImportMocks.importGitRepoSkills.mockRejectedValue(new Error('导入会话已失效，请重新扫描'));
    await expect(
      getHandler('resource:importGitRepoSkills')({}, 'stale-import-id'),
    ).rejects.toThrow(/失效/);
    expect(broadcastCatalog).not.toHaveBeenCalled();
  });
});
