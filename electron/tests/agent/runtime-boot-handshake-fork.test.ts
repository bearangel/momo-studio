// electron/tests/agent/runtime-boot-handshake-fork.test.ts
//
// P0 静默回合丢失（WarmPool boot 竞态）——真实 fork dist 产物的端到端回归锁。
//
// 场景（复刻 .superpowers/e2e/mcp-realmodel-report.md 缺陷 #1 的最小复现）：
//   1. spawnForAgent fork 真实编译产物 runtime-entry.js（boot 含 MCP 发现 IPC
//      往返 await——mcpNames 指向未注册的 server，主进程分支回写 error）
//   2. spawn resolve 后立即 child.send(task-config)（= AgentRunner.executeTask
//      的生产行为：acquire 返回即发）
//   3. 断言回合不丢：子进程必须产出 start chunk 与 end chunk（LLM baseUrl 指向
//      本测试起的恒 400 HTTP server，chatStream 立即失败 → end(error)——
//      无需真实 LLM 即可观测「task-config 已送达且 chat loop 已运行」）
//
// 修复前：spawn 在 fork 后即 resolve，task-config 落在子进程监听器注册前的
// 事件循环窗口内被永久丢弃 → 永远等不到 end chunk（红）。
// 修复后：spawn 等 runtime-ready（子进程注册完 task-config 监听器后的一次性
// 信号）才 resolve → 消息必达（绿）。
//
// 前置：electron/dist 已构建（tsc 产物）。dist 缺失时 skip——本测试锁的是
// 「编译产物 + 生产 spawn 链」的契约，源码级契约由
// runtime-boot-handshake.test.ts（fake child 层）覆盖。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawnForAgent, __setRuntimeEntryPathForTest } from '../../src/main/agent/runtime-spawner';
import type { StreamChunk } from '../../src/main/agent/stream-chunk';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import type { AgentRuntimeOpts } from '../../src/main/agent/runtime-config';

const DIST_ENTRY = path.join(__dirname, '../../dist/main/agent/runtime-entry.js');
const hasDist = fs.existsSync(DIST_ENTRY);

describe.skipIf(!hasDist)('runtime-ready 握手（真实 fork dist 产物）', () => {
  let tmpRoot: string;
  let llmSrv: { close: () => Promise<void>; port: number } | null = null;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-boot-fork-'));
    process.env.AP_USER_DATA_DIR = tmpRoot;
    runMigrations();
    __setRuntimeEntryPathForTest(DIST_ENTRY);
  });

  afterEach(async () => {
    __setRuntimeEntryPathForTest(null);
    if (llmSrv) await llmSrv.close().catch(() => undefined);
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  /** 恒 400 的本地 LLM 端点（非可重试状态码 → chatStream 立即失败 → end(error)） */
  function startFailingLlm(): Promise<{ close: () => Promise<void>; port: number }> {
    const server = http.createServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fork-test-expected-llm-failure' } }));
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr === null || typeof addr === 'string') {
          throw new Error('LLM 测试端点地址解析失败');
        }
        resolve({
          port: addr.port,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    });
  }

  /** 轮询等待 onChunk 收到指定类型的 chunk（超时抛中文错误） */
  async function waitForChunk(
    chunks: StreamChunk[],
    type: StreamChunk['type'],
    timeoutMs: number,
  ): Promise<StreamChunk> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = chunks.find((c) => c.type === type);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(
          `等待 chunk type=${type} 超时（${timeoutMs / 1000}s）。已收到: ${chunks
            .map((c) => c.type)
            .join(',') || '无'}——task-config 疑似在监听器注册前丢失（P0 回归）`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it('spawn resolve 后立即派发 task-config，回合不丢（start + end chunk 必达）', async () => {
    llmSrv = await startFailingLlm();
    const chunks: StreamChunk[] = [];
    const runtimeConfig: AgentRuntimeOpts = {
      instanceId: 'inst-fork',
      workspaceId: 'ws-fork',
      workspaceDir: tmpRoot,
      agentAssignmentId: 'inst-fork',
      agentUserId: 'agent-fork-1',
      systemPrompt: 'fork 握手测试',
      modelName: 'fork-test-model',
      modelBaseUrl: `http://127.0.0.1:${llmSrv.port}/v1`,
      modelPlatform: 'openai',
      llmApiKey: 'k',
      // 关键：boot 含 MCP 发现 IPC 往返 await（未注册 → 主进程回写 error →
      // discoverMcpTools 跳过）——制造「监听器注册前」的事件循环窗口
      mcpNames: ['ghost-mcp-not-registered'],
    };

    const runtime = await spawnForAgent({
      assignmentId: 'inst-fork',
      runtimeConfig,
      onChunk: (c) => chunks.push(c),
      onExit: vi.fn(),
    });

    // 生产行为复刻：acquire 返回即发（不 sleep、不等待）
    const sent = runtime.child.send({
      type: 'task-config',
      taskId: null,
      executionSessionId: 'sess-fork',
      body: 'fork 握手测试回合',
      streamSessionId: 'ss-fork-1',
      mentions: [],
      maxToolCalls: 3,
    });
    expect(sent).toBe(true);

    // 回合不丢：start chunk 必达（chat loop 已启动）
    await waitForChunk(chunks, 'start', 20_000);
    // 收尾必达：LLM 端点恒 400（非可重试）→ 立即 end(error)
    const end = await waitForChunk(chunks, 'end', 20_000);
    expect((end as { finishReason?: string }).finishReason).toBe('error');

    // 收尾：子进程 task-end 后自退；兜底 shutdown
    try {
      runtime.child.kill();
    } catch {
      // 已退出
    }
  }, 45_000);
});
