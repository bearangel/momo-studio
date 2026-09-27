// electron/tests/agent/tools/process-tools.test.ts
//
// 回合进程管理工具（E-A，2026-09-25）：
//   1. 参数面：port/pid/pgid 校验、三选一必填（错误路径有中文反馈）
//   2. 非 fork 环境（无 process.send）：桥快速 reject 而非挂等——工具层透传
//   3. 工具注册中心：process_list / process_kill 已登记
// （授权击杀/成员清点的真实语义由 tests/sandbox/process-registry.test.ts
//   对真进程锁定；runner 路由由 agent-runner.test.ts 锁定）
import { describe, it, expect } from 'vitest';
import { ProcessTools } from '../../../src/main/agent/tools/process-tools';
import { buildToolRegistry } from '../../../src/main/agent/tools';
import type { ToolContext } from '../../../src/main/agent/tools/types';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpRoot = path.join(os.tmpdir(), `ap-proc-tools-${Date.now()}`);
fs.mkdirSync(path.join(tmpRoot, 'ws'), { recursive: true });

const ctx: ToolContext = {
  wsFs: new WorkspaceFS(path.join(tmpRoot, 'ws')),
  workspaceId: 'ws-x',
  workspaceDir: path.join(tmpRoot, 'ws'),
  skillRegistry: {} as ToolContext['skillRegistry'],
  streamSessionId: 'ss-proc-tools',
  roomId: 'room-x',
  sendStreamChunk: () => {},
  permissionConfig: { allowedTools: ['process_list', 'process_kill'], deniedTools: [] },
  creatorUserId: '',
};

const tools = new ProcessTools();

describe('ProcessTools 参数面', () => {
  it('process_kill：三选一必填', async () => {
    await expect(tools.execute('process_kill', {}, ctx)).rejects.toThrow('三选一');
  });

  it('process_kill：非法 port / pid / pgid 有中文反馈（错误路径）', async () => {
    await expect(tools.execute('process_kill', { port: 0 }, ctx)).rejects.toThrow('port');
    await expect(tools.execute('process_kill', { port: 99999 }, ctx)).rejects.toThrow('port');
    await expect(tools.execute('process_kill', { pid: -1 }, ctx)).rejects.toThrow('pid');
    await expect(tools.execute('process_kill', { pgid: 'x' as unknown as number }, ctx)).rejects.toThrow('pgid');
  });

  it('非 fork 环境（无 process.send）：桥快速 reject 中文文案（不挂等超时）', async () => {
    await expect(tools.execute('process_list', {}, ctx)).rejects.toThrow('IPC 不可用');
    await expect(tools.execute('process_kill', { port: 8080 }, ctx)).rejects.toThrow('IPC 不可用');
  });

  it('未知工具名抛错', async () => {
    await expect(tools.execute('process_x', {}, ctx)).rejects.toThrow('未知进程工具');
  });
});

describe('工具注册中心', () => {
  it('process_list / process_kill 已注册且工具定义齐全', () => {
    const defs = buildToolRegistry(ctx).flatMap((m) => m.getDefs());
    const names = defs.map((d) => d.name);
    expect(names).toContain('process_list');
    expect(names).toContain('process_kill');
  });
});
