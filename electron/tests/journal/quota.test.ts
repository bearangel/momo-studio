// electron/tests/journal/quota.test.ts
//
// journal 配额滚动清理测试（v2.5 变更账本 Task 6）。
//
// fixture 照 tests/journal/store.test.ts：AP_USER_DATA_DIR 注入临时目录 +
// runMigrations 真实建库 + __setJournalStoreForTest 注入真实 store——配额计量
// 走真实磁盘 walk、引用计数走真实 SQL，mock 会掩盖 per-workspace 计量与
// blob 物理删除断言（momo-test-rules 铁律 1 + 5）。
//
// 断言清单（task brief Step 1）：
//   1) 未超配额零删除（purgedGroups/freedBytes 双零 + 条目完整）
//   2) 注入配额 1KB + 新旧两组 → 只删最旧组（整组删 + blob 物理删）
//   3) 删到满足为止：连环删两组、最新组保留
//   4) per-workspace 计量（T1 review 裁定）：ws-B 字节不计入 ws-A 配额；
//      enforce('ws-A') 不动 ws-B 的条目与 blob
//   5) 30 天硬上限独立触发（now 注入）；活跃组（组内最新条目仍在窗口内）不删
//   6) 快速会话段：taskId null 按 streamSessionId 分段，只删终态老段
//   7) 共享 blob 引用计数：另一组仍引用 → 条目删但 blob 物理保留；归零后物理删
//   8) maybeEnforceQuota 节流：49 次记账不触发，第 50 次触发滚动清理
//   9) 错误路径：store 未注入 enforceQuota fail-fast 抛错 / maybeEnforceQuota
//      静默跳过；设置损坏（非法 JSON）时清理失败只 warn 不阻塞记账
//
// 配额注入走真实设置路径：updateGlobalSettings({ journalQuotaMb: 1/1024 })
// = 1KB（MB 按 1024² 换算，与 audit quota 先例一致）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { createJournalStore, resolveJournalDir } from '../../src/main/journal/store';
import type { JournalStore } from '../../src/main/journal/store';
import { updateGlobalSettings } from '../../src/main/settings/crud';
import {
  enforceQuota,
  maybeEnforceQuota,
  __resetQuotaCounterForTest,
} from '../../src/main/journal/quota';
import { recordChange, __setJournalStoreForTest } from '../../src/main/journal/recorder';
import type { JournalEntry } from '../../src/main/journal/types';

const tmpRoot = path.join(os.tmpdir(), `ap-journal-quota-${process.pid}-${Date.now()}`);
let store: JournalStore;

/** 固定时间源：30 天窗口断言确定性（2026-10-17 附近任取） */
const NOW = 1_760_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const d31 = NOW - 31 * DAY_MS;
const d1 = NOW - 1 * DAY_MS;

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  store = createJournalStore(getDb());
  __setJournalStoreForTest(store);
  __resetQuotaCounterForTest();
});

