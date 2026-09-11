// electron/tests/journal/revert.test.ts
//
// journal revert 测试：撤销核心（hash 守卫 + 逆序链 + 对称记账，v2.5 Task 3）。
//
// fixture 照 tests/journal/recorder.test.ts：
//   - tmpRoot 作为 AP_USER_DATA_DIR（blob 落盘走 resolveUserDataDir）
//   - runMigrations() 真实建库 + __setJournalStoreForTest 注入真实 store
//   - 真实临时 workspace 目录（wsDir），文件操作走真实 fs
//
// 铁律执行（momo-test-rules）：
//   - 条目一律经真实 recordChange 生产（生产者真实产出 → 消费者直接消费，铁律 4）；
//     journaled* 辅助函数仿真工具层「先记账后写盘」的 §5.3 生产语义
//   - 错误路径专项用例：空 ids / 不存在 id / 跨 workspace / blob 缺失 / 路径越界 /
//     rename 缺 oldPath / 读文件 EISDIR / 写回阶段 mkdir EEXIST 停组（铁律 3）
//   - 不 mock fs / store——失败注入用真实文件系统状态（目录占位 / 脏条目手插真实 store）
//
// 断言清单（plan Task 3 Step 1 九分支）：
//   1) modify 正常撤回：hash(after) 匹配 → 写回 before，文件内容断言
//   2) create 撤回 → 文件删除
//   3) delete 撤回 → 重建 before 内容（restored-missing 单独场景：modify 后文件被删 → 重建）
//   4) rename 撤回 → 移回 old_path（目标已存在叠加警告 detail，继续执行）
//   5) hash 漂移：默认 skipped-diverged；force=true → 写回 before
//   6) 交叉逆序：revertEntries([A,B]) → B 先 A 后（终态 = A.before）；单撤 A → skipped-diverged
//   7) 孤儿条目：记账后未写盘（before==当前）→ no-op
//   8) 对称记账：每次撤回产生逆条目（listByPath 计数 +1），撤销的撤销可再执行
//   9) 失败传播：写回阶段抛错 → failed，组内停该文件，其他 path 组继续
//
// 对称记账上下文：undoRc 的 toolName 故意不是 'undo'——锁「实现层强制改写 toolName='undo'
// 且其余 ctx 字段透传」的契约。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { createJournalStore } from '../../src/main/journal/store';
import type { JournalStore } from '../../src/main/journal/store';
import {
  hashContent,
  recordChange,
  __setJournalStoreForTest,
} from '../../src/main/journal/recorder';
import type { RecordCtx } from '../../src/main/journal/recorder';
import { revertEntries } from '../../src/main/journal/revert';
import type { JournalEntry } from '../../src/main/journal/types';

const tmpRoot = path.join(os.tmpdir(), `ap-journal-revert-${process.pid}-${Date.now()}`);
let store: JournalStore;
let wsDir: string;

beforeEach(() => {
  fsSync.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  store = createJournalStore(getDb());
  __setJournalStoreForTest(store);
  wsDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ap-journal-ws-'));
});

