// electron/tests/agent/tools/journal-wiring.test.ts
// v2.5 变更账本生产接线回归锁（Task 4 / C1 模式风险）。
//
// 背景：记账调用分散在 file-tools / apply-patch-tools 的写路径里，单测直接
//   new FileTools() + 手工 ctx 的形态无法证明「生产路由真的会记账」——v2.3
//   readTracker 漏注入（终审 C1）正是这种形态下长期未暴露。本测试对生产路由
//   入口 doExecuteTool 断言（toolCtx 组装是内联代码，doExecuteTool 是最小可达
//   seam）：真实 buildToolRegistry + 真实 WorkspaceFS + 真实临时 workspace +
//   真实 SQLite（AP_USER_DATA_DIR + runMigrations + __setJournalStoreForTest
//   注入 createJournalStore(getDb())），不 mock 任何工具层。
//
// 红绿验证（brief Step 1）：临时摘掉 file-tools 记账调用 → 恰好条目类用例
//   （1/2/2b/3/4/4b/6）变红；只读零条目（5）与降级用例（7/8）保持绿。
//
// 进程归属说明：doExecuteTool 生产运行在 task-driven 子进程（runtime-spawner
//   fork runtime-entry.js），本测试在测试进程直接调用——与 v2.3 read-tracker /
//   v2.4 shell-sandbox 接线锁同款 seam 约定（子进程 store 注入由 runtime-entry
//   main() boot 承担，见该文件注释）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import { buildToolRegistry } from '../../../src/main/agent/tools';
import type { LLMToolCall } from '../../../src/main/agent/llm-provider';
import type { RuntimeConfig } from '../../../src/main/agent/runtime-config';
import { doExecuteTool, type RuntimeContext } from '../../../src/main/agent/runtime-entry';
import { runMigrations, closeDb, getDb } from '../../../src/main/storage/db';
import { createJournalStore, type JournalStore } from '../../../src/main/journal/store';
import { __setJournalStoreForTest } from '../../../src/main/journal/recorder';
import type { JournalEntry } from '../../../src/main/journal/types';
import { __setJournalEnabledForTest } from '../../../src/main/agent/tools/shared/change-journal';

// mock electron.app.getPath（apply-patch-tools 回滚备份目录走 app.getPath）。
// 仓库标准 vi.mock('electron') 模式（apply-patch-tools.test.ts 同款）。
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

const sha = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

/** userData 根（state.db + journal blob 都落这里）；workspace 用独立临时目录 */
const udRoot = path.join(os.tmpdir(), `momo-v25-wiring-ud-${Date.now()}`);

let tmpDir: string;
let ctx: RuntimeContext;
let store: JournalStore;

/** 构造 LLMToolCall（id/name/arguments 三段） */
function call(name: string, args: Record<string, unknown>): LLMToolCall {
  return { id: `call-${randomUUID()}`, name, arguments: args };
}

/** 构造 RuntimeConfig——assertToolAllowed 仅读 allowedTools/deniedTools；taskId 用例读 currentTaskId */
function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-bot',
    agentUserId: '@bot:localhost',
    systemPrompt: '',
    modelName: 'test',
    llmApiKey: 'k',
    workspaceDir: tmpDir,
    workspaceId: 'ws-j',
    role: 'standalone',
    subAgents: [],
    skills: [],
    mcpNames: [],
    allowedTools: [],
    deniedTools: [],
    isLeader: false,
    devMode: false,
    maxToolCalls: 10,
    contextWindow: 0,
    outputTokens: 0,
    ...overrides,
  };
}

/** 断言恰好 1 条并返回（noUncheckedIndexedAccess 安全收窄） */
function onlyEntry(entries: JournalEntry[]): JournalEntry {
  expect(entries).toHaveLength(1);
  const e = entries[0];
  if (!e) throw new Error('断言失败：期望恰好 1 条账本条目');
  return e;
}

