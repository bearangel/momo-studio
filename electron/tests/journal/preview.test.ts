// electron/tests/journal/preview.test.ts
//
// journal preview 干跑预检测试（变更回滚重构，spec 2026-09-28 §5.1 / D2 / D3）。
//
// fixture 照 tests/journal/revert.test.ts：真实库 + 真实 store + 真实 workspace
// 目录；条目一律经真实 recordChange 生产（先记账后写盘的 §5.3 生产语义）。
//
// 断言清单：
//   1) 同文件三版本链全绿：磁盘 = 末版 → 全部 predicted 'reverted'（链式虚拟态，
//      旧条目看到「撤回后」状态而非当前盘面——D3 核心）
//   2) 磁盘漂移：该 path 全部条目 predicted 'skipped-diverged'（虚拟态不变）
//   3) rename 链：moveBack 迁移两侧虚拟态——create 条目预测 'reverted' 而非
//      独立判定的 'no-op'（真实盘面旧路径不存在）
//   4) 无副作用：预检后文件内容不变、条目数不变、blob 字节数不变（不写盘不记账）
//   5) 预检-执行对齐：同批 ids，preview 结果 == revertEntries(force=false) 结果
//      （契约对齐——两路共用 classify 的漂移锁）
//   6) 错误路径：空 ids → []；不存在 id → no-op；before blob 缺失 → failed（停组）
//   7) restore 预测：modify 后文件被删 → predicted 'restored-missing'
//

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { createJournalStore } from '../../src/main/journal/store';
import type { JournalStore } from '../../src/main/journal/store';
import {
  recordChange,
  __setJournalStoreForTest,
} from '../../src/main/journal/recorder';
import type { RecordCtx } from '../../src/main/journal/recorder';
import { previewRevert, revertEntries } from '../../src/main/journal/revert';
import type { JournalEntry } from '../../src/main/journal/types';

const tmpRoot = path.join(os.tmpdir(), `ap-journal-preview-${process.pid}-${Date.now()}`);
let store: JournalStore;
let wsDir: string;

beforeEach(() => {
  fsSync.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  store = createJournalStore(getDb());
  __setJournalStoreForTest(store);
  wsDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ap-journal-preview-ws-'));
});

