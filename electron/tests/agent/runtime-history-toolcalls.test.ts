// electron/tests/agent/runtime-history-toolcalls.test.ts
//
// 回归锁（2026-11-08 DeepSeek HTTP 400 事故）：chat loop 工具结果回填的
// 历史形状——每条带 tool_calls 的 assistant 消息之后、下一条 assistant 之前，
// 必须恰好是覆盖其全部 tool_call_id 的 tool 响应（OpenAI 兼容协议硬约束，
// DeepSeek 严格校验；宽松 provider 不炸故此前未暴露）。
//
// 事故根因：task_complete / compact 分支在响应级 assistant(toolCalls=全量)
// 之后又补 push 第二条 assistant(toolCalls=[tc])——穿插阻断第一条 assistant
// 的 tool 响应序列 → 下一个请求 400（insufficient tool messages following
// tool_calls message）。
//
// 保真度：真 runtime 子进程（dist runtime-entry）+ 本地 OpenAI 兼容 SSE 服务端
// （第一请求回 text+task_complete；第二请求捕获 body 断言历史形状）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { spawnForAgent, __setRuntimeEntryPathForTest } from '../../src/main/agent/runtime-spawner';
import type { StreamChunk } from '../../src/main/agent/stream-chunk';

const DIST_ENTRY = path.join(__dirname, '../../dist/main/agent/runtime-entry.js');
const hasDist = fs.existsSync(DIST_ENTRY);

interface CapturedRequest {
  messages: Array<Record<string, unknown>>;
}

function sse(res: http.ServerResponse, events: unknown[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/** 双请求脚本服务端：R1 回 text+task_complete(tool_calls)；R2 捕获 body 回纯文本收尾 */
function startScriptedLlm(): Promise<{
  port: number;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed: { messages?: Array<Record<string, unknown>> } = {};
      try { parsed = JSON.parse(body); } catch { /* 忽略 */ }
      const seq = requests.length;
      requests.push({ messages: parsed.messages ?? [] });
      if (seq === 0) {
        sse(res, [
          { choices: [{ delta: { content: '第一段：报告正文。' } }] },
          { choices: [{ delta: { tool_calls: [{
            index: 0, id: 'call_seg_test_1',
            function: { name: 'task_complete', arguments: '{"summary":"第一段摘要"}' },
          }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]);
      } else {
        sse(res, [
          { choices: [{ delta: { content: '全部输出完成。' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('端口解析失败');
      resolve({
        port: addr.port,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** 历史形状断言：每条 assistant(tool_calls) 的 tool 响应必须紧跟其后成组出现 */
function assertToolCallsFollowed(messages: Array<Record<string, unknown>>): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
    const expectedIds = new Set((m.tool_calls as Array<{ id?: string }>).map((tc) => tc.id ?? ''));
    const gotIds = new Set<string>();
    let j = i + 1;
    for (; j < messages.length; j++) {
      const n = messages[j]!;
      if (n.role === 'assistant') break;
      if (n.role === 'tool' && typeof n.tool_call_id === 'string') gotIds.add(n.tool_call_id);
    }
    const missing = [...expectedIds].filter((id) => !gotIds.has(id));
    expect(
      missing,
      `assistant(tool_calls=[${[...expectedIds].join(',')}] 后必须先跟齐全部 tool 响应（缺 ${missing.join(',')}，穿插了 ${j < messages.length ? 'assistant' : '序列尾'}）`,
    ).toEqual([]);
  }
}

describe.skipIf(!hasDist)('chat loop 工具历史形状（task_complete 分段后下一请求）', { timeout: 60_000 }, () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ap-hist-tc-${Date.now()}-`));
  let llm: Awaited<ReturnType<typeof startScriptedLlm>>;

  beforeAll(async () => {
    process.env.AP_USER_DATA_DIR = tmpRoot;
    runMigrations();
    __setRuntimeEntryPathForTest(DIST_ENTRY);
    llm = await startScriptedLlm();
  });
  afterAll(async () => {
    __setRuntimeEntryPathForTest(null);
    await llm?.close().catch(() => undefined);
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('task_complete 分段后的下一请求：assistant(tool_calls) 的 tool 响应成组紧跟（无穿插）', async () => {
    const chunks: StreamChunk[] = [];
    const runtime = await spawnForAgent({
      assignmentId: 'inst-hist-tc',
      runtimeConfig: {
        instanceId: 'inst-hist-tc',
        workspaceId: 'ws-hist',
        workspaceDir: tmpRoot,
        agentAssignmentId: 'inst-hist-tc',
        agentUserId: 'agent-hist-1',
        systemPrompt: '历史形状测试',
        modelName: 'hist-test-model',
        modelBaseUrl: `http://127.0.0.1:${llm.port}/v1`,
        modelPlatform: 'openai',
        llmApiKey: 'k',
      },
      onChunk: (c) => chunks.push(c),
      onExit: vi.fn(),
    });
    runtime.child.send({
      type: 'task-config', taskId: null, executionSessionId: 'sess-hist',
      body: '分两段输出报告', streamSessionId: 'ss-hist-1', mentions: [], maxToolCalls: 3,
    });

    const deadline = Date.now() + 45_000;
    while (!chunks.some((c) => c.type === 'end') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
    }
    const end = chunks.find((c) => c.type === 'end');
    expect(end, `回合未收尾。chunks: ${chunks.map((c) => c.type).join(',')}`).toBeDefined();
    expect((end as { finishReason?: string }).finishReason).toBe('stop');
    try { runtime.child.kill(); } catch { /* 已退出 */ }

    // 第二请求（task_complete 结果回填后的续跑）必须存在且历史形状合法
    expect(llm.requests.length).toBeGreaterThanOrEqual(2);
    assertToolCallsFollowed(llm.requests[1]!.messages);
  });
});