afterEach(() => {
  __setJournalStoreForTest(null);
  closeDb();
  fsSync.rmSync(tmpRoot, { recursive: true, force: true });
  fsSync.rmSync(wsDir, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 标准 RecordCtx 工厂 */
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

/** 撤销调用的对称记账 ctx（toolName 故意非 undo，锁实现层改写契约） */
function undoRcOf(stream = 'stream-undo'): RecordCtx {
  return ctxOf({ streamSessionId: stream, toolName: 'edit_file' });
}

function wsPath(rel: string): string {
  return path.join(wsDir, rel);
}

function writeWs(rel: string, content: string): void {
  fsSync.mkdirSync(path.dirname(wsPath(rel)), { recursive: true });
  fsSync.writeFileSync(wsPath(rel), content, 'utf8');
}

function readWs(rel: string): string {
  return fsSync.readFileSync(wsPath(rel), 'utf8');
}

function existsWs(rel: string): boolean {
  return fsSync.existsSync(wsPath(rel));
}

// ---- 工具层「先记账后写盘」仿真（§5.3 生产语义，铁律 4 契约测试）----

function journaledCreate(rc: RecordCtx, rel: string, content: string): JournalEntry {
  const e = recordChange(rc, rel, 'create', null, content);
  writeWs(rel, content);
  return e;
}

function journaledModify(rc: RecordCtx, rel: string, before: string, after: string): JournalEntry {
  const e = recordChange(rc, rel, 'modify', before, after);
  writeWs(rel, after);
  return e;
}

function journaledDelete(rc: RecordCtx, rel: string, content: string): JournalEntry {
  const e = recordChange(rc, rel, 'delete', content, null);
  fsSync.rmSync(wsPath(rel));
  return e;
}

function journaledRename(rc: RecordCtx, oldRel: string, newRel: string, content: string): JournalEntry {
  const e = recordChange({ ...rc, toolName: 'mv' }, newRel, 'rename', content, null, oldRel);
  fsSync.mkdirSync(path.dirname(wsPath(newRel)), { recursive: true });
  fsSync.renameSync(wsPath(oldRel), wsPath(newRel));
  return e;
}

/** 手工插脏条目（绕过 recorder，构造契约不可达的异常数据——防御分支专项） */
let dirtySeq = 0;
function insertDirtyEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  dirtySeq += 1;
  const e: JournalEntry = {
    id: `je_dirty-${dirtySeq}`,
    workspaceId: 'ws-A',
    taskId: null,
    sessionId: null,
    streamSessionId: 'stream-dirty',
    toolName: 'write_file',
    path: 'dirty.txt',
    op: 'modify',
    beforeHash: hashContent('dirty-before'),
    afterHash: hashContent('dirty-after'),
    oldPath: null,
    createdAt: 1_000_000 + dirtySeq,
    ...overrides,
  };
  store.insert(e);
  return e;
}

// ============================================================
// 分支 1：modify 正常撤回（+ 分支 8 对称记账字段）
// ============================================================
describe('modify 撤回', () => {
  it('hash(after) 匹配 → 写回 before；对称条目 op=modify toolName=undo（计数 +1）', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-m1' });
    journaledCreate(rc, 'f.ts', 'v0');
    const m = journaledModify(rc, 'f.ts', 'v0', 'v1');
    expect(store.listByPath('ws-A', 'f.ts')).toHaveLength(2);

    const outcomes = await revertEntries('ws-A', wsDir, [m.id], { recorderCtx: undoRcOf() });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ id: m.id, path: 'f.ts', result: 'reverted' });
    expect(readWs('f.ts')).toBe('v0');

    // 对称条目：listByPath 计数 +1；逆 op = modify；before=当前(v1) after=写回(v0)
    const entries = store.listByPath('ws-A', 'f.ts');
    expect(entries).toHaveLength(3);
    const undoEntry = entries.find((e) => e.toolName === 'undo');
    expect(undoEntry).toBeDefined();
    expect(undoEntry?.op).toBe('modify');
    expect(undoEntry?.path).toBe('f.ts');
    expect(undoEntry?.beforeHash).toBe(hashContent('v1'));
    expect(undoEntry?.afterHash).toBe(hashContent('v0'));
    // ctx 其余字段透传（归组键落在撤销动作自己的 stream 上）
    expect(undoEntry?.streamSessionId).toBe('stream-undo');
    expect(undoEntry?.taskId).toBe('T-1');
  });

  it('分支 7：孤儿条目（记账后未写盘，before==当前）→ no-op，不产生对称条目', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-m2' });
    journaledCreate(rc, 'f.ts', 'v0');
    // 只记账不写盘（模拟记账后、写盘前中断——spec 崩溃一致性场景）
    const orphan = recordChange(rc, 'f.ts', 'modify', 'v0', 'v1');
    expect(readWs('f.ts')).toBe('v0');

    const outcomes = await revertEntries('ws-A', wsDir, [orphan.id], { recorderCtx: undoRcOf() });

    expect(outcomes[0]).toMatchObject({ id: orphan.id, result: 'no-op' });
    expect(readWs('f.ts')).toBe('v0');
    // no-op 不写盘 → 无对称条目
    expect(store.listByPath('ws-A', 'f.ts')).toHaveLength(2);
  });

  it('分支 3 之 restored-missing 单列：modify 后文件被删 → 重建 before 内容', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-m3' });
    journaledCreate(rc, 'f.ts', 'v0');
    const m = journaledModify(rc, 'f.ts', 'v0', 'v1');
    fsSync.rmSync(wsPath('f.ts')); // 记账后被手动删除

    const outcomes = await revertEntries('ws-A', wsDir, [m.id], { recorderCtx: undoRcOf() });

    expect(outcomes[0]).toMatchObject({ id: m.id, result: 'restored-missing' });
    expect(existsWs('f.ts')).toBe(true);
    expect(readWs('f.ts')).toBe('v0');
    // 对称条目：实际动作是重建文件 → op=create before=null after=v0
    const undoEntry = store.listByPath('ws-A', 'f.ts').find((e) => e.toolName === 'undo');
    expect(undoEntry?.op).toBe('create');
    expect(undoEntry?.beforeHash).toBeNull();
    expect(undoEntry?.afterHash).toBe(hashContent('v0'));
  });

  it('父目录也被删时重建（mkdir recursive）', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-m4' });
    journaledCreate(rc, path.join('sub', 'f.ts'), 'v0');
    const m = journaledModify(rc, path.join('sub', 'f.ts'), 'v0', 'v1');
    fsSync.rmSync(wsPath(path.join('sub', 'f.ts')));
    fsSync.rmdirSync(wsPath('sub'));

    const outcomes = await revertEntries('ws-A', wsDir, [m.id], { recorderCtx: undoRcOf() });

    expect(outcomes[0]?.result).toBe('restored-missing');
    expect(readWs(path.join('sub', 'f.ts'))).toBe('v0');
  });
});

