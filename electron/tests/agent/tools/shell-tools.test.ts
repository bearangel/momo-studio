// electron/tests/agent/tools/shell-tools.test.ts
//
// ShellTools 单元测试：bash 正常执行 + 超时 + 黑名单 + 输出截断，共 10 条。
// 设计要点：
//   - 每条用例用唯一 tmp 目录 + 真实 WorkspaceFS（路径沙箱走真实代码路径）。
//   - 构造最小 ToolContext：ShellTools 只用 wsFs / workspaceDir，其他字段给 stub。
//   - 黑名单用例直接期待 reject（命令在 spawn 前被 assertCommandAllowed 拦下）。
//   - 超时用例 vitest 超时给 10s（远大于 timeoutMs=1000，避免 CI 抖动）。
//   - 环境变量白名单用例：临时往 process.env 写 OPENAI_API_KEY，验证子进程不可见；
//     用例末尾 delete 清理；afterEach 再兜底清理一次避免失败时泄漏。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import type { ToolContext } from '../../../src/main/agent/tools/types';
import { ShellTools } from '../../../src/main/agent/tools/shell-tools';

let tmpRoot: string;
let tmpDir: string;
let wsFs: WorkspaceFS;
let ctx: ToolContext;

beforeEach(() => {
  // 每用例唯一 tmpDir，避免模块级缓存串数据。
  tmpRoot = path.join(os.tmpdir(), `ap-shell-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(tmpDir, { recursive: true });
  wsFs = new WorkspaceFS(tmpDir);
  // ShellTools 只用 wsFs / workspaceDir；其他字段给空 stub（实现不会触碰）。
  ctx = {
    wsFs,
    workspaceId: 'test-ws',
    workspaceDir: tmpDir,
    skillRegistry: {} as ToolContext['skillRegistry'],
    streamSessionId: 'test-stream',
    roomId: 'test-room',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: ['bash'], deniedTools: [] },
  };
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  // 兜底：防止 OPENAI_API_KEY 用例失败时泄漏到后续用例。
  delete process.env.OPENAI_API_KEY;
});

describe('bash 正常执行', () => {
  it('简单 echo', async () => {
    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: 'echo hello' }, ctx);
    expect(result).toContain('exit_code: 0');
    expect(result).toContain('hello');
  });

  it('退出码非 0 不抛错', async () => {
    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: 'exit 42' }, ctx);
    expect(result).toContain('exit_code: 42');
  });

  it('工作目录锁定 workspace 根', async () => {
    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: 'pwd' }, ctx);
    expect(result).toContain(tmpDir);
  });

  it('环境变量含 WORKSPACE_DIR 不含 OPENAI_API_KEY', async () => {
    process.env.OPENAI_API_KEY = 'secret-key-for-test';
    const tools = new ShellTools();
    const result = await tools.execute('bash',
      { command: 'echo WORKSPACE=$WORKSPACE_DIR SK=$OPENAI_API_KEY' }, ctx);
    expect(result).toContain(`WORKSPACE=${tmpDir}`);
    expect(result).not.toContain('secret-key-for-test');
    delete process.env.OPENAI_API_KEY;
  });
});

describe('bash 超时', () => {
  it('自定义 timeoutMs 超时', async () => {
    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: 'sleep 5', timeoutMs: 1000 }, ctx);
    expect(result).toContain('超时');
  }, 10000);
});

describe('bash 黑名单', () => {
  it('rm -rf / 抛错', async () => {
    const tools = new ShellTools();
    await expect(tools.execute('bash', { command: 'rm -rf /' }, ctx)).rejects.toThrow(/黑名单/);
  });

  it('mkfs 抛错', async () => {
    const tools = new ShellTools();
    await expect(tools.execute('bash', { command: 'mkfs.ext4 /dev/sda' }, ctx)).rejects.toThrow(/黑名单/);
  });

  it('fork bomb 抛错', async () => {
    const tools = new ShellTools();
    await expect(tools.execute('bash', { command: ':(){ :|:& };:' }, ctx)).rejects.toThrow(/黑名单/);
  });

  it('rm -rf ./dist 不误伤', async () => {
    await fs.promises.mkdir(path.join(tmpDir, 'dist'));
    await fs.promises.writeFile(path.join(tmpDir, 'dist/x'), '');
    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: 'rm -rf ./dist' }, ctx);
    expect(result).toContain('exit_code: 0');
    expect(fs.existsSync(path.join(tmpDir, 'dist'))).toBe(false);
  });

  it('git commit 走 bash 被拦截', async () => {
    const tools = new ShellTools();
    await expect(tools.execute('bash', { command: 'git commit -m test' }, ctx)).rejects.toThrow(/git_commit/);
  });
});

describe('bash 输出截断', () => {
  it('stdout 超 10KB 截断', async () => {
    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: 'yes hello | head -2000' }, ctx);
    expect(result).toContain('截断');
  });
});
