// electron/tests/resource/mcp-edit.test.ts
//
// P2.5 Task 2 契约测试：MCP 全字段编辑（getMcpEditView / updateMcpEntry）全链（真实 DB）。
// 模式沿用 register-mcp-quick-create.test.ts：不经手写中间数据，锁
// IPC 入参 → mcp-config 服务 → mcp_definitions UPDATE → 读回的字段形状。
// 落库语义红线：UPDATE 保 id/source/installed_at（与注册的 INSERT OR REPLACE
// 整行覆盖不同——用例 4 先记录原值再逐项比对）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { ipcMain } from 'electron';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { getMcpConfig } from '../../src/main/mcp/host-manager';
import { registerResourceHandlers } from '../../src/main/resource/ipc.handlers';
import type { McpEditView } from '../../src/main/resource/mcp-config';
import type { RegisteredMcp } from '../../src/main/mcp/types';

const tmpRoot = path.join(os.tmpdir(), `ap-mcp-edit-${Date.now()}`);

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

/** 取指定通道的 handler 直调（RED 阶段通道未注册时给出可读错误） */
function getChannelHandler(
  channel: string,
): (evt: unknown, ...args: unknown[]) => Promise<unknown> {
  const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
  const call = calls.filter((c: unknown[]) => c[0] === channel).at(-1);
  if (!call) throw new Error(`IPC 通道 ${channel} 未注册`);
  return call[1] as (evt: unknown, ...args: unknown[]) => Promise<unknown>;
}

/** 经 resource:registerMcp 真实注册链播种（source='custom'，与编辑功能目标条目同源） */
async function seedEntry(config: Record<string, unknown>): Promise<void> {
  await getChannelHandler('resource:registerMcp')({}, config);
}

/** 取 mcp_definitions 原始行（UPDATE 落库语义的列级断言用） */
function getRawRow(name: string): Record<string, unknown> {
  return getDb()
    .prepare('SELECT * FROM mcp_definitions WHERE name = ?')
    .get(name) as Record<string, unknown>;
}

describe('MCP 全字段编辑（getMcpEditView / updateMcpEntry 真实 DB 契约）', () => {
  it('getMcpEditView：stdio 条目读回全字段（command/args/env/cwd/version）', async () => {
    await seedEntry({
      name: 'fs-edit',
      command: 'node',
      args: ['server.js', '--verbose'],
      env: { NODE_ENV: 'production' },
      cwd: '/opt/fs-edit',
      version: '2.1.0',
    });
    const view = (await getChannelHandler('resource:getMcpEditView')(
      {},
      'fs-edit',
    )) as McpEditView;
    expect(view.name).toBe('fs-edit');
    expect(view.transport).toBe('stdio');
    expect(view.version).toBe('2.1.0');
    expect(view.command).toBe('node');
    expect(view.args).toEqual(['server.js', '--verbose']);
    expect(view.env).toEqual({ NODE_ENV: 'production' });
    expect(view.cwd).toBe('/opt/fs-edit');
    // stdio 条目无远程字段：url 键缺省、headers 恒空对象（表单可直接迭代）
    expect(view.url).toBeUndefined();
    expect(view.headers).toEqual({});
  });

  it('getMcpEditView：远程条目读回 transport/url/headers，env 空对象', async () => {
    await seedEntry({
      name: 'ctx7-edit',
      command: '',
      transport: 'streamable_http',
      url: 'https://mcp.context7.com/mcp',
      headers: { Authorization: 'Bearer tok-1' },
    });
    const view = (await getChannelHandler('resource:getMcpEditView')(
      {},
      'ctx7-edit',
    )) as McpEditView;
    expect(view.transport).toBe('streamable_http');
    expect(view.url).toBe('https://mcp.context7.com/mcp');
    expect(view.headers).toEqual({ Authorization: 'Bearer tok-1' });
    // 远程条目无 env 键值 → 读回空对象（表单可直接迭代）
    expect(view.env).toEqual({});
    expect(view.cwd).toBeUndefined();
  });

  it('getMcpEditView：未注册名 → reject 中文含「未注册」', async () => {
    await expect(
      getChannelHandler('resource:getMcpEditView')({}, 'ghost-mcp'),
    ).rejects.toThrow('未注册');
  });

  it('updateMcpEntry：改 stdio command/args/env → 读回落新值，且 id/installed_at/source 不变', async () => {
    await seedEntry({
      name: 'fs-keep',
      command: 'node',
      args: ['old.js'],
      env: { A: '1' },
    });
    const before = getMcpConfig('fs-keep') as RegisteredMcp;
    await getChannelHandler('resource:updateMcpEntry')({}, 'fs-keep', {
      command: 'python',
      args: ['new.py', '-p'],
      env: { B: '2' },
    });
    const after = getMcpConfig('fs-keep') as RegisteredMcp;
    expect(after.command).toBe('python');
    expect(after.args).toEqual(['new.py', '-p']);
    expect(after.env).toEqual({ B: '2' });
    // UPDATE 红线：id/source/installed_at 原值保持（INSERT OR REPLACE 会整行换新）
    expect(after.id).toBe(before.id);
    expect(after.source).toBe(before.source);
    expect(after.installedAt).toBe(before.installedAt);
  });

  it('updateMcpEntry：stdio → 切远程 → url/headers 落库、command 空串占位、cwd 落 NULL', async () => {
    await seedEntry({
      name: 'switch-remote',
      command: 'node',
      args: ['server.js'],
      cwd: '/opt/old',
    });
    await getChannelHandler('resource:updateMcpEntry')({}, 'switch-remote', {
      transport: 'streamable_http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer switched' },
      command: '',
    });
    const row = getDb()
      .prepare(
        'SELECT command, url, headers_json, cwd FROM mcp_definitions WHERE name = ?',
      )
      .get('switch-remote') as {
      command: string;
      url: string | null;
      headers_json: string | null;
      cwd: string | null;
    };
    expect(row.url).toBe('https://mcp.example.com/mcp');
    expect(JSON.parse(row.headers_json!)).toEqual({ Authorization: 'Bearer switched' });
    // 远程形态下 command 写空串占位（DB 列 NOT NULL）、cwd 清 NULL
    expect(row.command).toBe('');
    expect(row.cwd).toBeNull();
  });

  it('updateMcpEntry：远程 url 非 https → reject（校验先于任何 DB 写）', async () => {
    await seedEntry({
      name: 'fs-inet',
      command: 'node',
      args: ['keep.js'],
    });
    const rowBefore = getRawRow('fs-inet');
    await expect(
      getChannelHandler('resource:updateMcpEntry')({}, 'fs-inet', {
        transport: 'streamable_http',
        url: 'http://mcp.example.com/mcp',
        command: '',
      }),
    ).rejects.toThrow('https');
    // 防线先于写入——整行与调用前完全一致（无半行污染）
    expect(getRawRow('fs-inet')).toEqual(rowBefore);
  });

  it('updateMcpEntry：未注册名 → reject「未注册」', async () => {
    await expect(
      getChannelHandler('resource:updateMcpEntry')({}, 'ghost-mcp', {
        command: 'node',
      }),
    ).rejects.toThrow('未注册');
  });
});