// ============================================================
// 分支 2：create 撤回 → 删文件
// ============================================================
describe('create 撤回', () => {
  it('hash(after) 匹配 → 文件删除；对称条目 op=delete before=当前内容', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-c1' });
    const c = journaledCreate(rc, 'new.ts', 'brand new');

    const outcomes = await revertEntries('ws-A', wsDir, [c.id], { recorderCtx: undoRcOf() });

    expect(outcomes[0]).toMatchObject({ id: c.id, result: 'reverted' });
    expect(existsWs('new.ts')).toBe(false);

    const undoEntry = store.listByPath('ws-A', 'new.ts').find((e) => e.toolName === 'undo');
    expect(undoEntry?.op).toBe('delete');
    expect(undoEntry?.beforeHash).toBe(hashContent('brand new'));
    expect(undoEntry?.afterHash).toBeNull();
  });

  it('create 后内容漂移 → 默认 skipped-diverged；force → 删除漂移文件 + 强制 detail', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-c2' });
    const c = journaledCreate(rc, 'new.ts', 'v1');
    writeWs('new.ts', 'drifted'); // 记账后被他人修改

    const skipped = await revertEntries('ws-A', wsDir, [c.id], { recorderCtx: undoRcOf() });
    expect(skipped[0]).toMatchObject({ id: c.id, result: 'skipped-diverged' });
    expect(readWs('new.ts')).toBe('drifted');

    const forced = await revertEntries('ws-A', wsDir, [c.id], {
      force: true,
      recorderCtx: undoRcOf(),
    });
    expect(forced[0]).toMatchObject({ id: c.id, result: 'reverted' });
    expect(forced[0]?.detail).toContain('强制');
    expect(existsWs('new.ts')).toBe(false);
    // force 删除的对称条目 before=漂移内容（撤销的撤销可还原漂移现场）
    const undoEntry = store.listByPath('ws-A', 'new.ts').find((e) => e.toolName === 'undo');
    expect(undoEntry?.op).toBe('delete');
    expect(undoEntry?.beforeHash).toBe(hashContent('drifted'));
  });

  it('分支 7：create 孤儿（记账后文件未创建）→ no-op', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-c3' });
    const c = recordChange(rc, 'ghost.ts', 'create', null, 'never written');

    const outcomes = await revertEntries('ws-A', wsDir, [c.id], { recorderCtx: undoRcOf() });

    expect(outcomes[0]).toMatchObject({ id: c.id, result: 'no-op' });
    expect(existsWs('ghost.ts')).toBe(false);
    expect(store.listByPath('ws-A', 'ghost.ts')).toHaveLength(1); // 无对称条目
  });
});

