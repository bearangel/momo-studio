// electron/tests/sandbox/write-blocked-emit.test.ts
// 主进程事件检测（spec 2026-10-03 §5.1/§5.3）：批次 tool_call_result 命中 →
// 组装 writeBlocked 信号（command 跨批环形缓存关联；session/ws 经 messages 解析）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inspectEventBatch,
  __resetInspectStateForTest,
} from '../../src/main/sandbox/write-blocked-emit';
import type { MessageEventRow } from '../../src/main/storage/messages/events-repo';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

const tmpRoot = path.join(os.tmpdir(), `write-blocked-emit-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  __resetInspectStateForTest();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

let seq = 0;
function mkStart(callId: string, command: string): MessageEventRow {
  seq += 1;
  return {
    id: `e-${callId}-s-${seq}`, messageId: 'm-1', seq, eventType: 'tool_call_start',
    payload: { callId, toolName: 'bash', args: { command } }, createdAt: Date.now(),
  };
}
function mkResult(callId: string, result: string): MessageEventRow {
  seq += 1;
  return {
    id: `e-${callId}-r-${seq}`, messageId: 'm-1', seq, eventType: 'tool_call_result',
    payload: { callId, toolName: 'bash', result, success: false }, createdAt: Date.now(),
  };
}

// 语料用真实 home（emit 内部取 os.homedir()——HOME 一级归并分支）
const HOME = os.homedir();
const CARGO_FAIL = `error: failed to open ${HOME}/.cargo/registry/cache/a.crate\n\nCaused by:\n  Operation not permitted (os error 1)`;

describe('inspectEventBatch（spec §5.3）', () => {
  it('start+result 同批：命中 → dirs 归一 + command 关联', () => {
    const sig = inspectEventBatch([mkStart('c1', 'cargo build'), mkResult('c1', CARGO_FAIL)]);
    expect(sig).not.toBeNull();
    expect(sig!.command).toBe('cargo build');
    expect(sig!.dirs).toEqual([path.join(HOME, '.cargo')]); // HOME 一级归一
  });

  it('start 先批、result 后批：环形缓存跨批关联 command', () => {
    expect(inspectEventBatch([mkStart('c2', 'cargo run')])).toBeNull();
    const sig = inspectEventBatch([mkResult('c2', CARGO_FAIL)]);
    expect(sig?.command).toBe('cargo run');
  });

  it('非 bash / 未命中签名批次 → null', () => {
    const nonBash: MessageEventRow = { ...mkResult('c3', CARGO_FAIL), payload: { callId: 'c3', toolName: 'write_file', result: CARGO_FAIL } };
    expect(inspectEventBatch([nonBash])).toBeNull();
    expect(inspectEventBatch([mkResult('c4', 'ok output')])).toBeNull();
  });

  it('消息行在库：sessionId/workspaceId 经 messages 解析', () => {
    getDb()
      .prepare(
        'INSERT INTO messages (id, session_id, sender, event_type, body, stream_session_id, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('m-1', 's-resolve', 'agent-x', 'message', '', 'ss-resolve', 'w-resolve', Date.now(), Date.now());
    const sig = inspectEventBatch([mkStart('c5', 'x'), mkResult('c5', CARGO_FAIL)]);
    expect(sig?.sessionId).toBe('s-resolve');
    expect(sig?.workspaceId).toBe('w-resolve');
  });

  it('消息行缺失（无映射）→ sessionId/workspaceId null（卡按钮降级依据）', () => {
    const sig = inspectEventBatch([mkStart('c6', 'x'), mkResult('c6', CARGO_FAIL)]);
    expect(sig?.sessionId).toBeNull();
    expect(sig?.workspaceId).toBeNull();
  });

  it('command 截断 200（超长命令预览上限）', () => {
    const longCmd = 'x'.repeat(500);
    const sig = inspectEventBatch([mkStart('c7', longCmd), mkResult('c7', CARGO_FAIL)]);
    expect(sig?.command).toHaveLength(200);
  });
});