afterEach(() => {
  __setJournalStoreForTest(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

const sha = (content: string): string => createHash('sha256').update(content).digest('hex');

/** 生产语义构造器（照 store.test.ts：id 唯一、createdAt 显式、全字段可覆盖） */
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

/** 种子一组 create 条目（每条独立 blob），返回 (hash, bytes) 对 */
function seedGroup(
  ws: string,
  taskId: string | null,
  createdAtBase: number,
  sizes: number[],
  overrides: Partial<JournalEntry> = {},
): Array<{ hash: string; bytes: number }> {
  const out: Array<{ hash: string; bytes: number }> = [];
  sizes.forEach((size, i) => {
    const content = `${taskId ?? 'null'}-${createdAtBase}-${i}-`.padEnd(size, 'x');
    const hash = sha(content);
    store.insert(
      entry({
        workspaceId: ws,
        taskId,
        sessionId: taskId === null ? null : 'sess-1',
        streamSessionId: overrides.streamSessionId ?? `stream-${taskId ?? 'null'}-${createdAtBase}`,
        op: 'create',
        afterHash: hash,
        createdAt: createdAtBase + i,
        ...overrides,
      }),
    );
    store.writeBlob(ws, hash, content);
    out.push({ hash, bytes: Buffer.byteLength(content) });
  });
  return out;
}

describe('journal 配额滚动清理：配额条件', () => {
  // 配额用例统一注入 now + NOW 相对时间戳：与 30 天硬上限条件隔离
  // （小值 createdAt 会被真实时钟判为 56 年前的终态老组而误触发条件一）
  const tOld = NOW - 2 * 3600_000;
  const tMid = NOW - 1_5000_000;
  const tNew = NOW - 1 * 3600_000;
  const now = (): number => NOW;

  it('未超配额零删除：默认 200MB 下条目与 blob 完整保留', () => {
    const seeded = seedGroup('ws-A', 'T-1', tNew, [300, 300]);
    const r = enforceQuota('ws-A', { now });
    expect(r).toEqual({ purgedGroups: 0, freedBytes: 0 });
    expect(store.countAll()).toBe(2);
    for (const { hash } of seeded) {
      expect(fs.existsSync(resolveJournalDir('ws-A', hash))).toBe(true);
    }
  });

  it('注入配额 1KB + 新旧两组 → 只删最旧组（整组删 + blob 物理删 + 计数正确）', () => {
    const oldBlobs = seedGroup('ws-A', 'T-old', tOld, [300, 300]);
    const newBlobs = seedGroup('ws-A', 'T-new', tNew, [300, 300]);
    updateGlobalSettings({ journalQuotaMb: 1 / 1024 }); // 1KB

    const r = enforceQuota('ws-A', { now });
    // 1200B > 1024B → 删 T-old（600B）后 600 ≤ 1024 停
    expect(r).toEqual({ purgedGroups: 1, freedBytes: 600 });
    expect(store.listByTask('ws-A', 'T-old')).toEqual([]);
    expect(store.listByTask('ws-A', 'T-new').length).toBe(2);
    for (const { hash } of oldBlobs) {
      expect(fs.existsSync(resolveJournalDir('ws-A', hash))).toBe(false);
    }
    for (const { hash } of newBlobs) {
      expect(fs.existsSync(resolveJournalDir('ws-A', hash))).toBe(true);
    }
  });

  it('删到满足为止：三组连环删两组、最新组保留', () => {
    seedGroup('ws-A', 'T-a', tOld, [600]);
    seedGroup('ws-A', 'T-b', tMid, [600]);
    seedGroup('ws-A', 'T-c', tNew, [600]);
    updateGlobalSettings({ journalQuotaMb: 1 / 1024 });

    // 1800 > 1024 → 删 T-a（余 1200 仍超）→ 删 T-b（余 600 ≤ 1024 停）
    const r = enforceQuota('ws-A', { now });
    expect(r).toEqual({ purgedGroups: 2, freedBytes: 1200 });
    expect(store.listByTask('ws-A', 'T-a')).toEqual([]);
    expect(store.listByTask('ws-A', 'T-b')).toEqual([]);
    expect(store.listByTask('ws-A', 'T-c').length).toBe(1);
  });

  it('per-workspace 计量（T1 review 裁定）：ws-B 字节不计入 ws-A 配额，ws-B 条目与 blob 不受 enforce("ws-A") 影响', () => {
    // 阶段一：ws-A 800B ≤ 1KB，ws-B 600B——若误用全局和（1400 > 1024）会误删
    seedGroup('ws-A', 'T-new', tNew, [400, 400]);
    const bBlobs = seedGroup('ws-B', 'T-b1', tOld, [600]);
    updateGlobalSettings({ journalQuotaMb: 1 / 1024 });
    expect(enforceQuota('ws-A', { now })).toEqual({ purgedGroups: 0, freedBytes: 0 });
    expect(store.countAll()).toBe(3);

    // 阶段二：ws-A 涨到 1400B > 1KB → 只清 ws-A 最旧组；ws-B 完整保留
    seedGroup('ws-A', 'T-old', tOld - 1, [600]);
    const r = enforceQuota('ws-A', { now });
    expect(r).toEqual({ purgedGroups: 1, freedBytes: 600 });
    expect(store.listByTask('ws-A', 'T-old')).toEqual([]);
    expect(store.listByTask('ws-B', 'T-b1').length).toBe(1);
    for (const { hash } of bBlobs) {
      expect(fs.existsSync(resolveJournalDir('ws-B', hash))).toBe(true);
    }
  });
});

describe('journal 配额滚动清理：30 天硬上限', () => {
  it('终态老组独立触发（now 注入）：无关配额删除 + blob 物理删', () => {
    const oldBlobs = seedGroup('ws-A', 'T-old', d31, [300, 300]);
    seedGroup('ws-A', 'T-new', d1, [300, 300]);

    const r = enforceQuota('ws-A', { now: () => NOW });
    expect(r).toEqual({ purgedGroups: 1, freedBytes: 600 });
    expect(store.listByTask('ws-A', 'T-old')).toEqual([]);
    expect(store.listByTask('ws-A', 'T-new').length).toBe(2);
    for (const { hash } of oldBlobs) {
      expect(fs.existsSync(resolveJournalDir('ws-A', hash))).toBe(false);
    }
  });

  it('活跃组保护：组内最新条目仍在窗口内（仅最旧条目过窗）不删', () => {
    // T-span 从 40 天前横跨到 1 天前——min 过窗但 max 在窗内 = 活跃组
    seedGroup('ws-A', 'T-span', NOW - 40 * DAY_MS, [300]);
    seedGroup('ws-A', 'T-span', d1, [300]);

    const r = enforceQuota('ws-A', { now: () => NOW });
    expect(r).toEqual({ purgedGroups: 0, freedBytes: 0 });
    expect(store.listByTask('ws-A', 'T-span').length).toBe(2);
  });

  it('快速会话段：taskId null 按 streamSessionId 分段，只删终态老段', () => {
    seedGroup('ws-A', null, d31, [300], { streamSessionId: 'stream-old' });
    seedGroup('ws-A', null, d1, [300], { streamSessionId: 'stream-new' });

    const r = enforceQuota('ws-A', { now: () => NOW });
    expect(r).toEqual({ purgedGroups: 1, freedBytes: 300 });
    expect(store.listByStream('ws-A', 'stream-old')).toEqual([]);
    expect(store.listByStream('ws-A', 'stream-new').length).toBe(1);
  });
});

describe('journal 配额滚动清理：共享 blob 引用计数', () => {
  it('另一组仍引用 → 条目删但 blob 物理保留；引用归零后（二次清理）物理删', () => {
    // h 由 T-old.after 与 T-new.before 共享（modify 链：旧组产出 = 新组输入）
    const shared = 's'.repeat(500);
    const h = sha(shared);
    const oldOnly = 'o'.repeat(300);
    store.insert(
      entry({
        taskId: 'T-old',
        op: 'create',
        afterHash: h,
        createdAt: d31,
      }),
    );
    store.insert(
      entry({
        taskId: 'T-old',
        path: 'src/b.ts',
        op: 'create',
        afterHash: sha(oldOnly),
        createdAt: d31 + 1,
      }),
    );
    store.writeBlob('ws-A', h, shared);
    store.writeBlob('ws-A', sha(oldOnly), oldOnly);
    store.insert(
      entry({
        taskId: 'T-new',
        op: 'modify',
        beforeHash: h,
        afterHash: sha('n'.repeat(200)),
        createdAt: d1,
      }),
    );
    store.writeBlob('ws-A', sha('n'.repeat(200)), 'n'.repeat(200));

    // 第一次：删 T-old——h 仍被 T-new 引用 → 物理保留；仅独占 blob 释放
    const r1 = enforceQuota('ws-A', { now: () => NOW });
    expect(r1).toEqual({ purgedGroups: 1, freedBytes: 300 });
    expect(fs.existsSync(resolveJournalDir('ws-A', h))).toBe(true);
    expect(store.readBlob('ws-A', h)).toBe(shared);

    // 第二次：时间推到 40 天后，T-new 也过窗 → 引用归零，h 物理删除
    const r2 = enforceQuota('ws-A', { now: () => NOW + 40 * DAY_MS });
    expect(r2).toEqual({ purgedGroups: 1, freedBytes: 700 });
    expect(fs.existsSync(resolveJournalDir('ws-A', h))).toBe(false);
    expect(store.countAll()).toBe(0);
  });
});

describe('maybeEnforceQuota 节流触发', () => {
  it('49 次记账不触发；第 50 次触发滚动清理（1KB 配额下删最旧任务组）', () => {
    updateGlobalSettings({ journalQuotaMb: 1 / 1024 });
    const contentOf = (i: number): string => String(i).padStart(24, 'c'); // 24B/条
    // 50 条 × 24B = 1200B > 1KB；前 25 条 T-a、后 25 条 T-b
    for (let i = 0; i < 50; i++) {
      recordChange(
        {
          workspaceId: 'ws-A',
          taskId: i < 25 ? 'T-a' : 'T-b',
          sessionId: 'sess-1',
          streamSessionId: `stream-${i}`,
          toolName: 'write_file',
        },
        `src/f${i}.ts`,
        'create',
        null,
        contentOf(i),
      );
      if (i === 48) {
        // 第 49 次（0 基 48）：计数 49 未到 50，零清理
        expect(store.countAll()).toBe(49);
      }
    }
    // 第 50 次记账触发 enforce：删 T-a（600B）后 600 ≤ 1024 停，T-b 完整
    expect(store.countAll()).toBe(25);
    expect(store.listByTask('ws-A', 'T-a')).toEqual([]);
    expect(store.listByTask('ws-A', 'T-b').length).toBe(25);
    expect(fs.existsSync(resolveJournalDir('ws-A', sha(contentOf(0))))).toBe(false);
    expect(fs.existsSync(resolveJournalDir('ws-A', sha(contentOf(49))))).toBe(true);
  });
});

describe('错误路径（momo-test-rules 铁律 3）', () => {
  it('store 未注入：enforceQuota fail-fast 抛错（与 detector/revert 同契约）；maybeEnforceQuota 静默跳过', () => {
    __setJournalStoreForTest(null);
    expect(() => enforceQuota('ws-A')).toThrow(/未注入/);
    expect(() => maybeEnforceQuota('ws-A')).not.toThrow();
  });

  it('设置损坏（非法 JSON）时清理失败只 warn 不抛——记账路径不被清理故障阻塞', () => {
    seedGroup('ws-A', 'T-1', 1_000, [300]);
    updateGlobalSettings({ journalQuotaMb: 1 / 1024 });
    // 破坏 kv_store JSON：getGlobalSettings 解析抛错 → enforceQuota 内部抛 → 被 maybe 吞
    getDb().prepare("UPDATE kv_store SET value = '{' WHERE key = 'global_settings'").run();
    expect(() => {
      for (let i = 0; i < 50; i++) maybeEnforceQuota('ws-A');
    }).not.toThrow();
    expect(store.countAll()).toBe(1);
  });
});
