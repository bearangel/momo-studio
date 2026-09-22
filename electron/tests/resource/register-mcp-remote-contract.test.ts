// electron/tests/resource/register-mcp-remote-contract.test.ts
//
// P2 Task 7 契约测试：resource:registerMcp 二态透传全链（真实 DB）。
// renderer RegisterMcpInput{transport:'streamable_http', url} → IPC handler →
// registerMcpDefinition 落库 → getMcpConfig 读回——不经手写构造的中间数据，
// 锁死 IPC 面到持久化层的字段形状（momo-test-rules 铁律 4）。
// 与 ipc-handlers.test.ts 的 mock 模式互补：那边锁 handler→registerMcpDefinition
// 的调用形状，这边锁 DB 真实往返（含 library custom 映射取回 ResourceItem）。
//
// DB 隔离沿用 host-manager-remote.test.ts 模式（tmp AP_USER_DATA_DIR + runMigrations）。
// 仅 mock electron（ipcMain）；host-manager / library / p2p 广播全部走真实实现
// （p2p 未初始化时广播静默 no-op，不产生网络副作用）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ipcMain 在测试环境不存在——与 ipc-handlers.test.ts 同款 mock
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { ipcMain } from 'electron';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { getMcpConfig } from '../../src/main/mcp/host-manager';
import { registerResourceHandlers } from '../../src/main/resource/ipc.handlers';
import type { ResourceItem } from '../../src/main/resource/types';

const tmpRoot = path.join(os.tmpdir(), `ap-register-mcp-contract-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  registerResourceHandlers();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 取最近一次注册的 resource:registerMcp handler（beforeEach 每轮重注册） */
function getRegisterMcpHandler(): (evt: unknown, config: unknown) => Promise<unknown> {
  const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
  const call = calls.filter((c: unknown[]) => c[0] === 'resource:registerMcp').at(-1);
  return call![1] as (evt: unknown, config: unknown) => Promise<unknown>;
}

describe('resource:registerMcp 二态透传全链（真实 DB 契约）', () => {
  it('remote 输入注册后 getMcpConfig 读回 transport/url（command 空串占位）', async () => {
    const item = (await getRegisterMcpHandler()({}, {
      name: 'ms-weather-import',
      command: '',
      transport: 'streamable_http',
      url: 'https://mcp.modelscope.cn/sse',
    })) as ResourceItem;

    // 落库读回：二态字段原样持久化
    const cfg = getMcpConfig('ms-weather-import');
    expect(cfg).not.toBeNull();
    expect(cfg!.transport).toBe('streamable_http');
    expect(cfg!.url).toBe('https://mcp.modelscope.cn/sse');
    expect(cfg!.command).toBe(''); // DB 列 NOT NULL 占位
    expect(cfg!.source).toBe('custom');

    // 返回值来自真实 library custom 映射（非手写构造）
    expect(item.source).toBe('custom');
    expect(item.type).toBe('mcp');
    expect(item.slug).toBe('ms-weather-import');
    expect(item.installed).toBe(true);
  });

  it('stdio 输入（缺省 transport）读回不受影响（存量行为兼容）', async () => {
    await getRegisterMcpHandler()({}, { name: 'fs-import', command: 'npx', args: ['-y', 'fs'] });
    const cfg = getMcpConfig('fs-import');
    expect(cfg!.transport).toBe('stdio');
    expect(cfg!.command).toBe('npx');
    expect(cfg!.url).toBeUndefined();
  });

  it('remote 输入 url 非 https → 抛错且不落库（安全边界经 IPC 面同样生效）', async () => {
    await expect(
      getRegisterMcpHandler()({}, {
        name: 'bad-remote',
        command: '',
        transport: 'streamable_http',
        url: 'http://x.test/sse',
      }),
    ).rejects.toThrow(/https/);
    expect(getMcpConfig('bad-remote')).toBeNull();
  });
});