afterEach(() => {
  __setJournalStoreForTest(null);
  closeDb();
  fsSync.rmSync(tmpRoot, { recursive: true, force: true });
  fsSync.rmSync(wsDir, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function ctxOf(overrides: Partial<RecordCtx> = {}): RecordCtx {
  return {
    workspaceId: 'ws-A',
    taskId: 'T-1',
    sessionId: 'sess-1',
    streamSessionId: 'stream-1',
    toolName: 'write_file',
    ...overrides,
  };
}

/** 工具层「先记账后写盘」仿真（§5.3 生产语义） */
function journaledCreate(rc: RecordCtx, rel: string, content: string): JournalEntry {
  const e = recordChange(rc, rel, 'create', null, content);
  fsSync.mkdirSync(path.dirname(path.join(wsDir, rel)), { recursive: true });
  fsSync.writeFileSync(path.join(wsDir, rel), content, 'utf8');
  return e;
}

function journaledModify(
  rc: RecordCtx,
  rel: string,
  before: string,
  after: string,
): JournalEntry {
  const e = recordChange(rc, rel, 'modify', before, after);
  fsSync.writeFileSync(path.join(wsDir, rel), after, 'utf8');
  return e;
}

function journaledRename(rc: RecordCtx, from: string, to: string, content: string): JournalEntry {
  const e = recordChange(rc, to, 'rename', content, null, from);
  fsSync.renameSync(path.join(wsDir, from), path.join(wsDir, to));
  return e;
}

describe('journal preview：链式虚拟状态模拟（D3）', () => {
  it('同文件三版本链全绿：磁盘 = 末版 → 全部 predicted reverted（旧条目看到撤回后状态）', async () => {
    const rc = ctxOf();
    const eCreate = journaledCreate(rc, 'src/a.ts', 'v0');
    const eMod1 = journaledModify(rc, 'src/a.ts', 'v0', 'v1');
    const eMod2 = journaledModify(rc, 'src/a.ts', 'v1', 'v2');
    expect(fsSync.readFileSync(path.join(wsDir, 'src/a.ts'), 'utf8')).toBe('v2');

    const outcomes = await previewRevert('ws-A', wsDir, [eCreate.id, eMod1.id, eMod2.id]);
    // 执行序 = 逆序：eMod2 → eMod1 → eCreate，逐条 reverted
    expect(outcomes.map((o) => o.result)).toEqual(['reverted', 'reverted', 'reverted']);
    expect(outcomes.map((o) => o.id)).toEqual([eMod2.id, eMod1.id, eCreate.id]);
    // 预检不动盘面
    expect(fsSync.readFileSync(path.join(wsDir, 'src/a.ts'), 'utf8')).toBe('v2');
  });

  it('磁盘漂移：该 path 全部条目 predicted skipped-diverged（虚拟态不变，逐步拦截）', async () => {
    const rc = ctxOf();
    const eCreate = journaledCreate(rc, 'src/a.ts', 'v0');
    const eMod1 = journaledModify(rc, 'src/a.ts', 'v0', 'v1');
    const eMod2 = journaledModify(rc, 'src/a.ts', 'v1', 'v2');
    // 漂移：任务结束后被手改
    fsSync.writeFileSync(path.join(wsDir, 'src/a.ts'), 'v3-manual', 'utf8');

    const outcomes = await previewRevert('ws-A', wsDir, [eCreate.id, eMod1.id, eMod2.id]);
    expect(outcomes.map((o) => o.result)).toEqual([
      'skipped-diverged',
      'skipped-diverged',
      'skipped-diverged',
    ]);
    expect(fsSync.readFileSync(path.join(wsDir, 'src/a.ts'), 'utf8')).toBe('v3-manual');
  });

  it('rename 链：moveBack 迁移两侧虚拟态——create 预测 reverted 而非独立判定的 no-op', async () => {
    const rc = ctxOf();
    const eCreate = journaledCreate(rc, 'src/a.ts', 'X');
    const eRename = journaledRename(rc, 'src/a.ts', 'src/b.ts', 'X');
    expect(fsSync.existsSync(path.join(wsDir, 'src/a.ts'))).toBe(false);

    const outcomes = await previewRevert('ws-A', wsDir, [eCreate.id, eRename.id]);
    // 逆序：rename 先（moveBack 虚拟迁移 a←X）→ create 看到 a.ts 虚拟存在且 hash 匹配
    // → deleteFile 预测 reverted。独立判定（读真实盘面 a.ts 不存在）会误报 no-op——
    // 本用例正是 D3 的回归锁
    expect(outcomes.map((o) => o.id)).toEqual([eRename.id, eCreate.id]);
    expect(outcomes.map((o) => o.result)).toEqual(['reverted', 'reverted']);
    // 盘面不动：b.ts 仍在、a.ts 仍未复现
    expect(fsSync.readFileSync(path.join(wsDir, 'src/b.ts'), 'utf8')).toBe('X');
    expect(fsSync.existsSync(path.join(wsDir, 'src/a.ts'))).toBe(false);
  });

  it('restore 预测：modify 后文件被删 → predicted restored-missing', async () => {
    const rc = ctxOf();
    const eCreate = journaledCreate(rc, 'src/a.ts', 'v0');
    const eMod = journaledModify(rc, 'src/a.ts', 'v0', 'v1');
    fsSync.rmSync(path.join(wsDir, 'src/a.ts'));

    const outcomes = await previewRevert('ws-A', wsDir, [eCreate.id, eMod.id]);
    expect(outcomes.map((o) => o.result)).toEqual(['restored-missing', 'reverted']);
    // eMod 预测「重建缺失」（writeBefore 虚拟重建 v0）→ eCreate 在虚拟态上看到
    // a.ts 存在且 hash 匹配 → 预测撤回（删除动作）；盘面不动
    expect(fsSync.existsSync(path.join(wsDir, 'src/a.ts'))).toBe(false);
  });
});

describe('journal preview：无副作用（不写盘不记账）', () => {
  it('预检后文件内容/条目数/blob 字节均不变', async () => {
    const rc = ctxOf();
    const eCreate = journaledCreate(rc, 'src/a.ts', 'v0');
    const eMod = journaledModify(rc, 'src/a.ts', 'v0', 'v1');
    const countBefore = store.countAll();
    const bytesBefore = store.sumBlobBytes();

    await previewRevert('ws-A', wsDir, [eCreate.id, eMod.id]);

    expect(fsSync.readFileSync(path.join(wsDir, 'src/a.ts'), 'utf8')).toBe('v1');
    expect(store.countAll()).toBe(countBefore);
    expect(store.sumBlobBytes()).toBe(bytesBefore);
  });
});

describe('journal preview：预检-执行对齐（D2/D3 契约锁）', () => {
  it('同批 ids：preview 结果 == revertEntries(force=false) 结果（全绿链）', async () => {
    const rc = ctxOf();
    const eCreate = journaledCreate(rc, 'src/a.ts', 'v0');
    const eMod = journaledModify(rc, 'src/a.ts', 'v0', 'v1');

    const preview = await previewRevert('ws-A', wsDir, [eCreate.id, eMod.id]);
    // 执行走真实撤销（不带 recorderCtx，跳过对称记账——对齐比较只看 outcome）
    const executed = await revertEntries('ws-A', wsDir, [eCreate.id, eMod.id], {});
    expect(preview).toEqual(executed);
  });

  it('同批 ids：漂移场景 preview == 执行（逐步拦截）', async () => {
    const rc = ctxOf();
    const eCreate = journaledCreate(rc, 'src/a.ts', 'v0');
    journaledModify(rc, 'src/a.ts', 'v0', 'v1');
    fsSync.writeFileSync(path.join(wsDir, 'src/a.ts'), 'drift', 'utf8');

    const preview = await previewRevert('ws-A', wsDir, [eCreate.id]);
    const executed = await revertEntries('ws-A', wsDir, [eCreate.id], {});
    expect(preview).toEqual(executed);
  });
});

describe('journal preview：错误路径', () => {
  it('空 ids → 空数组', async () => {
    expect(await previewRevert('ws-A', wsDir, [])).toEqual([]);
  });

  it('不存在 id → no-op + 条目不存在 detail', async () => {
    const outcomes = await previewRevert('ws-A', wsDir, ['je_404']);
    expect(outcomes).toEqual([
      { id: 'je_404', path: '', result: 'no-op', detail: '条目不存在（可能已被配额清理）' },
    ]);
  });

  it('before blob 缺失 → failed 且停该 path 组', async () => {
    const rc = ctxOf();
    const eCreate = journaledCreate(rc, 'src/a.ts', 'v0');
    const eMod = journaledModify(rc, 'src/a.ts', 'v0', 'v1');
    // 物理删除 before blob（v0）——restore/writeBefore 路径 fetch 失败
    const blobDir = path.join(tmpRoot, 'journal', 'ws-A', 'objects', eMod.beforeHash!.slice(0, 2));
    const blobFile = path.join(blobDir, eMod.beforeHash!);
    fsSync.rmSync(blobFile);

    // 磁盘完好（v1）→ modify 正常撤回需要 before blob → failed；其后的 create 同 path 停组
    const outcomes = await previewRevert('ws-A', wsDir, [eCreate.id, eMod.id]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.result).toBe('failed');
    expect(outcomes[0]!.detail).toMatch(/before 内容 blob 缺失/);
    expect(fsSync.readFileSync(path.join(wsDir, 'src/a.ts'), 'utf8')).toBe('v1');
  });
});
