// electron/tests/journal/recorder-binary.test.ts
//
// 账本二进制扩展（spec §6.3）：Buffer before/after 记账 → blob 字节级 round-trip。
// 关键兼容性质：hashContent(字符串) === hashContent(该字符串的 utf-8 Buffer)，
// 保证既有文本条目的撤销 hash 守卫在新代码下语义不变。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __setJournalStoreForTest,
  getJournalStore,
  hashContent,
  recordChange,
  type RecordCtx,
} from '../../src/main/journal/recorder';
import { createJournalStore } from '../../src/main/journal/store';
import { migration033 } from '../../src/main/storage/migrations/033_v2_5_change_journal';

let tmpDir: string;
let prevUserData: string | undefined;
const rc: RecordCtx = {
  workspaceId: 'ws-bin',
  taskId: null,
  sessionId: null,
  streamSessionId: 'ssn-bin',
  toolName: 'office_test',
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-journal-bin-'));
  prevUserData = process.env.AP_USER_DATA_DIR;
  process.env.AP_USER_DATA_DIR = tmpDir;
  const db = new Database(':memory:');
  db.exec(migration033.up);
  __setJournalStoreForTest(createJournalStore(db));
});

afterEach(() => {
  __setJournalStoreForTest(null);
  if (prevUserData === undefined) delete process.env.AP_USER_DATA_DIR;
  else process.env.AP_USER_DATA_DIR = prevUserData;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('hashContent string|Buffer 泛化', () => {
  it('字符串与其 utf-8 Buffer 同 hash（既有文本条目守卫兼容）', () => {
    const s = 'héllo 世界\n';
    expect(hashContent(Buffer.from(s, 'utf-8'))).toBe(hashContent(s));
  });

  it('不同字节不同 hash', () => {
    expect(hashContent(Buffer.from([0x00, 0xff, 0x10]))).not.toBe(
      hashContent(Buffer.from([0x00, 0xff, 0x11])),
    );
  });
});

describe('recordChange Buffer 记账', () => {
  it('before/after 为 Buffer：entry hash 正确', () => {
    // 模拟 zip 头 + 非 utf-8 字节序列（若按文本落盘必损坏）
    const before = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00]);
    const after = Buffer.concat([before, Buffer.from([0x01, 0x02])]);
    const entry = recordChange(rc, '报表.xlsx', 'modify', before, after);
    expect(entry.beforeHash).toBe(hashContent(before));
    expect(entry.afterHash).toBe(hashContent(after));
    expect(entry.op).toBe('modify');
  });

  it('blob 字节 round-trip：readBlobBytes 与原 Buffer equals', () => {
    const store = getJournalStore();
    expect(store).not.toBeNull();
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x80, 0x81, 0x82]);
    const entry = recordChange(rc, 'bin.xlsx', 'create', null, bytes);
    const back = store!.readBlobBytes('ws-bin', entry.afterHash!);
    expect(back).not.toBeNull();
    expect(back!.equals(bytes)).toBe(true);
  });

  it('文本 blob 既有语义不回归：readBlob 返回 utf-8 字符串', () => {
    const store = getJournalStore()!;
    const entry = recordChange(rc, 'a.ts', 'create', null, 'const x = 1;');
    expect(store.readBlob('ws-bin', entry.afterHash!)).toBe('const x = 1;');
    expect(store.readBlobBytes('ws-bin', entry.afterHash!)!.toString('utf-8')).toBe('const x = 1;');
  });
});