/** 本次 stream 会话的全部条目（streamSessionId 每测唯一，天然隔离） */
function entriesOfThisStream(): JournalEntry[] {
  return store.listByStream('ws-j', ctx.streamSessionId);
}

beforeEach(() => {
  // db fixture 照 tests/journal/store.test.ts：真实迁移建库（含 v33），
  // 不手搓简化表——掩盖列名/约束漂移即违背 momo-test-rules 铁律 1
  fs.mkdirSync(udRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = udRoot;
  runMigrations();
  store = createJournalStore(getDb());
  __setJournalStoreForTest(store);

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-v25-wiring-ws-'));
  const wsFs = new WorkspaceFS(tmpDir);
  const skillRegistry = { list: () => [] } as never;
  const sendStreamChunk = () => {};
  const sharedToolCtxFields = {
    wsFs,
    workspaceId: 'ws-j',
    workspaceDir: tmpDir,
    skillRegistry,
    streamSessionId: `ssn-${randomUUID()}`,
    roomId: '!room-j',
    sendStreamChunk,
    permissionConfig: { allowedTools: [] as string[], deniedTools: [] as string[] },
    creatorUserId: 'test-user',
  };
  ctx = {
    wsFs,
    skillRegistry,
    tools: [],
    systemPrompt: '',
    workspaceId: 'ws-j',
    workspaceDir: tmpDir,
    roomId: '!room-j',
    streamSessionId: sharedToolCtxFields.streamSessionId,
    sendStreamChunk,
    creatorUserId: 'test-user',
    toolModules: buildToolRegistry(sharedToolCtxFields),
  };
});

afterEach(() => {
  __setJournalStoreForTest(null);
  __setJournalEnabledForTest(true);
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(udRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('变更账本生产接线回归锁（doExecuteTool 真实路由，Task 4）', () => {
  it('1) write_file 新建 → 1 条 create 条目 + after blob 可读回（全字段断言）', async () => {
    const out = await doExecuteTool(
      call('write_file', { path: 'new.ts', content: 'hello v1' }),
      ctx,
      makeConfig(),
    );
    expect(out).toContain('已写入');

    const e = onlyEntry(entriesOfThisStream());
    // 全字段逐一对（RecordCtx 构造契约：workspaceId/taskId/sessionId/streamSessionId/toolName）
    expect(e.op).toBe('create');
    expect(e.path).toBe('new.ts');
    expect(e.beforeHash).toBeNull();
    expect(e.afterHash).toBe(sha('hello v1'));
    expect(e.oldPath).toBeNull();
    expect(e.workspaceId).toBe('ws-j');
    expect(e.taskId).toBeNull();
    expect(e.sessionId).toBe('!room-j');
    expect(e.streamSessionId).toBe(ctx.streamSessionId);
    expect(e.toolName).toBe('write_file');
    // blob 可读回（撤销恢复用）
    expect(store.readBlob('ws-j', e.afterHash ?? '')).toBe('hello v1');
  });

  it('2) write_file 覆盖（read 后过守门）→ modify 条目 before blob=旧内容', async () => {
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'old-content');
    await doExecuteTool(call('read_file', { path: 'app.ts' }), ctx, makeConfig());
    // read_file 只读不记账——此刻应为零条目（顺带锁只读语义）
    expect(entriesOfThisStream()).toHaveLength(0);

    await doExecuteTool(
      call('write_file', { path: 'app.ts', content: 'new-content' }),
      ctx,
      makeConfig(),
    );
    const e = onlyEntry(entriesOfThisStream());
    expect(e.op).toBe('modify');
    expect(e.beforeHash).toBe(sha('old-content'));
    expect(e.afterHash).toBe(sha('new-content'));
    expect(store.readBlob('ws-j', e.beforeHash ?? '')).toBe('old-content');
    expect(store.readBlob('ws-j', e.afterHash ?? '')).toBe('new-content');
  });

  it('2b) edit_file → modify 条目 before/after 均落 blob', async () => {
    fs.writeFileSync(path.join(tmpDir, 'e.ts'), 'const x = 1;');
    await doExecuteTool(call('read_file', { path: 'e.ts' }), ctx, makeConfig());
    await doExecuteTool(
      call('edit_file', { path: 'e.ts', oldString: 'const x = 1;', newString: 'const x = 2;' }),
      ctx,
      makeConfig(),
    );
    const e = onlyEntry(entriesOfThisStream());
    expect(e.op).toBe('modify');
    expect(e.toolName).toBe('edit_file');
    expect(e.beforeHash).toBe(sha('const x = 1;'));
    expect(e.afterHash).toBe(sha('const x = 2;'));
    expect(store.readBlob('ws-j', e.beforeHash ?? '')).toBe('const x = 1;');
    expect(store.readBlob('ws-j', e.afterHash ?? '')).toBe('const x = 2;');
  });

  it('3) apply_patch update 两文件 → 恰好 2 条 modify（逐文件记账）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'f1.ts'), 'const x = 1;\n');
    fs.writeFileSync(path.join(tmpDir, 'f2.ts'), 'const y = 1;\n');
    const patch = `*** Update File: f1.ts
@@ const x = 1;
-const x = 1;
+const x = 2;
*** Update File: f2.ts
@@ const y = 1;
-const y = 1;
+const y = 2;
`;
    const out = await doExecuteTool(call('apply_patch', { patch }), ctx, makeConfig());
    expect(out).toContain('已应用 2 个文件');

    const entries = entriesOfThisStream();
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.op === 'modify' && e.toolName === 'apply_patch')).toBe(true);
    const byPath = new Map(entries.map((e) => [e.path, e]));
    const f1 = byPath.get('f1.ts');
    const f2 = byPath.get('f2.ts');
    expect(f1?.beforeHash).toBe(sha('const x = 1;\n'));
    expect(f1?.afterHash).toBe(sha('const x = 2;\n'));
    expect(f2?.beforeHash).toBe(sha('const y = 1;\n'));
    expect(f2?.afterHash).toBe(sha('const y = 2;\n'));
    expect(store.readBlob('ws-j', f1?.beforeHash ?? '')).toBe('const x = 1;\n');
  });

  it('4) rm 单文件 → delete 条目；rm 目录 → 逐文件 delete（recordDeleteTree）', async () => {
    // 单文件
    fs.writeFileSync(path.join(tmpDir, 'gone.ts'), 'to-be-deleted');
    await doExecuteTool(call('rm', { path: 'gone.ts' }), ctx, makeConfig());
    const e = onlyEntry(entriesOfThisStream());
    expect(e.op).toBe('delete');
    expect(e.path).toBe('gone.ts');
    expect(e.beforeHash).toBe(sha('to-be-deleted'));
    expect(e.afterHash).toBeNull();
    expect(store.readBlob('ws-j', e.beforeHash ?? '')).toBe('to-be-deleted');

    // 目录（tree）：下一测 streamSessionId 不同——用独立断言集
    const ssn2 = `ssn-${randomUUID()}`;
    ctx.streamSessionId = ssn2;
    fs.mkdirSync(path.join(tmpDir, 'sub', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'sub', 'a.ts'), 'A');
    fs.writeFileSync(path.join(tmpDir, 'sub', 'nested', 'b.ts'), 'B');
    await doExecuteTool(call('rm', { path: 'sub' }), ctx, makeConfig());
    const treeEntries = store.listByStream('ws-j', ssn2);
    expect(treeEntries).toHaveLength(2);
    const paths = treeEntries.map((x) => x.path).sort();
    expect(paths).toEqual(['sub/a.ts', 'sub/nested/b.ts']);
    expect(treeEntries.every((x) => x.op === 'delete' && x.toolName === 'rm')).toBe(true);
  });

  it('4b) mv → rename 条目 old_path 正确；目标已存在叠一条 modify 且时序在 rename 前', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src.ts'), 'SRC');
    await doExecuteTool(call('mv', { src: 'src.ts', dst: 'dst.ts' }), ctx, makeConfig());
    const e = onlyEntry(entriesOfThisStream());
    expect(e.op).toBe('rename');
    expect(e.path).toBe('dst.ts');
    expect(e.oldPath).toBe('src.ts');
    expect(e.beforeHash).toBe(sha('SRC'));
    expect(e.afterHash).toBeNull();
    expect(store.readBlob('ws-j', e.beforeHash ?? '')).toBe('SRC');
  });

  it('4c) mv 覆盖已存在目标 → 先 modify（目标旧内容）后 rename（撤销逆序端态正确）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src2.ts'), 'S2');
    fs.writeFileSync(path.join(tmpDir, 'dst2.ts'), 'D2-OLD');
    await doExecuteTool(call('mv', { src: 'src2.ts', dst: 'dst2.ts' }), ctx, makeConfig());
    const entries = entriesOfThisStream();
    expect(entries).toHaveLength(2);
    const [modifyDst, renameMain] = entries;
    // 记账顺序：modify 目标旧内容在前（createdAt 更小）→ 撤销 created_at DESC 先逆
    // rename（dst 移回 src）再逆 modify（重建 dst 旧内容），端态双文件均正确
    expect(modifyDst?.op).toBe('modify');
    expect(modifyDst?.path).toBe('dst2.ts');
    expect(modifyDst?.beforeHash).toBe(sha('D2-OLD'));
    expect(modifyDst?.afterHash).toBe(sha('S2'));
    expect(renameMain?.op).toBe('rename');
    expect(renameMain?.path).toBe('dst2.ts');
    expect(renameMain?.oldPath).toBe('src2.ts');
    expect(modifyDst && renameMain && modifyDst.createdAt < renameMain.createdAt).toBe(true);
  });

  it('5) read_file / list_files / grep 只读 → 零条目（只读不记账）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ro.ts'), 'needle here');
    await doExecuteTool(call('read_file', { path: 'ro.ts' }), ctx, makeConfig());
    await doExecuteTool(call('list_files', { path: '.' }), ctx, makeConfig());
    await doExecuteTool(call('grep', { pattern: 'needle' }), ctx, makeConfig());
    expect(entriesOfThisStream()).toHaveLength(0);
    expect(store.countAll()).toBe(0);
  });

  it('6) config.currentTaskId → 条目 taskId 命中；缺省 → null（快速会话）', async () => {
    // 有任务：doExecuteTool 从 config.currentTaskId 注入 toolCtx.taskId（删该注入本用例变红）
    await doExecuteTool(
      call('write_file', { path: 'with-task.ts', content: 'x' }),
      ctx,
      makeConfig({ currentTaskId: 'T-42' }),
    );
    let entries = entriesOfThisStream();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.taskId).toBe('T-42');

    // 无任务（快速会话）：taskId 归一为 null
    const ssn2 = `ssn-${randomUUID()}`;
    ctx.streamSessionId = ssn2;
    await doExecuteTool(
      call('write_file', { path: 'no-task.ts', content: 'y' }),
      ctx,
      makeConfig(),
    );
    entries = store.listByStream('ws-j', ssn2);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.taskId).toBeNull();
  });

  it('7) 降级：store 未注入 → 记账跳过但工具执行成功（安全网不变故障点）', async () => {
    __setJournalStoreForTest(null);
    await expect(
      doExecuteTool(call('write_file', { path: 'degraded.ts', content: 'still works' }), ctx, makeConfig()),
    ).resolves.toContain('已写入');
    expect(fs.readFileSync(path.join(tmpDir, 'degraded.ts'), 'utf-8')).toBe('still works');
    expect(store.countAll()).toBe(0);
  });

  it('8) __setJournalEnabledForTest(false) 逃逸阀 → 零条目且写成功', async () => {
    __setJournalEnabledForTest(false);
    await expect(
      doExecuteTool(call('write_file', { path: 'escaped.ts', content: 'no journal' }), ctx, makeConfig()),
    ).resolves.toContain('已写入');
    expect(store.countAll()).toBe(0);
  });
});
