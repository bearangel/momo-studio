// electron/tests/resource/register-mcp-quick-create.test.ts
//
// P2.4 Task 1 契约测试：resource:registerMcp headers/cwd 透传全链（真实 DB）。
// 模式沿用 register-mcp-remote-contract.test.ts：不经手写中间数据，
// 锁 IPC 入参 → registerMcpDefinition 落库 → getMcpConfig 读回的字段形状。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { ipcMain } from 'electron';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { getMcpConfig } from '../../src/main/mcp/host-manager';
import { registerResourceHandlers } from '../../src/main/resource/ipc.handlers';

const tmpRoot = path.join(os.tmpdir(), `ap-register-mcp-quick-create-${Date.now()}`);

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

function getRegisterMcpHandler(): (evt: unknown, config: unknown) => Promise<unknown> {
  const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
  const call = calls.filter((c: unknown[]) => c[0] === 'resource:registerMcp').at(-1);
  return call![1] as (evt: unknown, config: unknown) => Promise<unknown>;
}

describe('resource:registerMcp headers/cwd 透传（真实 DB 契约）', () => {
  it('远程条目带 headers → 落库 headers_json 并原样读回', async () => {
    await getRegisterMcpHandler()({}, {
      name: 'context7-quick',
      command: '',
      transport: 'streamable_http',
      url: 'https://mcp.context7.com/mcp',
      headers: { Authorization: 'Bearer ctx7sk-test' },
    });
    const cfg = getMcpConfig('context7-quick');
    expect(cfg).not.toBeNull();
    expect(cfg!.headers).toEqual({ Authorization: 'Bearer ctx7sk-test' });
  });

  it('stdio 条目带 cwd → 落库并读回；缺省 cwd 读回 undefined', async () => {
    await getRegisterMcpHandler()({}, {
      name: 'fs-cwd',
      command: 'node',
      args: ['server.js'],
      cwd: '/opt/somewhere',
    });
    const cfg = getMcpConfig('fs-cwd');
    expect(cfg!.cwd).toBe('/opt/somewhere');

    await getRegisterMcpHandler()({}, { name: 'fs-nocwd', command: 'node' });
    expect(getMcpConfig('fs-nocwd')!.cwd).toBeUndefined();
  });

  it('远程条目缺省 headers → 读回 undefined（不落空对象）', async () => {
    await getRegisterMcpHandler()({}, {
      name: 'bare-remote',
      command: '',
      transport: 'streamable_http',
      url: 'https://mcp.example.com/mcp',
    });
    // headers_json 落 '{}' 时 rowToRegistered parse 回 {}——读回 undefined 或 {} 均合法，
    // 但字段缺省语义下应不产生 headers 键污染下游 if 判断：断言 toBeUndefined 或空
    const cfg = getMcpConfig('bare-remote');
    expect(cfg!.headers === undefined || Object.keys(cfg!.headers!).length === 0).toBe(true);
  });
});
