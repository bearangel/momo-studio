// electron/tests/audit/tool-call-bridge-fork.test.ts
//
// 审计桥端到端回归锁（2026-11-04 P0 排查产物）：
//   真实 fork 子进程（require 真实 tsc 编译的 audit.js）→ 真实 child IPC
//   （MOMO_RUNTIME_CHILD 哨兵门 + 'audit:toolCall' 标签 + 摘要截断全在真实
//   audit.ts 内发生）→ 生产 spawnForAgent messageHandler → insertToolCall
//   落 temp AP_USER_DATA_DIR 库。
//
// 覆盖：
//   1. 桥健康：子进程发出的审计行真实落库，workspace/agent 身份由 spawn 闭包
//      runtimeConfig 补全（子进程载荷不含身份）——本用例即「写入从未停」的
//      机制演示；生产 2026-11-04 的「停写 8 小时」实为 UTC 时间戳误读
//      （datetime('now') 产出 UTC，10:54 UTC = 18:54 CST 本地，恰为当日重
//      会话收尾时刻），桥本身完好。桥在任何后续重构中断裂，这里第一时间红。
//   2. 任务遥测（D2）：携带 taskId 的审计行落 tool_calls.task_id 并递增
//      tasks.tool_calls_used；无 taskId（快速会话形态）行 task_id 为 NULL
//      且不递增任何任务计数。
//
// 夹具编译保真：audit.ts 经工作区同款 tsc 编译为 CJS 临时产物（与生产 dist
// 同一形态）——夹具零手抄线协议；tsc 缺失时 skip（同 boot-handshake-fork 模式）。

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { spawnForAgent, __setRuntimeEntryPathForTest } from '../../src/main/agent/runtime-spawner';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask } from '../../src/main/storage/tasks/repo';
import type { AgentRuntimeOpts } from '../../src/main/agent/runtime-config';

const TSC_BIN = path.join(__dirname, '../../node_modules/typescript/bin/tsc');
const AUDIT_SRC = path.join(__dirname, '../../src/main/agent/tools/shared/audit.ts');
const FIXTURE_CHILD = path.join(__dirname, 'fixtures/audit-child.cjs');
const hasTsc = fs.existsSync(TSC_BIN);

describe.skipIf(!hasTsc)('audit:toolCall 桥（真实 fork + 真实 IPC + temp DB）', () => {
  let emitDir: string;
  let tmpRoot: string;
  let compiledAuditPath: string;

  beforeAll(() => {
    // 单文件编译真实 audit.ts → CJS（audit.ts 零依赖，单文件 emit 干净落地）
    emitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-audit-emit-'));
    execFileSync(
      process.execPath,
      [TSC_BIN, AUDIT_SRC, '--module', 'commonjs', '--target', 'es2022', '--skipLibCheck', '--outDir', emitDir],
      { stdio: 'pipe' },
    );
    compiledAuditPath = path.join(emitDir, 'audit.js');
    expect(fs.existsSync(compiledAuditPath)).toBe(true);
  }, 60_000);

  afterAll(() => {
    fs.rmSync(emitDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-audit-bridge-'));
    process.env.AP_USER_DATA_DIR = tmpRoot;
    runMigrations();
    const db = getDb();
    db.prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws-fork-audit', 'T', '/tmp', '@o')`).run();
    // 遥测目标行：dispatch 链形态的 in_progress 任务
    insertTask({
      id: 'T-9001',
      workspaceId: 'ws-fork-audit',
      title: '审计桥遥测目标',
      creatorUserId: '@o',
      status: 'in_progress',
    });
  });

  afterEach(() => {
    __setRuntimeEntryPathForTest(null);
    delete process.env.AUDIT_FX_MODULE;
    delete process.env.AUDIT_FX_CALLS;
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('子进程 audit:toolCall → 桥 → tool_calls 落库；taskId 贯穿 + tasks.tool_calls_used 递增', async () => {
    // 夹具输入：一条带任务 id（dispatch/任务板形态）、一条不带（快速会话形态）
    process.env.AUDIT_FX_MODULE = compiledAuditPath;
    process.env.AUDIT_FX_CALLS = JSON.stringify([
      {
        toolName: 'write_file',
        inputSummary: '{"path":"src/a.ts"}',
        outputSummary: '已写入',
        success: true,
        durationMs: 42,
        taskId: 'T-9001',
      },
      {
        toolName: 'read_file',
        inputSummary: '{"path":"README.md"}',
        outputSummary: '内容',
        success: true,
        durationMs: 7,
      },
    ]);
    __setRuntimeEntryPathForTest(FIXTURE_CHILD);

    const runtimeConfig: AgentRuntimeOpts = {
      instanceId: 'inst-fork-audit',
      workspaceId: 'ws-fork-audit',
      workspaceDir: tmpRoot,
      agentAssignmentId: 'inst-fork-audit',
      agentUserId: 'agent-fork-audit',
      systemPrompt: '',
      modelName: 'm',
      llmApiKey: 'k',
    };
    const runtime = await spawnForAgent({
      assignmentId: 'inst-fork-audit',
      runtimeConfig,
      onChunk: vi.fn(),
      onExit: vi.fn(),
    });

    const db = getDb();
    try {
      // 子进程 IPC 异步送达——轮询等两行都落库
      await vi.waitFor(() => {
        const n = (db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get() as { n: number }).n;
        expect(n).toBe(2);
      }, { timeout: 10_000, interval: 100 });

      const rows = db
        .prepare('SELECT task_id, workspace_id, agent_bot_user_id, tool_name FROM tool_calls')
        .all() as Array<{ task_id: string | null; workspace_id: string; agent_bot_user_id: string; tool_name: string }>;
      // 身份补全：子进程载荷不含 workspace/agent 身份，由 spawn 闭包 runtimeConfig 定型
      for (const r of rows) {
        expect(r.workspace_id).toBe('ws-fork-audit');
        expect(r.agent_bot_user_id).toBe('agent-fork-audit');
      }
      // taskId 贯穿：带 id 行落 task_id；快速会话形态行保持 NULL
      const write = rows.find((r) => r.tool_name === 'write_file')!;
      expect(write.task_id).toBe('T-9001');
      const read = rows.find((r) => r.tool_name === 'read_file')!;
      expect(read.task_id).toBeNull();

      // 任务遥测（D2）：恰 +1（无 taskId 行不计入）
      const task = db.prepare('SELECT tool_calls_used FROM tasks WHERE id = ?').get('T-9001') as { tool_calls_used: number };
      expect(task.tool_calls_used).toBe(1);
    } finally {
      try {
        runtime.child.kill();
      } catch {
        // 子进程经 audit-fx-done 回调已自退
      }
    }
  }, 30_000);
});
