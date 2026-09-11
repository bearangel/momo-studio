// electron/tests/journal/store.test.ts
//
// journal store 测试：条目 CRUD + blob 内容寻址存储（v2.5 变更账本 Task 1）。
//
// fixture 照 tests/settings/global-defaults.test.ts：AP_USER_DATA_DIR 注入临时目录
// + runMigrations 真实建库（含 v33）——刻意不手搓 journal_entries 简化表，
// 简化 fixture 会掩盖列名/约束漂移（momo-test-rules 铁律 1）。
//
// 断言清单（task brief Step 3）：
//   1) insert + listByTask/listByStream/listByPath 各自命中与互斥（含全字段往返）
//   2) writeBlob 幂等（同 hash 二写不炸不重写——mtime 不变）
//   3) readBlob 往返；未写 hash → null
//   4) dropBlobIfUnreferenced：hash 被 3 条 entry 引用 → 不删；deleteByTaskGroup
//      后归零 → 物理删除；跨 workspace 副本独立
//   5) deleteByTaskGroup 只删目标组（taskId 匹配 + created_at < olderThan 严格
//      小于）；null taskId 组（快速会话）可整组删
//   6) sumBlobBytes 计量正确（多 hash 求和）
//   错误路径：非法 op 被 schema CHECK 拒绝且不残留
//
// hash 一律用真实 sha256（T2 hashContent 将产出同款值），id 一律 je_<uuid>。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { createJournalStore, resolveJournalDir } from '../../src/main/journal/store';
import type { JournalEntry } from '../../src/main/journal/types';

const tmpRoot = path.join(os.tmpdir(), `ap-journal-store-${Date.now()}`);

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

const sha = (content: string): string => createHash('sha256').update(content).digest('hex');

/** 生产语义构造器：id 唯一（je_<uuid>），createdAt 显式指定保证列表断言顺序确定 */
function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: `je_${randomUUID()}`,
    workspaceId: 'ws-A',
    taskId: 'T-1',
    sessionId: 'sess-1',
    streamSessionId: 'stream-1',
    toolName: 'write_file',
    path: 'src/a.ts',
    op: 'modify',
    beforeHash: null,
    afterHash: null,
    oldPath: null,
    createdAt: 1_000,
    ...overrides,
  };
}

describe('journal store：条目 CRUD', () => {
  it('insert + listByTask/listByStream/listByPath 各自命中与互斥；全字段往返', () => {
    const store = createJournalStore(getDb());
    const e1 = entry({ createdAt: 100 });
    const e2 = entry({ taskId: 'T-2', createdAt: 101 }); // 同 stream 同 path、不同任务
    const e3 = entry({ streamSessionId: 'stream-2', path: 'src/b.ts', createdAt: 102 });
    // 快速会话形态：taskId/sessionId 均空（可空列落库路径）
    const e4 = entry({
      workspaceId: 'ws-B',
      taskId: null,
      sessionId: null,
      streamSessionId: 'stream-3',
      createdAt: 103,
    });
    store.insert(e1);
    store.insert(e2);
    store.insert(e3);
    store.insert(e4);

    // toEqual 深比较 = snake↔camel 逐字段往返断言（含 null 语义）。
    // e1/e3 同任务（T-1）跨 stream/path → listByTask 双命中
    expect(store.listByTask('ws-A', 'T-1')).toEqual([e1, e3]);
    expect(store.listByTask('ws-A', 'T-2')).toEqual([e2]);
    expect(store.listByStream('ws-A', 'stream-1')).toEqual([e1, e2]);
    expect(store.listByStream('ws-B', 'stream-3')).toEqual([e4]);
    expect(store.listByPath('ws-A', 'src/a.ts')).toEqual([e1, e2]);
    expect(store.listByPath('ws-A', 'src/b.ts')).toEqual([e3]);

    // 互斥：跨 workspace / 跨任务 / 无命中
    expect(store.listByTask('ws-B', 'T-1')).toEqual([]);
    expect(store.listByTask('ws-A', 'T-404')).toEqual([]);
    expect(store.listByStream('ws-A', 'stream-404')).toEqual([]);
    expect(store.listByPath('ws-B', 'src/none.ts')).toEqual([]);

    expect(store.countAll()).toBe(4);
  });

  it('错误路径：非法 op 被 CHECK 约束拒绝，不残留', () => {
    const store = createJournalStore(getDb());
    const bad = entry();
    // 经加宽视图写入非法值（避免 any；运行时越过 TS 类型面打 CHECK）
    (bad as { op?: string }).op = 'destroy';
    expect(() => store.insert(bad)).toThrow(/CHECK constraint failed/);
    expect(store.countAll()).toBe(0);
  });

  it('deleteByTaskGroup 只删目标组（taskId 匹配 + created_at < olderThan）；null taskId 组可整组删', () => {
    const store = createJournalStore(getDb());
    const t1a = entry({ taskId: 'T-1', createdAt: 100 });
    const t1b = entry({ taskId: 'T-1', createdAt: 200 });
    const t2 = entry({ taskId: 'T-2', createdAt: 100 });
    const n1 = entry({ taskId: null, sessionId: null, createdAt: 100 });
    const n2 = entry({ taskId: null, sessionId: null, createdAt: 300 });
    const bT1 = entry({ workspaceId: 'ws-B', taskId: 'T-1', createdAt: 100 });
    for (const e of [t1a, t1b, t2, n1, n2, bT1]) store.insert(e);

    // 只删 ws-A / T-1 / created_at < 250 → t1a + t1b
    expect(store.deleteByTaskGroup('ws-A', 'T-1', 250)).toBe(2);
    expect(store.listByTask('ws-A', 'T-1')).toEqual([]);
    expect(store.countAll()).toBe(4); // t2 / n1 / n2 / bT1 均不受影响
    expect(store.listByTask('ws-A', 'T-2')).toEqual([t2]);

    // null taskId 组（快速会话）整组删
    expect(store.deleteByTaskGroup('ws-A', null, 10_000)).toBe(2);
    expect(store.countAll()).toBe(2);
    expect(store.listByTask('ws-B', 'T-1')).toEqual([bT1]);
  });

  it('deleteByTaskGroup 边界：created_at == olderThan 不删（严格 <）', () => {
    const store = createJournalStore(getDb());
    store.insert(entry({ taskId: 'T-9', createdAt: 500 }));
    expect(store.deleteByTaskGroup('ws-A', 'T-9', 500)).toBe(0);
    expect(store.deleteByTaskGroup('ws-A', 'T-9', 501)).toBe(1);
  });
});

