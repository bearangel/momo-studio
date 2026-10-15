// electron/tests/audit/tool-call-source.test.ts
//
// 审计 source 透传链锁（spec §4.3）：toolSourceFor 判定 / logToolCall 载荷 /
// insertToolCall 落库。三点各自独立锁——runtime-entry 的 finally 包装消费
// 前两者（集成面由 T9 真实冒烟覆盖）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { toolSourceFor } from '../../src/main/agent/tools/plugin-tools';
import { logToolCall } from '../../src/main/agent/tools/shared/audit';
import { insertToolCall } from '../../src/main/audit/insert';
import type { ToolModule } from '../../src/main/agent/tools/types';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-audit-src-'));

function fakeBuiltinModule(names: string[]): ToolModule {
  return {
    getDefs: () => names.map((n) => ({ name: n, description: '', inputSchema: {} })),
    getCatalog: () => [],
    handles: (n) => names.includes(n),
    execute: async () => 'ok',
  };
}

const pluginModule = {
  pluginId: 'cg',
  pluginSource: 'plugin' as const,
  getDefs: () => [{ name: 'plugin:cg/echo', description: '', inputSchema: {} }],
  getCatalog: () => [],
  handles: (n: string) => n === 'plugin:cg/echo',
  execute: async () => 'echo',
};

describe('toolSourceFor', () => {
  it('插件模块命中 → plugin；内置/未知 → builtin', () => {
    const modules = [fakeBuiltinModule(['read_file']), pluginModule];
    expect(toolSourceFor('plugin:cg/echo', modules)).toBe('plugin');
    expect(toolSourceFor('read_file', modules)).toBe('builtin');
    expect(toolSourceFor('unknown_tool', modules)).toBe('builtin');
  });
});

describe('logToolCall 载荷', () => {
  it('source 透传（缺省 builtin）', () => {
    const send = vi.fn();
    const proc = process as unknown as { send?: unknown };
    const orig = proc.send;
    proc.send = send as (msg: unknown) => void;
    try {
      logToolCall({
        toolName: 'plugin:cg/echo',
        inputSummary: 'i',
        outputSummary: 'o',
        success: true,
        durationMs: 1,
        source: 'plugin',
      });
      logToolCall({ toolName: 'read_file', inputSummary: 'i', outputSummary: 'o', success: true, durationMs: 1 });
    } finally {
      proc.send = orig;
    }
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[0]![0] as { source: string }).source).toBe('plugin');
    expect((send.mock.calls[1]![0] as { source: string }).source).toBe('builtin');
  });
});

describe('insertToolCall 落库', () => {
  beforeEach(() => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    process.env.AP_USER_DATA_DIR = tmpRoot;
    runMigrations();
  });
  afterEach(() => {
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });
  it('source 写入列；缺省 builtin', () => {
    insertToolCall({
      workspaceId: 'ws1',
      agentBotUserId: 'u1',
      toolName: 'plugin:cg/echo',
      inputSummary: 'i',
      outputSummary: 'o',
      success: true,
      durationMs: 1,
      source: 'plugin',
    });
    insertToolCall({
      workspaceId: 'ws1',
      agentBotUserId: 'u1',
      toolName: 'read_file',
      inputSummary: 'i',
      outputSummary: 'o',
      success: true,
      durationMs: 1,
    });
    const rows = getDb()
      .prepare(`SELECT tool_name, source FROM tool_calls ORDER BY tool_name`)
      .all() as Array<{ tool_name: string; source: string }>;
    expect(rows.find((r) => r.tool_name === 'plugin:cg/echo')!.source).toBe('plugin');
    expect(rows.find((r) => r.tool_name === 'read_file')!.source).toBe('builtin');
  });
});