// ============================================================
// 分支 3：delete 撤回 → 重建 before（restored-missing）
// ============================================================
describe('delete 撤回', () => {
  it('文件已删（delete 已生效）→ 重建 before 内容，restored-missing；对称条目 op=create', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-d1' });
    journaledCreate(rc, 'f.ts', 'precious');
    const d = journaledDelete(rc, 'f.ts', 'precious');
    expect(existsWs('f.ts')).toBe(false);

    const outcomes = await revertEntries('ws-A', wsDir, [d.id], { recorderCtx: undoRcOf() });

    expect(outcomes[0]).toMatchObject({ id: d.id, result: 'restored-missing' });
    expect(readWs('f.ts')).toBe('precious');

    const undoEntry = store.listByPath('ws-A', 'f.ts').find((e) => e.toolName === 'undo');
    expect(undoEntry?.op).toBe('create');
    expect(undoEntry?.beforeHash).toBeNull();
    expect(undoEntry?.afterHash).toBe(hashContent('precious'));
  });

  it('delete 后文件被重建为其他内容 → 默认 skipped-diverged；force → 写回 before', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-d2' });
    journaledCreate(rc, 'f.ts', 'original');
    const d = journaledDelete(rc, 'f.ts', 'original');
    writeWs('f.ts', 'recreated by someone'); // 删除后被重建（漂移）

    const skipped = await revertEntries('ws-A', wsDir, [d.id], { recorderCtx: undoRcOf() });
    expect(skipped[0]).toMatchObject({ id: d.id, result: 'skipped-diverged' });
    expect(readWs('f.ts')).toBe('recreated by someone');

    const forced = await revertEntries('ws-A', wsDir, [d.id], {
      force: true,
      recorderCtx: undoRcOf(),
    });
    expect(forced[0]).toMatchObject({ id: d.id, result: 'reverted' });
    expect(forced[0]?.detail).toContain('强制');
    expect(readWs('f.ts')).toBe('original');
  });

  it('delete 孤儿（记账后删除未执行，文件仍在）→ no-op', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-d3' });
    journaledCreate(rc, 'f.ts', 'stay');
    const d = recordChange({ ...rc, toolName: 'rm' }, 'f.ts', 'delete', 'stay', null);
    // 不执行删除（模拟中断）
    expect(readWs('f.ts')).toBe('stay');

    const outcomes = await revertEntries('ws-A', wsDir, [d.id], { recorderCtx: undoRcOf() });

    expect(outcomes[0]).toMatchObject({ id: d.id, result: 'no-op' });
    expect(readWs('f.ts')).toBe('stay');
    expect(store.listByPath('ws-A', 'f.ts')).toHaveLength(2); // 无对称条目
  });
});