describe('journal store：blob 内容寻址存储', () => {
  it('resolveJournalDir 布局：<userData>/journal/<ws>/objects/<hash[0:2]>/<hash>', () => {
    const hash = sha('layout');
    expect(resolveJournalDir('ws-A', hash)).toBe(
      path.join(tmpRoot, 'journal', 'ws-A', 'objects', hash.slice(0, 2), hash),
    );
  });

  it('writeBlob 幂等：同 hash 二写不炸不重写（mtime 不变）、内容不被覆盖', () => {
    const store = createJournalStore(getDb());
    const content = 'line1\nline2\n';
    const hash = sha(content);
    store.writeBlob('ws-A', hash, content);
    const file = resolveJournalDir('ws-A', hash);
    expect(fs.existsSync(file)).toBe(true);

    const before = fs.statSync(file);
    store.writeBlob('ws-A', hash, content);
    const after = fs.statSync(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(store.readBlob('ws-A', hash)).toBe(content);
  });

  it('readBlob 往返；未写 hash → null；workspace 间隔离', () => {
    const store = createJournalStore(getDb());
    const hash = sha('hello');
    expect(store.readBlob('ws-A', hash)).toBeNull();
    store.writeBlob('ws-A', hash, 'hello');
    expect(store.readBlob('ws-A', hash)).toBe('hello');
    expect(store.readBlob('ws-B', hash)).toBeNull();
  });

  it('dropBlobIfUnreferenced：有引用不删；引用归零物理删；跨 workspace 副本独立', () => {
    const store = createJournalStore(getDb());
    const h = sha('shared');
    // 3 条 entry 引用 h（before/after 混合；rename 的 before_hash 即旧内容 hash，计入）
    store.insert(entry({ beforeHash: h, createdAt: 100 }));
    store.insert(entry({ afterHash: h, createdAt: 101 }));
    store.insert(entry({ op: 'rename', beforeHash: h, oldPath: 'src/old.ts', createdAt: 102 }));
    store.writeBlob('ws-A', h, 'shared');
    // ws-B 同 hash 独立副本（blob 按 workspace 分目录 → 引用计数也按 workspace）
    store.insert(entry({ workspaceId: 'ws-B', afterHash: h, createdAt: 103 }));
    store.writeBlob('ws-B', h, 'shared');

    store.dropBlobIfUnreferenced('ws-A', h);
    expect(fs.existsSync(resolveJournalDir('ws-A', h))).toBe(true);

    // ws-A 组内引用归零 → 物理删除；ws-B 副本与其引用不受影响
    expect(store.deleteByTaskGroup('ws-A', 'T-1', 1_000)).toBe(3);
    store.dropBlobIfUnreferenced('ws-A', h);
    expect(fs.existsSync(resolveJournalDir('ws-A', h))).toBe(false);
    expect(store.readBlob('ws-B', h)).toBe('shared');

    // 从未写盘的 hash：不炸（幂等清理路径）
    expect(() => store.dropBlobIfUnreferenced('ws-A', sha('never-written'))).not.toThrow();
  });

  it('sumBlobBytes：多 hash 求和，空账本为 0', () => {
    const store = createJournalStore(getDb());
    expect(store.sumBlobBytes()).toBe(0);
    store.writeBlob('ws-A', sha('a'.repeat(10)), 'a'.repeat(10));
    store.writeBlob('ws-A', sha('b'.repeat(20)), 'b'.repeat(20));
    store.writeBlob('ws-B', sha('c'.repeat(5)), 'c'.repeat(5));
    expect(store.sumBlobBytes()).toBe(10 + 20 + 5);
  });
});
