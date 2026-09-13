// electron/tests/agent/tools/journal-orphan-create.test.ts
//
// 孤儿 create 条目撤回语义锁（审查 QA 建议，v2.5 崩溃一致性安全方向验证）。
//
// 场景（真实生产链路，不 mock 工具层）：apply_patch 多文件原子执行中，
// op1=add 新文件成功（写前已记账 create），op2=update 因 hunk 不匹配失败 →
// 整体回滚删除新文件，但账本条目不删（write-ahead 纪律）→ 账本留下
// 「create 条目 × 文件不存在」的孤儿。此后用户对该条目 revertEntries：
//   - revertOne case 'create'：current === null → no-op（文件未生效或已被还原）
//     ——安全方向：绝不凭空删文件、不报失败、不误触对称记账。
//
// 接线形态照 journal-wiring.test.ts：真实 buildToolRegistry + 真实 WorkspaceFS
// + 真实 SQLite（runMigrations + createJournalStore）+ doExecuteTool 生产路由
// 入口；仅 mock electron.app.getPath（回滚备份目录）这一进程边界。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import { buildToolRegistry } from '../../../src/main/agent/tools';
import type { LLMToolCall } from '../../../src/main/agent/llm-provider';
import type { RuntimeConfig } from '../../../src/main/agent/runtime-config';
import { doExecuteTool, type RuntimeContext } from '../../../src/main/agent/runtime-entry';
import { runMigrations, closeDb, getDb } from '../../../src/main/storage/db';
import { createJournalStore, type JournalStore } from '../../../src/main/journal/store';
import { __setJournalStoreForTest } from '../../../src/main/journal/recorder';
import { revertEntries } from '../../../src/main/journal/revert';
import type { JournalEntry } from '../../../src/main/journal/types';

// 回滚备份目录走 app.getPath('userData')——仓库标准 vi.mock('electron') 模式
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

const udRoot = path.join(os.tmpdir(), `momo-v25-orphan-ud-${Date.now()}`);

let tmpDir: string;
let ctx: RuntimeContext;
let store: JournalStore;

function call(name: string, args: Record<string, unknown>): LLMToolCall {
  return { id: `call-${randomUUID()}`, name, arguments: args };
}

function makeConfig(): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-bot',
    agentUserId: '@bot:localhost',
    systemPrompt: '',
    modelName: 'test',
    llmApiKey: 'k',
    workspaceDir: tmpDir,
    workspaceId: 'ws-orphan',
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
  };
}

beforeEach(() => {
  fs.mkdirSync(udRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = udRoot;
  runMigrations();
  store = createJournalStore(getDb());
  __setJournalStoreForTest(store);

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-v25-orphan-ws-'));
  const wsFs = new WorkspaceFS(tmpDir);
  const skillRegistry = { list: () => [] } as never;
  const sendStreamChunk = () => {};
  const sharedToolCtxFields = {
    wsFs,
    workspaceId: 'ws-orphan',
    workspaceDir: tmpDir,
    skillRegistry,
    streamSessionId: `ssn-${randomUUID()}`,
    roomId: '!room-orphan',
    sendStreamChunk,
    permissionConfig: { allowedTools: [] as string[], deniedTools: [] as string[] },
    creatorUserId: 'test-user',
  };
  ctx = {
    wsFs,
    skillRegistry,
    tools: [],
    systemPrompt: '',
    workspaceId: 'ws-orphan',
    workspaceDir: tmpDir,
    roomId: '!room-orphan',
    streamSessionId: sharedToolCtxFields.streamSessionId,
    sendStreamChunk,
    creatorUserId: 'test-user',
    toolModules: buildToolRegistry(sharedToolCtxFields),
  };
});

afterEach(() => {
  __setJournalStoreForTest(null);
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(udRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('孤儿 create 条目撤回 no-op 语义（apply_patch 失败回滚真实链路）', () => {
  it('add 成功 + update 失败 → 回滚删新文件但条目留存 → revertEntries 判 no-op（安全方向）', async () => {
    // 既有文件（op2 的 update 目标；anchor 故意写错使其失败）
    fs.writeFileSync(path.join(tmpDir, 'keep.ts'), 'const stable = 1;\n');
    const patch = `*** Add File: born-to-die.ts
+const transient = true;
*** Update File: keep.ts
@@ 不存在的 anchor
-const stable = 1;
+const stable = 2;
`;

    // 生产路由真实执行：add 记账+落盘成功 → update hunk anchor 未命中抛错 → 整体回滚
    await expect(
      doExecuteTool(call('apply_patch', { patch }), ctx, makeConfig()),
    ).rejects.toThrow(/apply_patch 失败，已回滚/);

    // 回滚现场：新文件已删（磁盘不存在），既有文件内容原样
    expect(fs.existsSync(path.join(tmpDir, 'born-to-die.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, 'keep.ts'), 'utf-8')).toBe('const stable = 1;\n');

    // 账本留存孤儿 create 条目（write-ahead：记账先于执行，回滚不删条目）
    const entries = store.listByStream('ws-orphan', ctx.streamSessionId);
    const orphan = entries.find((e) => e.path === 'born-to-die.ts');
    expect(orphan).toBeDefined();
    expect(orphan?.op).toBe('create');
    expect(orphan?.toolName).toBe('apply_patch');

    // 语义锁：孤儿 create 撤回 → no-op + 明示 detail，文件仍不存在、不产生对称条目
    const before = store.listByStream('ws-orphan', ctx.streamSessionId).length;
    const outcomes = await revertEntries('ws-orphan', tmpDir, [orphan!.id]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ id: orphan!.id, path: 'born-to-die.ts', result: 'no-op' });
    expect(outcomes[0]?.detail).toContain('文件不存在');
    expect(fs.existsSync(path.join(tmpDir, 'born-to-die.ts'))).toBe(false);
    expect(store.listByStream('ws-orphan', ctx.streamSessionId)).toHaveLength(before);
  });

  it('孤儿 create 幂等：二次 revertEntries 同条目仍 no-op', async () => {
    fs.writeFileSync(path.join(tmpDir, 'k2.ts'), 'x\n');
    const patch = `*** Add File: orphan2.ts
+content
*** Update File: k2.ts
@@ 错 anchor
-x
+y
`;
    await expect(
      doExecuteTool(call('apply_patch', { patch }), ctx, makeConfig()),
    ).rejects.toThrow(/apply_patch 失败，已回滚/);
    const orphan = store
      .listByStream('ws-orphan', ctx.streamSessionId)
      .find((e): e is JournalEntry => e.path === 'orphan2.ts');

    const first = await revertEntries('ws-orphan', tmpDir, [orphan!.id]);
    const second = await revertEntries('ws-orphan', tmpDir, [orphan!.id]);
    expect(first[0]?.result).toBe('no-op');
    expect(second[0]?.result).toBe('no-op');
  });
});