// ============================================================
// 分支 4：rename 撤回 → 移回 old_path
// ============================================================
describe('rename 撤回', () => {
  it('移回 old_path（含父目录已删 → mkdir 重建）；对称条目 rename 反向 path/oldPath 互换', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-r1' });
    writeWs(path.join('sub', 'old.ts'), 'moved content');
    const r = journaledRename(rc, path.join('sub', 'old.ts'), 'new.ts', 'moved content');
    // 移走后旧目录被删（常见现场）——撤回需重建 sub/
    fsSync.rmdirSync(wsPath('sub'));
    expect(existsWs('new.ts')).toBe(true);

    const outcomes = await revertEntries('ws-A', wsDir, [r.id], { recorderCtx: undoRcOf() });

    expect(outcomes[0]).toMatchObject({ id: r.id, result: 'reverted' });
    expect(existsWs('new.ts')).toBe(false);
    expect(readWs(path.join('sub', 'old.ts'))).toBe('moved content');

    // 对称条目：rename 反向——path=oldPath（新位置），oldPath=path（当前位置）
    const undoEntry = store
      .listByPath('ws-A', path.join('sub', 'old.ts'))
      .find((e) => e.toolName === 'undo');
    expect(undoEntry?.op).toBe('rename');
    expect(undoEntry?.oldPath).toBe('new.ts');
    expect(undoEntry?.beforeHash).toBe(hashContent('moved content'));
    expect(undoEntry?.afterHash).toBeNull();
  });

  it('目标（old_path）已存在 → 继续移回（覆盖）+ detail 警告', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-r2' });
    writeWs('old.ts', 'original');
    const r = journaledRename(rc, 'old.ts', 'new.ts', 'original');
    writeWs('old.ts', 'occupied by other'); // 移回目标被占用

    const outcomes = await revertEntries('ws-A', wsDir, [r.id], { recorderCtx: undoRcOf() });

    expect(outcomes[0]).toMatchObject({ id: r.id, result: 'reverted' });
    expect(outcomes[0]?.detail).toContain('已存在');
    // 继续执行：old.ts 被移回的内容覆盖
    expect(readWs('old.ts')).toBe('original');
    expect(existsWs('new.ts')).toBe(false);
  });

  it('rename 后内容漂移 → 默认 skipped-diverged；force → 强制移回', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-r3' });
    writeWs('old.ts', 'v0');
    const r = journaledRename(rc, 'old.ts', 'new.ts', 'v0');
    writeWs('new.ts', 'v1'); // 移动后被改

    const skipped = await revertEntries('ws-A', wsDir, [r.id], { recorderCtx: undoRcOf() });
    expect(skipped[0]).toMatchObject({ id: r.id, result: 'skipped-diverged' });
    expect(readWs('new.ts')).toBe('v1');

    const forced = await revertEntries('ws-A', wsDir, [r.id], {
      force: true,
      recorderCtx: undoRcOf(),
    });
    expect(forced[0]).toMatchObject({ id: r.id, result: 'reverted' });
    expect(forced[0]?.detail).toContain('强制');
    expect(existsWs('new.ts')).toBe(false);
    expect(readWs('old.ts')).toBe('v1'); // 漂移后的内容被移回（不静默丢内容）
  });

  it('rename 孤儿（移动未执行，文件仍在旧路径）→ no-op 不产生副本', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-r4' });
    writeWs('old.ts', 'still here');
    // 只记账不移动（模拟中断）——path（新路径）不存在
    const r = recordChange({ ...rc, toolName: 'mv' }, 'new.ts', 'rename', 'still here', null, 'old.ts');

    const outcomes = await revertEntries('ws-A', wsDir, [r.id], { recorderCtx: undoRcOf() });

    expect(outcomes[0]).toMatchObject({ id: r.id, result: 'no-op' });
    // 不在 new.ts 造副本，old.ts 原样
    expect(existsWs('new.ts')).toBe(false);
    expect(readWs('old.ts')).toBe('still here');
  });

  it('双侧缺失（新路径不存在且旧路径也无文件）→ 重建 before 到旧路径 restored-missing', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-r5' });
    writeWs('sub/old-deep.ts', 'lost');
    const r = journaledRename(rc, 'sub/old-deep.ts', 'new.ts', 'lost');
    fsSync.rmSync(wsPath('new.ts')); // 新路径文件也没了

    const outcomes = await revertEntries('ws-A', wsDir, [r.id], { recorderCtx: undoRcOf() });

    expect(outcomes[0]).toMatchObject({ id: r.id, result: 'restored-missing' });
    expect(readWs(path.join('sub', 'old-deep.ts'))).toBe('lost');
  });
});

