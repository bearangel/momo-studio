// 验证 v1.5.1 修复：bash 工具监听外部 abortSignal，被中断时立即 SIGKILL + resolve
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import { ShellTools } from '../../../src/main/agent/tools/shell-tools';
import type { ToolContext } from '../../../src/main/agent/tools/types';

describe('ShellTools abortSignal 响应', () => {
  it('外部 abortSignal 触发时立即 SIGKILL bash 子进程', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-shell-abort-'));
    const controller = new AbortController();
    const ctx: ToolContext = {
      wsFs: new WorkspaceFS(tmpDir),
      workspaceId: 'test-ws',
      workspaceDir: tmpDir,
      skillRegistry: { list: () => [] } as never,
      streamSessionId: 'ssn',
      roomId: '!r',
      sendStreamChunk: () => {},
      permissionConfig: { allowedTools: [], deniedTools: [] },
      abortSignal: controller.signal,
    };

    const tools = new ShellTools();
    // 启动 sleep 30（远超测试时长，正常需要 30s 才返回）
    const promise = tools.execute('bash', { command: 'sleep 30', timeoutMs: 60000 }, ctx);

    // 给 bash spawn 一点时间启动
    await new Promise((r) => setTimeout(r, 200));

    // 触发外部中断
    const startAbort = Date.now();
    controller.abort();

    // v1.5.2: bash 被 abort 时 reject AbortError（chat loop 据此跳出，不推结果给 LLM 防死循环）
    await expect(promise).rejects.toThrow(/被中断/);
    const elapsed = Date.now() - startAbort;

    // 验证：100ms 内返回（不是 30s 后）
    expect(elapsed).toBeLessThan(1000);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('未传 abortSignal 时 bash 行为不变（向后兼容）', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-shell-no-abort-'));
    const ctx: ToolContext = {
      wsFs: new WorkspaceFS(tmpDir),
      workspaceId: 'test-ws',
      workspaceDir: tmpDir,
      skillRegistry: { list: () => [] } as never,
      streamSessionId: 'ssn',
      roomId: '!r',
      sendStreamChunk: () => {},
      permissionConfig: { allowedTools: [], deniedTools: [] },
      // 不传 abortSignal
    };

    const tools = new ShellTools();
    const result = await tools.execute('bash', { command: 'echo hello' }, ctx);
    expect(result).toContain('hello');
    expect(result).not.toContain('用户中断');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
