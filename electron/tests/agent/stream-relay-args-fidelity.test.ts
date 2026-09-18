// electron/tests/agent/stream-relay-args-fidelity.test.ts
//
// F4 回归锁：tool_call args 全链路保真（chunk → routeChunkToBuffer →
// MessageEventBuffer 批量落盘 → message_events.payload）。
//
// 动机（2026-09-18 实测会话）：导出中 CodeForge 的两次 write_file 参数损坏——
// demo-greet.js 丢失中段（记录内容是语法错误的 JS，但磁盘文件正确、node 运行
// 3/3 通过）、codeforge-notes.md 丢失尾部；而同会话 6242 字节的另一次 write_file
// 参数完整——即「记录的 args ≠ 实际执行的 args」。
//
// 代码级审计结论（本仓当前实现）：
//   - doExecuteTool 各分支 chip 携带 call.arguments 原引用（无拆分/重组）
//   - routeChunkToBuffer 将 chunk.args 原样写入 payload（无截断）
//   - MessageEventBuffer 整条 payload 单事务 INSERT（insertEventBatch，
//     无分片追加——不存在丢中段的窗口）
//   - events-repo payload_json = JSON.stringify(payload) 全文（无长度上限）
// 即写入路径不存在「丢中段/丢尾部」的机制；本测试把该结论锁为契约。
// 若用户库中仍有损坏（需对生产库 SQLite 直查 message_events.payload_json
// 裁决：库中已坏 = 子进程→主进程 IPC 前的 provider 流式组装问题；库中完好
// = 读取/渲染侧问题），此测试保证损坏不再可能由本写入链路引入。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mockSend } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import {
  __routeChunkToBufferForTest,
  __resetEventBufferForTest,
  __flushEventBufferForTest,
} from '../../src/main/agent/stream-relay';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { getMessageByStreamSessionId } from '../../src/main/storage/messages/repo';
import { listEventsByMessage } from '../../src/main/storage/messages/events-repo';

const tmpRoot = path.join(os.tmpdir(), `ap-relay-args-${Date.now()}`);

describe('tool_call args 全链路保真（F4 契约锁）', () => {
  beforeEach(() => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    process.env.AP_USER_DATA_DIR = tmpRoot;
    runMigrations();
    __resetEventBufferForTest();
  });

  afterEach(() => {
    __resetEventBufferForTest();
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  function startStream(ssi: string): string {
    __routeChunkToBufferForTest({
      type: 'start',
      streamSessionId: ssi,
      sessionId: '!room:localhost',
      senderAgentId: '@bot:localhost',
    });
    return getMessageByStreamSessionId(ssi)!.id;
  }

  /** 对抗性载荷：模拟实测损坏场景（长中文代码内容，含引号/反引号/换行/emoji/代理对） */
  function adversarialContent(seed: string, targetLen: number): string {
    const unit = `${seed}：你好，世界！${'```'}code\n\t"引号" '单引号' \`反引号\` ✅🛑🎉 😀 数 学 ——占位——`;
    let out = '';
    while (out.length < targetLen) out += unit;
    return out.slice(0, targetLen);
  }

  it('3KB 中文+emoji+引号混排 args 落库后逐字节一致（deep equal + JSON 往返稳定）', () => {
    const messageId = startStream('ss-args-1');
    const args = {
      content: adversarialContent('demo', 3000),
      path: 'scripts/demo-greet.js',
      nested: { list: [1, '两', { 三: true }], empty: null },
    };
    __routeChunkToBufferForTest({
      type: 'tool_call',
      streamSessionId: 'ss-args-1',
      callId: 'c-adv-1',
      toolName: 'write_file',
      args,
    });
    __flushEventBufferForTest();

    const events = listEventsByMessage(messageId).filter((e) => e.eventType === 'tool_call_start');
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as { callId: string; args: Record<string, unknown> };
    expect(payload.callId).toBe('c-adv-1');
    expect(payload.args).toEqual(args);
    // JSON 往返字节稳定（导出渲染 JSON.stringify(args) 与库内可逆）
    expect(JSON.parse(JSON.stringify(payload.args))).toEqual(args);
  });

  it('批量落盘（单批 30 条阈值 + 多 chunk 并发 pending）不丢不改任何 args', () => {
    const messageId = startStream('ss-args-2');
    const argSets: Array<Record<string, unknown>> = [];
    // 35 个 tool_call chunk：跨越 flushBatch=30 阈值，触发「批满即刷 + 余量走 50ms 窗口」
    for (let i = 0; i < 35; i++) {
      const args = { content: adversarialContent(`batch-${i}`, 300 + i * 17), index: i };
      argSets.push(args);
      __routeChunkToBufferForTest({
        type: 'tool_call',
        streamSessionId: 'ss-args-2',
        callId: `c-batch-${i}`,
        toolName: 'write_file',
        args,
      });
    }
    __flushEventBufferForTest();

    const events = listEventsByMessage(messageId).filter((e) => e.eventType === 'tool_call_start');
    expect(events).toHaveLength(35);
    for (let i = 0; i < 35; i++) {
      const ev = events.find(
        (e) => (e.payload as { callId?: string }).callId === `c-batch-${i}`,
      );
      expect(ev, `callId=c-batch-${i} 的事件存在`).toBeDefined();
      expect(ev!.payload).toEqual({ callId: `c-batch-${i}`, toolName: 'write_file', args: argSets[i] });
    }
  });

  it('isDispatch 委派 chip 的 args（含 task 长文本）同样保真', () => {
    const messageId = startStream('ss-args-3');
    const task = adversarialContent('委派任务', 2500);
    __routeChunkToBufferForTest({
      type: 'tool_call',
      streamSessionId: 'ss-args-3',
      callId: 'c-disp-1',
      toolName: 'dispatch_bg:coder',
      args: { task, toolBudget: 12 },
      isDispatch: true,
      subStreamSessionId: 'ss-sub-1',
      subAgentName: '码农',
      subAgentAvatar: '🤖',
    });
    __flushEventBufferForTest();

    const ev = listEventsByMessage(messageId).find((e) => e.eventType === 'tool_call_start')!;
    expect(ev.payload).toEqual({
      callId: 'c-disp-1',
      toolName: 'dispatch_bg:coder',
      args: { task, toolBudget: 12 },
      isDispatch: true,
      subStreamSessionId: 'ss-sub-1',
      subAgentName: '码农',
      subAgentAvatar: '🤖',
    });
  });
});