// ============================================================
// 分支 5 + 6：hash 漂移 / 交叉逆序（modify 主场景）
// ============================================================
describe('hash 漂移与交叉逆序', () => {
  it('分支 5：modify 漂移默认 skipped-diverged（文件保持漂移内容，无对称条目）', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-x1' });
    journaledCreate(rc, 'f.ts', 'v0');
    const m = journaledModify(rc, 'f.ts', 'v0', 'v1');
    writeWs('f.ts', 'v2-manual'); // 记账后手动改

    const outcomes = await revertEntries('ws-A', wsDir, [m.id], { recorderCtx: undoRcOf() });

    expect(outcomes[0]).toMatchObject({ id: m.id, result: 'skipped-diverged' });
    expect(readWs('f.ts')).toBe('v2-manual');
    expect(store.listByPath('ws-A', 'f.ts')).toHaveLength(2); // 无对称条目
  });

  it('分支 5：force=true → 写回 before；对称条目 before=漂移内容（可再撤回还原现场）', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-x2' });
    journaledCreate(rc, 'f.ts', 'v0');
    const m = journaledModify(rc, 'f.ts', 'v0', 'v1');
    writeWs('f.ts', 'v2-manual');

    const outcomes = await revertEntries('ws-A', wsDir, [m.id], {
      force: true,
      recorderCtx: undoRcOf(),
    });

    expect(outcomes[0]).toMatchObject({ id: m.id, result: 'reverted' });
    expect(outcomes[0]?.detail).toContain('强制');
    expect(readWs('f.ts')).toBe('v0');
    const undoEntry = store.listByPath('ws-A', 'f.ts').find((e) => e.toolName === 'undo');
    expect(undoEntry?.beforeHash).toBe(hashContent('v2-manual'));
    expect(undoEntry?.afterHash).toBe(hashContent('v0'));
  });

  it('分支 6：A/B 两 modify 同文件，revertEntries([A,B]) → B 先 A 后（终态 = A.before）', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-x3' });
    journaledCreate(rc, 'f.ts', 'v0');
    const a = journaledModify(rc, 'f.ts', 'v0', 'v1'); // 任务 A（旧）
    const b = journaledModify(rc, 'f.ts', 'v1', 'v2'); // 任务 B（新）
    expect(readWs('f.ts')).toBe('v2');

    const outcomes = await revertEntries('ws-A', wsDir, [a.id, b.id], { recorderCtx: undoRcOf() });

    // 执行序 = 组内 created_at 逆序：B（新）先撤，A（旧）后撤
    expect(outcomes.map((o) => o.id)).toEqual([b.id, a.id]);
    expect(outcomes[0]).toMatchObject({ result: 'reverted' });
    expect(outcomes[1]).toMatchObject({ result: 'reverted' });
    // 终态 = A.before = v0
    expect(readWs('f.ts')).toBe('v0');
  });

  it('分支 6：单撤 A（B 的变更仍在）→ skipped-diverged 拦截', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-x4' });
    journaledCreate(rc, 'f.ts', 'v0');
    const a = journaledModify(rc, 'f.ts', 'v0', 'v1');
    journaledModify(rc, 'f.ts', 'v1', 'v2'); // B 的变更留在文件上（构成 A 的漂移）

    const outcomes = await revertEntries('ws-A', wsDir, [a.id], { recorderCtx: undoRcOf() });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ id: a.id, result: 'skipped-diverged' });
    expect(readWs('f.ts')).toBe('v2'); // 文件不被乱动
  });
});

// ============================================================
// 分支 8：对称记账（撤销的撤销）+ 无 ctx 跳过
// ============================================================
describe('对称记账', () => {
  it('撤销的撤销：revert(modify) → revert(对称条目) → 文件回到 after（round trip）', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-s1' });
    journaledCreate(rc, 'f.ts', 'v0');
    const m = journaledModify(rc, 'f.ts', 'v0', 'v1');

    const first = await revertEntries('ws-A', wsDir, [m.id], { recorderCtx: undoRcOf() });
    expect(first[0]?.result).toBe('reverted');
    expect(readWs('f.ts')).toBe('v0');

    const undoEntry = store.listByPath('ws-A', 'f.ts').find((e) => e.toolName === 'undo');
    expect(undoEntry).toBeDefined();

    // 撤销的撤销：guard hash(v0)==undoEntry.after(v0) ✓ → 写回 undoEntry.before(v1)
    const second = await revertEntries('ws-A', wsDir, [undoEntry!.id], {
      recorderCtx: undoRcOf('stream-undo-undo'),
    });
    expect(second[0]).toMatchObject({ id: undoEntry!.id, result: 'reverted' });
    expect(readWs('f.ts')).toBe('v1');
    // 撤销的撤销也产生对称条目（链条可持续）
    expect(store.listByPath('ws-A', 'f.ts').filter((e) => e.toolName === 'undo')).toHaveLength(2);
  });

  it('create 撤回的撤销：revert(create) → revert(对称 delete 条目) → 文件重建', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-s2' });
    const c = journaledCreate(rc, 'born.ts', 'content');

    await revertEntries('ws-A', wsDir, [c.id], { recorderCtx: undoRcOf() });
    expect(existsWs('born.ts')).toBe(false);

    const undoEntry = store.listByPath('ws-A', 'born.ts').find((e) => e.toolName === 'undo');
    expect(undoEntry?.op).toBe('delete');

    const second = await revertEntries('ws-A', wsDir, [undoEntry!.id], { recorderCtx: undoRcOf() });
    expect(second[0]?.result).toBe('restored-missing');
    expect(readWs('born.ts')).toBe('content');
  });

  it('无 recorderCtx → 跳过对称记账（条目数不变），文件照常撤回', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-s3' });
    journaledCreate(rc, 'f.ts', 'v0');
    const m = journaledModify(rc, 'f.ts', 'v0', 'v1');

    const outcomes = await revertEntries('ws-A', wsDir, [m.id]);

    expect(outcomes[0]?.result).toBe('reverted');
    expect(readWs('f.ts')).toBe('v0');
    expect(store.listByPath('ws-A', 'f.ts')).toHaveLength(2); // 无对称条目
  });
});

// ============================================================
// 分支 9：失败传播（组内停 + 组间继续 + 写前记账落账）
// ============================================================
describe('失败传播', () => {
  it('写回阶段抛错 → failed；同 path 组内后续条目不执行；其他 path 组继续', async () => {
    // 组 'live/x.ts'：M（旧，modify）+ R（新，rename 移回 oldPath=dead/x.ts）
    const rc = ctxOf({ streamSessionId: 'stream-f1' });
    writeWs(path.join('live', 'x.ts'), 'v0');
    const m = journaledModify(rc, path.join('live', 'x.ts'), 'v0', 'v1');
    // rename 记账（工具层移动前的记账）；实际文件未移动不影响守卫（内容匹配即过）
    const r = recordChange(
      { ...rc, toolName: 'mv' },
      path.join('live', 'x.ts'),
      'rename',
      'v1',
      null,
      path.join('dead', 'x.ts'),
    );
    // 堵死移回目标：dead 是普通文件 → mkdir(dead) 抛 EEXIST（与 writeFile 同一失败传播路径）
    writeWs('dead', 'blocker');
    // 其他 path 组的条目（最新）：应正常执行，不受失败组影响
    writeWs('other.ts', 'o0');
    const other = journaledModify({ ...rc, streamSessionId: 'stream-f1' }, 'other.ts', 'o0', 'o1');

    const outcomes = await revertEntries('ws-A', wsDir, [m.id, r.id, other.id], {
      recorderCtx: undoRcOf(),
    });

    // 全局 created_at 逆序：other（最新）→ r → m（组内停）
    expect(outcomes.map((o) => o.id)).toEqual([other.id, r.id]);
    expect(outcomes[0]).toMatchObject({ id: other.id, result: 'reverted' });
    expect(readWs('other.ts')).toBe('o0');
    expect(outcomes[1]).toMatchObject({ id: r.id, result: 'failed' });
    expect(outcomes[1]?.detail).toBeTruthy();
    // 失败组现场不动：live/x.ts 仍是 v1；blocker 文件原样
    expect(readWs(path.join('live', 'x.ts'))).toBe('v1');
    expect(readWs('dead')).toBe('blocker');
    // 写前对称记账已落账（write-ahead 语义：条目先于文件变更；孤儿由 no-op 守卫兜底）
    expect(store.listByPath('ws-A', path.join('dead', 'x.ts')).some((e) => e.toolName === 'undo')).toBe(true);
  });

  it('守卫阶段读文件抛错（path 是目录 EISDIR）→ failed', async () => {
    const rc = ctxOf({ streamSessionId: 'stream-f2' });
    const c = journaledCreate(rc, 'f.ts', 'v0');
    // 记账后文件被替换成目录
    fsSync.rmSync(wsPath('f.ts'));
    fsSync.mkdirSync(wsPath('f.ts'));

    const outcomes = await revertEntries('ws-A', wsDir, [c.id], { recorderCtx: undoRcOf() });

    expect(outcomes[0]).toMatchObject({ id: c.id, result: 'failed' });
    expect(outcomes[0]?.detail).toBeTruthy();
  });
});

// ============================================================
// 边界与防御（铁律 3：错误路径与空输入专项）
// ============================================================
describe('边界与防御', () => {
  it('空 ids → 空结果（不抛错）', async () => {
    const outcomes = await revertEntries('ws-A', wsDir, [], { recorderCtx: undoRcOf() });
    expect(outcomes).toEqual([]);
  });

  it('不存在的 id → no-op + detail 如实汇报（可能已被配额清理）', async () => {
    const outcomes = await revertEntries('ws-A', wsDir, ['je_nonexistent'], {
      recorderCtx: undoRcOf(),
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ id: 'je_nonexistent', result: 'no-op' });
    expect(outcomes[0]?.detail).toContain('不存在');
  });

  it('跨 workspace 的 id → 查不到（listByIds 按 workspace 过滤）→ no-op', async () => {
    const foreign = recordChange(
      ctxOf({ workspaceId: 'ws-B' }),
      'f.ts',
      'create',
      null,
      'other workspace',
    );
    const outcomes = await revertEntries('ws-A', wsDir, [foreign.id], { recorderCtx: undoRcOf() });
    expect(outcomes[0]).toMatchObject({ id: foreign.id, result: 'no-op' });
  });

  it('before blob 缺失（脏条目指向不存在的 blob）→ failed', async () => {
    writeWs('f.ts', 'current');
    const dirty = insertDirtyEntry({
      // 守卫可通过：afterHash == hash(当前内容)；beforeHash 指向从未落盘的 blob
      path: 'f.ts',
      beforeHash: hashContent('never-journaled-content'),
      afterHash: hashContent('current'),
    });

    const outcomes = await revertEntries('ws-A', wsDir, [dirty.id], { recorderCtx: undoRcOf() });

    expect(outcomes[0]).toMatchObject({ id: dirty.id, result: 'failed' });
    expect(outcomes[0]?.detail).toBeTruthy();
    expect(readWs('f.ts')).toBe('current');
  });

  it('路径越界（../ 逃逸 workspaceDir）→ failed 不写盘', async () => {
    const evil = insertDirtyEntry({ path: path.join('..', 'outside.txt') });
    const outcomes = await revertEntries('ws-A', wsDir, [evil.id], { recorderCtx: undoRcOf() });
    expect(outcomes[0]).toMatchObject({ id: evil.id, result: 'failed' });
    expect(existsWs(path.join('..', 'outside.txt'))).toBe(false);
  });

  it('rename 条目缺 oldPath（脏数据）→ failed', async () => {
    const dirty = insertDirtyEntry({ op: 'rename', oldPath: null });
    const outcomes = await revertEntries('ws-A', wsDir, [dirty.id], { recorderCtx: undoRcOf() });
    expect(outcomes[0]).toMatchObject({ id: dirty.id, result: 'failed' });
  });

  it('未注入 store → fail-fast 抛错（防生产裸调）', async () => {
    __setJournalStoreForTest(null);
    await expect(revertEntries('ws-A', wsDir, ['je_any'])).rejects.toThrow(
      /journal store 未注入/,
    );
  });
});
